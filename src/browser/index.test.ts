// ============================================================
// src/browser/index.ts TDD
// ============================================================
// P1 guard backlog #7: sendGreeting 的内层 try/catch 把 GuardError
// 吞掉返回 false，CLI 用户看不到风控决策原因。
//
// 修复方案：try/catch 应该 catch 业务错误并返回 false，
// 但 instanceof GuardError 时 rethrow，让决策透明给调用方。
//
// 关键设计：测试要让 page.goto 在 fn 内部抛 GuardError（绕过
// withGuard probe 阶段），验证 sendGreeting 不应吞这个 GuardError。
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { sendGreeting, fetchJobDetail, extractHrUid, searchJobs } from './index.js'
import { GuardError, type GuardDecision } from './guard.js'

// ------------------------------------------------------------
// helper：构造 mock page（probe 不命中，所有 selector 返 null）
// ------------------------------------------------------------
function makeMockPage() {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    // Sprint 2E：fetchJobDetail 改用 waitForFunction 防御懒加载
    // 老测试需要这个 mock 默认 resolve（不触发超时）
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    $eval: vi.fn().mockResolvedValue(''),
    $: vi.fn().mockResolvedValue(null), // probe 不命中任何 selector
    click: vi.fn().mockResolvedValue(undefined),
    // wapi 调用默认返 ok=false（postDescription 缺失），触发降级到 page.goto
    // Sprint 2026-07-12：fetchJobDetailViaWapi 改读 zpData.jobCard.postDescription
    evaluate: vi.fn().mockResolvedValue({ ok: false, error: 'postDescription 字段缺失或为空' }),
    mouse: { move: vi.fn().mockResolvedValue(undefined) },
    focus: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
  }
}

const FAST_TYPE_OPTS = {
  minDelayMs: 1,
  maxDelayMs: 2,
  typoRate: 0,
  pauseChance: 0,
}

// ============================================================
// sendGreeting × GuardError（Sprint 2A：适配新签名 + friend/add）
// ============================================================
//
// Sprint 2A 重构后：
//   - 签名: (page, jobId, hrId, message) → Promise<SendGreetingResult>
//   - 实现: page.evaluate(fetch friend/add)，不再 page.goto/typeText
//   - 返回: {action: 'sent'|'failed'|'rate_limited'|'security_blocked', ...}
//   - GuardError 仍透传（让 send-handler.ts 看到 abort_today / abort 决策）
// ============================================================

describe('sendGreeting × GuardError', () => {
  it('业务错误（page.evaluate 抛 PageError）：catches and returns {action:"failed"}', async () => {
    const page = makeMockPage()
    // Sprint 2A: page.evaluate 是 friend/add 的出口，模拟它抛业务错误
    page.evaluate = vi.fn().mockRejectedValue(new Error('navigation timeout'))

    const result = await sendGreeting(page as any, 'JOB123', 'HR456', 'hello')
    expect(result.action).toBe('failed')
    expect(result.error).toMatch(/navigation timeout/)
  })

  it('GuardError 来自 fn 内（page.evaluate 阶段）：必须 throw（不被吞）', async () => {
    // 关键：把 GuardError 抛在 fn 内（page.evaluate 阶段），绕过 withGuard probe
    // 当前实现（已修复）：catch 内 instanceof GuardError 应该 rethrow
    const decision: GuardDecision = {
      action: 'abort_today',
      reason: '登录已失效',
      signal: {
        type: 'login_expired',
        confidence: 1,
        rawSelector: '.session-timeout-modal',
        detectedAt: new Date(),
      },
    }
    const page = makeMockPage()
    page.evaluate = vi.fn().mockImplementation(async () => {
      throw new GuardError(decision)
    })

    await expect(
      sendGreeting(page as any, 'JOB123', 'lid_test', 'security_id_test'),
    ).rejects.toBeInstanceOf(GuardError)
  })

  it('正常路径：BOSS code=0 → action="sent"，friendId 解析为 encBossId', async () => {
    const page = makeMockPage()
    // Sprint 2026-07-14 / task #41 / ADR-0007 P3：page.evaluate 返 BOSS friend/add 响应
    //   字段名按探针 P3 raw.zpData 实测：encBossId（不是 friendId）
    page.evaluate = vi.fn().mockResolvedValue({
      code: 0,
      message: 'Success',
      zpData: {
        encBossId: 'friend_xyz',
        greeting: '...',
      },
    })

    const result = await sendGreeting(page as any, 'JOB123', 'lid_test', 'security_id_test')
    expect(result.action).toBe('sent')
    expect(result.friendId).toBe('friend_xyz')
  })
})

