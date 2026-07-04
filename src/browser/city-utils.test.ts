// ============================================================
// city-utils — TDD RED
// ============================================================
// P2 #15 实测发现 BOSS 直聘 API 忽略 city 请求参数，
// 按账户 profile 锁定城市（详见 docs/adr/0003-boss-api-city-locking.md）
//
// 抽 helper 而不是直接 inline 在 searchJobs 是为了：
//   - 单一职责：normalizeCity + detectCityMismatch 一个文件易测
//   - 可复用：未来 DOM fallback 模式也能复用
//   - 内聚：city 相关逻辑不污染 index.ts
// ============================================================

import { describe, it, expect } from 'vitest'
import { normalizeCity, detectCityMismatch, type CityReportableJob } from './city-utils.js'

// ============================================================
// normalizeCity：模糊匹配核心
// ============================================================

describe('normalizeCity', () => {
  it('removes trailing 市', () => {
    expect(normalizeCity('北京市')).toBe('北京')
  })

  it('removes trailing 省', () => {
    expect(normalizeCity('浙江省')).toBe('浙江')
  })

  it('lowercases the result', () => {
    expect(normalizeCity('北京')).toBe('北京') // 已是小写等价
    // 因为 API 返回可能用 "BeiJing"，但实测都是中文。测试基础情况
    expect(normalizeCity('Hangzhou')).toBe('hangzhou')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeCity('  北京  ')).toBe('北京')
  })

  it('keeps 区 suffix (行政区粒度细分)', () => {
    // 我们的简化规则只去 "市" "省" 这两级
    // 区/县 视为不同城市（保持精确匹配）
    expect(normalizeCity('海淀区')).toBe('海淀区')
  })

  it('handles multi-char city names like 哈尔滨', () => {
    expect(normalizeCity('哈尔滨市')).toBe('哈尔滨')
  })
})

// ============================================================
// detectCityMismatch：是否需要警告
// ============================================================

describe('detectCityMismatch', () => {
  it('returns null when jobs array is empty', () => {
    expect(detectCityMismatch('北京', [])).toBeNull()
  })

  it('returns null when all jobs match requested city exactly', () => {
    const jobs: CityReportableJob[] = [{ cityName: '杭州' }, { cityName: '杭州' }]
    expect(detectCityMismatch('杭州', jobs)).toBeNull()
  })

  it('returns null when normalize-equivalent: 北京 ↔ 北京市', () => {
    const jobs: CityReportableJob[] = [{ cityName: '北京市' }, { cityName: '北京市' }]
    expect(detectCityMismatch('北京', jobs)).toBeNull()
  })

  it('returns null when normalize-equivalent: 北京市 ↔ 北京 (reverse)', () => {
    const jobs: CityReportableJob[] = [{ cityName: '北京' }, { cityName: '北京' }]
    expect(detectCityMismatch('北京市', jobs)).toBeNull()
  })

  it('returns null when normalize-equivalent: 浙江省 ↔ 浙江', () => {
    const jobs: CityReportableJob[] = [{ cityName: '浙江省' }]
    expect(detectCityMismatch('浙江', jobs)).toBeNull()
  })

  it('returns warning string when requested city is ignored and all jobs are in another city', () => {
    const jobs: CityReportableJob[] = [
      { cityName: '杭州' },
      { cityName: '杭州' },
      { cityName: '杭州' },
    ]
    const warning = detectCityMismatch('北京', jobs)
    expect(warning).not.toBeNull()
    expect(warning).toContain('--city "北京"')
    expect(warning).toContain('3 条岗位')
    expect(warning).toContain('"杭州"')
    expect(warning).toContain('[boss-city-mismatch]')
    expect(warning).toContain('重启 Chrome CDP 会话')
  })

  it('returns warning even with 0-job mismatch (1 job but in wrong city)', () => {
    const jobs: CityReportableJob[] = [{ cityName: '杭州' }]
    expect(detectCityMismatch('北京', jobs)).not.toBeNull()
  })

  it('handles jobs with missing/empty cityName by ignoring them for mismatch detection', () => {
    const jobs: CityReportableJob[] = [
      { cityName: '杭州' },
      { cityName: '' },
      {},
    ]
    // 至少有一条带 cityName 的杭州 → 所有带 cityName 的都不是北京
    // 但混合（没有 cityName）的不能算"全部位于杭州"
    // 实现选择：只看有 cityName 的做判断
    expect(detectCityMismatch('北京', jobs)).not.toBeNull()
  })

  it('returns null when no jobs have cityName (all missing)', () => {
    const jobs: CityReportableJob[] = [{ cityName: '' }, {}]
    // 没有可比的城市信息 → 不警告
    expect(detectCityMismatch('北京', jobs)).toBeNull()
  })

  it('uses /-joined list when actual cities span multiple cities', () => {
    const jobs: CityReportableJob[] = [
      { cityName: '杭州' },
      { cityName: '上海' },
    ]
    const warning = detectCityMismatch('北京', jobs)
    expect(warning).not.toBeNull()
    expect(warning).toContain('"杭州"')
    expect(warning).toContain('"上海"')
    expect(warning).toContain(' / ')
  })

  it('warning message ends with explicit user-action instruction', () => {
    const jobs: CityReportableJob[] = [{ cityName: '杭州' }]
    const warning = detectCityMismatch('北京', jobs)
    // 文案结构：开头 [boss-city-mismatch] → 解释 → 末尾"如需跨城...重启 Chrome CDP 会话（bapply chrome重新连接）"
    expect(warning).toMatch(/如需跨城.+重新连接/)
  })
})
