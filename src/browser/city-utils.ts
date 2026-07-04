// ============================================================
// city-utils — GREEN
// ============================================================
// P2 #15 实测发现 BOSS 直聘 API 忽略 city 请求参数，
// 按账户 profile 锁定城市（详见 docs/adr/0003-boss-api-city-locking.md）
//
// 这个文件做 2 件事：
//   1. normalizeCity: 模糊匹配 - 用户写"北京"和 BOSS 给"北京市"算同一个
//   2. detectCityMismatch: 检测是否需要警告
//
// 设计动机：抽到独立 helper 是为了：
//   - 单一职责：city 相关逻辑一处维护
//   - 可复用：未来 DOM fallback 模式可共享
//   - 易测：不依赖 searchJobs 全链路
// ============================================================

export interface CityReportableJob {
  cityName?: string
}

/**
 * 模糊匹配：Boss 直聘和用户输入城市的等价化
 *
 * 规则（简化版）：
 *   1. 去掉前后空格
 *   2. 全部小写
 *   3. 去掉末尾"省"或"市"（不同人写法不同：北京市 / 北京）
 *
 * 区/县 不去 — 视为不同城市（保持精确匹配）
 */
export function normalizeCity(s: string): string {
  return s.replace(/[省市]$/, '').trim().toLowerCase()
}

/**
 * 检测用户传的 --city 与 BOSS API 实际返回的城市是否一致。
 *
 * 返回 null 表示一致（无需警告），
 * 返回警告字符串表示不一致（CLI 应打印）。
 *
 * 警告文案（用户已审阅）：
 *   [boss-city-mismatch] --city "北京" 被 BOSS 忽略。实际返回 12 条岗位
 *   全部位于 "杭州"。如需跨城，请先在 BOSS 直聘页面顶部切换到目标城市，
 *   然后重启 Chrome CDP 会话（bapply chrome重新连接）。
 *
 * 边界：
 *   - jobs 为空 → null（无数据可比）
 *   - 所有 job 都没 cityName → null（无 city 信息可比）
 *   - 部分有 cityName，部分没有 → 用有 cityName 的部分判断（这反映"实际可见"的 city）
 */
export function detectCityMismatch(
  requested: string,
  jobs: CityReportableJob[],
): string | null {
  if (jobs.length === 0) return null

  // 提取所有非空 cityName
  const cityNames = jobs
    .map((j) => j.cityName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)

  if (cityNames.length === 0) return null

  const normalizedRequested = normalizeCity(requested)

  // 所有 cityName normalize 后都匹配 requestedCity → 一致
  const allMatch = cityNames.every(
    (name) => normalizeCity(name) === normalizedRequested,
  )
  if (allMatch) return null

  // 收集实际城市集合（保持可读形式）
  const actualCities = Array.from(new Set(cityNames))
  const cityList =
    actualCities.length === 1
      ? `"${actualCities[0]}"`
      : actualCities.map((c) => `"${c}"`).join(' / ')

  return (
    `[boss-city-mismatch] --city "${requested}" 被 BOSS 忽略。` +
    `实际返回 ${jobs.length} 条岗位全部位于 ${cityList}。` +
    `如需跨城，请先在 BOSS 直聘页面顶部切换到目标城市，` +
    `然后重启 Chrome CDP 会话（bapply chrome重新连接）。`
  )
}