// ============================================================
// fetchJobDetail — fallback selector 链（2026-07-07 修 P0）
// ============================================================
// 行为契约：
//   - 构造正确的 BOSS 岗位 URL（https://www.zhipin.com/job_detail/{jobId}.html）
//   - 优先尝试主选择器（.job-sec-text），失败时按顺序试 fallback
//   - 每个选择器独立超时（不串行等待）
//   - 返回首个非空文本
//   - 所有选择器都失败 → 抛带 URL + 尝试列表的详细错误
//
// 为什么需要 fallback：
//   BOSS 前端 HTML 经常改 class 名，硬编码单一选择器 100% 会挂
//   （2026-07-07 dry-run 暴露：.job-sec-text 失效）
// ============================================================

describe('fetchJobDetail — fallback selector 链', () => {
  // Sprint 2E：老 selector 链测试用 MIN_JD_LENGTH=0 跑（聚焦 selector 逻辑，不被长度校验干扰）
  // 懒加载长度校验单独由 Sprint 2E-A/B/C 覆盖
  const OLD_BEHAVIOR_OPTS = { throttleMs: 0, minJdLength: 0 } as any

  it('主选择器命中：返回 .job-sec-text 的文本', async () => {
    const page = makeMockPage()
    page.waitForSelector = vi.fn().mockResolvedValue(undefined)
    page.$eval = vi.fn().mockResolvedValue('主选择器拿到的 JD')

    const jd = await fetchJobDetail(page as any, 'JOB123', OLD_BEHAVIOR_OPTS)

    expect(jd).toBe('主选择器拿到的 JD')
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.zhipin.com/job_detail/JOB123.html',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
  })

  it('🚨 关键：主选择器超时，fallback 选择器命中 → 返回 fallback 文本', async () => {
    const page = makeMockPage()
    page.waitForFunction = vi
      .fn()
      .mockRejectedValueOnce(new Error('waitForFunction timeout'))
      .mockResolvedValueOnce(undefined)
    page.$eval = vi.fn().mockImplementation(async (selector: string) => {
      if (selector === '.job-sec-text') throw new Error('主选择器拿不到')
      return 'fallback 拿到的 JD 内容'
    })

    const jd = await fetchJobDetail(page as any, 'JOB456', OLD_BEHAVIOR_OPTS)

    expect(jd).toBe('fallback 拿到的 JD 内容')
  })

  it('主选择器返空文本时，继续尝试 fallback（不返空串当成功）', async () => {
    const page = makeMockPage()
    page.waitForSelector = vi.fn().mockResolvedValue(undefined)
    // 主选择器命中但内容为空，fallback 命中且有内容
    page.$eval = vi.fn().mockImplementation(async (selector: string) => {
      if (selector === '.job-sec-text') return ''
      return '真正有内容的 JD'
    })

    const jd = await fetchJobDetail(page as any, 'JOB789', OLD_BEHAVIOR_OPTS)

    expect(jd).toBe('真正有内容的 JD')
  })

  it('🚨 所有选择器都失败：抛带 URL + 尝试列表的详细错误', async () => {
    const page = makeMockPage()
    // Sprint 2E 决策 3：body 骨架检查单独 resolve（不干扰"所有 selector 都失败"的本意）
    page.waitForSelector = vi.fn().mockImplementation(async (sel: string) => {
      if (sel === 'body') return undefined
      throw new Error('Timeout')
    })
    page.$eval = vi.fn().mockRejectedValue(new Error('not found'))

    // 传 throttleMs: 0 跳过限速 sleep（生产 3000ms 限速是为了反爬）
    await expect(fetchJobDetail(page as any, 'BAD_JOB', OLD_BEHAVIOR_OPTS)).rejects.toThrow(
      /job_detail\/BAD_JOB\.html/,
    )
    // 验证错误消息包含尝试过的选择器列表（让用户能立刻定位是哪个 selector 失效）
    await expect(fetchJobDetail(page as any, 'BAD_JOB', OLD_BEHAVIOR_OPTS)).rejects.toThrow(
      /\.job-sec-text.*job-detail-section/s,
    )
  })

  it('page.goto 抛错（无网络/404）：直接抛错，不尝试任何选择器', async () => {
    const page = makeMockPage()
    page.goto = vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'))

    await expect(fetchJobDetail(page as any, 'X', OLD_BEHAVIOR_OPTS)).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/)
    expect(page.waitForSelector).not.toHaveBeenCalled()
  })
})

// ============================================================
// Sprint 2B: extractHrUid 单元测试
// ------------------------------------------------------------
// 验证 BOSS API 字段名 fallback chain 行为
// （避免 searchJobs 整函数 mock 复杂性）
// ============================================================

describe('extractHrUid (Sprint 2B — probe 验证后修正)', () => {
  it('TEST 1: 优先取 encryptBossId（probe 验证的 BOSS 真实字段名）', () => {
    expect(extractHrUid({ encryptBossId: 'hr_main' })).toBe('hr_main')
  })

  it('TEST 2: fallback 到 encryptedBossId', () => {
    expect(extractHrUid({ encryptedBossId: 'hr_alt1' })).toBe('hr_alt1')
  })

  it('TEST 3: fallback 到 hrEncryptId', () => {
    expect(extractHrUid({ hrEncryptId: 'hr_alt2' })).toBe('hr_alt2')
  })

  it('TEST 4: 都缺返 undefined（缺 hrUid 不阻塞 search-and-write）', () => {
    expect(extractHrUid({ encryptJobId: 'job_xxx' })).toBeUndefined()
  })

  it('TEST 5: job 本身是 undefined/null → undefined（不抛）', () => {
    expect(extractHrUid(undefined)).toBeUndefined()
    expect(extractHrUid(null)).toBeUndefined()
  })

  it('TEST 6: 多个字段都有时取优先级最高的（encryptBossId 优先）', () => {
    expect(extractHrUid({
      encryptBossId: 'hr_main',
      encryptedBossId: 'hr_alt1',
      hrEncryptId: 'hr_alt2',
    })).toBe('hr_main')
  })

  it('TEST 7 (回归防护): 旧推断字段名 encryptUserId 不再被识别', () => {
    // 防止有人把 fallback chain 加回 encryptUserId（probe 已证明不存在）
    expect(extractHrUid({ encryptUserId: 'hr_wrong' })).toBeUndefined()
  })
})

// ============================================================
// searchJobs Phase 1 跳过逻辑（Sprint 2D — 真实环境暴露）
// ------------------------------------------------------------
// 真实环境 bug（2026-07-09 连续跑 bapply search Java后端 --cdp 触发）：
//   searchJobs Phase 1 永远 page.goto /web/geek/recommend
//   第一次跑：Chrome 在 about:blank → goto OK
//   第二次跑：Chrome 还在前一次留下的 /web/geek/jobs?query=Java后端 页
//             → BOSS SPA 检测同源 redirect → 中断 Playwright goto
//             → page.goto throws "Navigation interrupted by another navigation"
//
// 修复：Phase 1 先查 page.url()，若已在 BOSS geek 域（/web/geek/*）则跳过 goto
// ============================================================

describe('searchJobs — Phase 1 跳过逻辑（Sprint 2D）', () => {
  function makeSearchPage(currentUrl = 'about:blank') {
    return {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue(currentUrl),
      // Sprint 2D: 让 evaluate 返 BOSS API 成功（非空 jobList）→ 避免走 DOM 降级
      // DOM 降级会再调 page.goto，干扰 Sprint 2D 测的"Phase 1 goto 次数"
      evaluate: vi.fn().mockResolvedValue({
        code: 0,
        zpData: { jobList: [{ encryptJobId: 'fake', jobName: 'fake', brandName: 'fake' }] },
      }),
    }
  }

  it('Sprint 2D-1: page 在 BOSS geek 域（/web/geek/recommend）→ 跳过 Phase 1 goto', async () => {
    const page = makeSearchPage('https://www.zhipin.com/web/geek/recommend')
    try {
      await searchJobs(page as any, '前端')
    } catch {
      // evaluate 失败会让 searchJobs 抛错（但我们要验证 goto 没被调）
    }
    // 🚨 关键：page.goto 不应被调（避免 BOSS SPA navigation race）
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('Sprint 2D-2: page 在 BOSS jobs 域（/web/geek/jobs?query=X）→ 跳过 Phase 1 goto', async () => {
    // 真实场景：前一次 search 留下 URL
    const page = makeSearchPage('https://www.zhipin.com/web/geek/jobs?query=Java%E5%90%8E%E7%AB%AF')
    try {
      await searchJobs(page as any, 'Java后端')
    } catch {
      // 同上
    }
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('Sprint 2D-3: page 在 job_detail 域（/job_detail/X.html）→ 跳过 Phase 1 goto（也是 BOSS）', async () => {
    const page = makeSearchPage('https://www.zhipin.com/job_detail/abc.html')
    try {
      await searchJobs(page as any, '前端')
    } catch {
      // 同上
    }
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('Sprint 2D-4: page 在 about:blank（首次跑）→ 必须 Phase 1 goto', async () => {
    const page = makeSearchPage('about:blank')
    try {
      await searchJobs(page as any, '前端')
    } catch {
      // 同上
    }
    // 🚨 关键：首次必须 goto（不能跳过安全入口）
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.zhipin.com/web/geek/recommend',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
  })

  it('Sprint 2D-5: page 在非 BOSS 域（如 google.com）→ 必须 Phase 1 goto', async () => {
    const page = makeSearchPage('https://www.google.com')
    try {
      await searchJobs(page as any, '前端')
    } catch {
      // 同上
    }
    // 不是 BOSS 域 → 必须 goto 拿登录态
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.zhipin.com/web/geek/recommend',
      expect.any(Object),
    )
  })

  it('Sprint 2D-6: page 在 /user/ 登录页 → 仍然 goto（探针检测要 reveal 重定向）', async () => {
    // 安全入口检测：searchJobs L432-434 在 page.url() 含 /user/ 时抛『登录失效』
    // → 这一步必须走 page.goto，让 Phase 1 探针检测登录态
    const page = makeSearchPage('https://www.zhipin.com/web/user/?ka=header-login')
    try {
      await searchJobs(page as any, '前端')
    } catch {
      // 登录失效会抛
    }
    expect(page.goto).toHaveBeenCalled()
  })

  it('Sprint 2D-7 (hook 审计): URL hostname 是 evil.com 但 query 含 zhipin.com → 必须 goto（防假阳性）', async () => {
    // 假阳性场景：https://evil.com/redirect?url=https://www.zhipin.com/web/geek/jobs
    // 旧实现 currentUrl.includes('zhipin.com') 会匹配 → 错误跳过 goto
    // 新实现用 URL.hostname 严格匹配 → 不匹配 → 仍 goto
    const page = makeSearchPage('https://evil.com/redirect?url=https://www.zhipin.com/web/geek/jobs')
    try {
      await searchJobs(page as any, '前端')
    } catch {
      // 同上
    }
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.zhipin.com/web/geek/recommend',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
  })

  it('Sprint 2D-8 (hook 审计): URL 解析失败（malformed）→ 保守走 goto', async () => {
    // URL parse 失败场景（malformed string）
    const page = makeSearchPage('not-a-url-at-all')
    try {
      await searchJobs(page as any, '前端')
    } catch {
      // 同上
    }
    expect(page.goto).toHaveBeenCalled()
  })
})

// ============================================================
// Sprint 2E: fetchJobDetail 懒加载防御（ADR-0004）
// ============================================================
// 核心问题（2026-07-10 真实探针）：
//   BOSS 首屏只渲染 60% JD（.job-sec-text textLength=551），
//   等 3 秒才补齐到 917 字符。
//   旧 waitForSelector 一出现就 resolve → 拿到不完整 JD → 假绿
//
// 修复方向：
//   - 双路加 MIN_JD_LENGTH=500 长度校验
//   - waitForFunction 替换 waitForSelector
//   - 抛 LazyLoadError 含 lengthHistory
// ============================================================

describe('Sprint 2E: fetchJobDetail 懒加载防御', () => {
  // helper：构造带 waitForFunction 的 mock page
  // waitForFunction 调用时执行 fn(selector, MIN_JD_LENGTH)，fn 检查 mock DOM 长度
  function makeLazyMockPage(opts: {
    wapiResult: { ok: boolean; jd?: string; error?: string }
    pageEvalResults?: string[]
    /** mock DOM：每个 selector 对应的 textLength（默认全 0 = "未渲染"） */
    selectorTextLengths?: Record<string, number>
  }) {
    const page = makeMockPage()
    page.evaluate = vi.fn().mockResolvedValue(opts.wapiResult)
    page.waitForFunction = vi.fn().mockImplementation(async (fn: any, sel: string, minLen: number) => {
      const l = opts.selectorTextLengths?.[sel] ?? 0
      if (l < minLen) throw new Error(`waitForFunction timeout (mock): selector ${sel} length ${l} < ${minLen}`)
    })
    // $eval 返回值序列
    let evalIdx = 0
    page.$eval = vi.fn().mockImplementation(async () => {
      const v = opts.pageEvalResults?.[evalIdx] ?? '完整 JD 内容，长度足够'
      evalIdx++
      return v
    })
    return page
  }

  // ============================================================
  // TEST A: wapi 返 0 字符 → 自动降级 page.goto
  // ============================================================
  it('Sprint 2E-A: wapi 返 ok 但 jd 长度 < MIN_JD_LENGTH → 视为懒加载未完成，降级到 page.goto', async () => {
    // 完整 JD：每段 8 字符 × 100 段 = 800 字符 > 500
    const fullJd = '完整 JD 内容 '.repeat(100)
    const page = makeLazyMockPage({
      wapiResult: { ok: true, jd: '太短了' }, // 4 字符，远 < 500
      pageEvalResults: [fullJd],
      selectorTextLengths: {
        '.job-sec-text': fullJd.length, // DOM 已渲染完整（800 字符）
      },
    })

    const jd = await fetchJobDetail(page as any, 'JOB_LAZY', { throttleMs: 0 })

    expect(jd.length).toBeGreaterThan(500) // 拿到完整 JD，不是 wapi 的"太短了"
    expect(page.goto).toHaveBeenCalled() // 走了降级路径
  })

  // ============================================================
  // TEST B: page.waitForSelector 抛 → 但 waitForFunction 等到完整 → 返完整 JD
  // ============================================================
  it('Sprint 2E-B: waitForFunction 等到 textLength >= MIN → 返完整 JD（不等 waitForSelector）', async () => {
    // wapi 失败 → 走 page.goto 降级
    // waitForFunction resolve → 拿到完整 JD
    const fullJd = '完整 JD 内容 '.repeat(100) // 800 字符 > 500
    const page = makeLazyMockPage({
      wapiResult: { ok: false, error: 'jobDesc 字段缺失或为空' },
      pageEvalResults: [fullJd],
      selectorTextLengths: {
        '.job-sec-text': fullJd.length, // DOM 已渲染完整
      },
    })

    const jd = await fetchJobDetail(page as any, 'JOB_OK', { throttleMs: 0 })

    expect(jd).toBe(fullJd)
    expect(page.waitForFunction).toHaveBeenCalled()
  })

  // ============================================================
  // TEST C: 全部 selector waitForFunction 超时 → 抛 LazyLoadError with lengthHistory
  // ============================================================
  it('Sprint 2E-C: 所有 selector waitForFunction 超时 → 抛 LazyLoadError（含 lengthHistory）', async () => {
    // wapi 失败 + 所有 waitForFunction 抛 timeout
    const page = makeMockPage()
    page.evaluate = vi.fn().mockResolvedValue({ ok: false, error: 'wapi fail' })
    page.waitForFunction = vi.fn().mockRejectedValue(new Error('Timeout 10000ms exceeded'))
    // $eval 也返空（万一 waitForFunction 跳过）
    page.$eval = vi.fn().mockResolvedValue('')

    await expect(
      fetchJobDetail(page as any, 'JOB_FAIL', { throttleMs: 0 }),
    ).rejects.toThrow(/LazyLoadError|懒加载|JD 长度/)

    // 错误消息包含 selector 历史（让人能立刻定位）
    try {
      await fetchJobDetail(page as any, 'JOB_FAIL2', { throttleMs: 0 })
    } catch (err: any) {
      expect(err.message).toContain('.job-sec-text')
      expect(err.message).toContain('textLength')
    }
  })
})

// ============================================================
// searchJobs — 搜索过滤参数（DEEP probe 2026-07-18 实测）
// ------------------------------------------------------------
// DEEP probe 抓包确认：BOSS wapi/zpgeek/search/joblist.json 接受
//   jobType / salary / experience / degree 为【string 顶层字段】
//   （city 是 number，这几个过滤码是 string）
// searchJobs 新增可选第 4 参 filters?: SearchFilters
// 约束：只塞"有值"的 filter，空值/undefined 不进 body（回归安全）
// ============================================================
describe('searchJobs — 过滤参数（DEEP probe）', () => {
  function makeFilterPage(currentUrl = 'https://www.zhipin.com/web/geek/recommend') {
    return {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue(currentUrl),
      evaluate: vi.fn().mockResolvedValue({
        code: 0,
        zpData: { jobList: [{ encryptJobId: 'fake', jobName: 'fake', brandName: 'fake' }] },
      }),
    }
  }

  // page.evaluate(fn, apiBody) —— 第 2 个参数就是 apiBody
  function capturedApiBody(page: ReturnType<typeof makeFilterPage>) {
    return page.evaluate.mock.calls[0][1]
  }

  it('filter-1: 传 4 个 filter → apiBody 含 string 字段（jobType/salary/experience/degree）', async () => {
    const page = makeFilterPage()
    await searchJobs(page as any, 'Java', undefined, {
      jobType: '1901',
      salary: '406',
      experience: '106',
      degree: '203',
    })
    const body = capturedApiBody(page)
    expect(body.jobType).toBe('1901')
    expect(body.salary).toBe('406')
    expect(body.experience).toBe('106')
    expect(body.degree).toBe('203')
    // 均为 string（DEEP 实测格式）
    expect(typeof body.jobType).toBe('string')
    expect(typeof body.salary).toBe('string')
  })

  it('filter-2: 不传 filters → apiBody 无这些 key（回归安全，与旧行为一致）', async () => {
    const page = makeFilterPage()
    await searchJobs(page as any, 'Java')
    const body = capturedApiBody(page)
    expect(body).not.toHaveProperty('jobType')
    expect(body).not.toHaveProperty('salary')
    expect(body).not.toHaveProperty('experience')
    expect(body).not.toHaveProperty('degree')
    // 基础字段仍在
    expect(body.query).toBe('Java')
    expect(body.scene).toBe(1)
    // pageSize 与 CLI --limit 默认对齐（15）
    expect(body.pageSize).toBe(15)
  })

  it('filter-3: 空串/undefined 的 filter 不塞进 body（只塞有值的）', async () => {
    const page = makeFilterPage()
    await searchJobs(page as any, 'Java', undefined, {
      jobType: '1901',
      salary: '',
      experience: undefined,
    })
    const body = capturedApiBody(page)
    expect(body.jobType).toBe('1901')
    expect(body).not.toHaveProperty('salary')
    expect(body).not.toHaveProperty('experience')
  })
})
