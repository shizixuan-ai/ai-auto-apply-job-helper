// ============================================================
// 浏览器自动化层 — CDP 接管 + Stealth Fallback
// ============================================================
// 架构（参见 docs/research/boss-auto-apply-2026-06-research.md §5.2）：
//
//   CDP 接管模式（主路径）   → chromium.connectOverCDP(9222)
//                              接管用户已登录的真 Chrome
//                              反爬等级：与真人无差（§5.2.3 羊皮原则）
//
//   Stealth Launch（fallback）→ playwright-extra + stealth
//                              仅当 CDP 不可用时启用
//                              反爬等级：修补指纹，效果有限
// ============================================================

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { connectToUserChrome, attachPlaywrightToCDP } from './cdp.js'
import { withGuard, DEFAULT_GUARD_CONFIG, type GuardConfig, GuardError } from './guard.js'
import { typeText, type TypeTextOptions } from './human.js'
import { detectCityMismatch, type CityReportableJob } from './city-utils.js'
import { LazyLoadError, DEFAULT_MIN_JD_LENGTH } from './lazy-load-error.js'

// ============================================================
// 常量
// ============================================================

const BOSS_URL = 'https://www.zhipin.com'
const COOKIE_PATH = path.join(os.homedir(), '.bapply', 'cookies.json')

/** 风控监控默认选择器（§5.2.5 + review 后整合 — BOSS 前端变更时需更新） */
const RISK_SELECTORS: Pick<
  GuardConfig,
  'captchaSelectors' | 'sliderSelectors' | 'rateLimitSelectors' | 'loginExpiredSelectors'
> = {
  captchaSelectors: [
    '.geetest_panel',
    '.geetest_holder',
    '.verify-captcha-modal',
    '[class*="captcha"]:not([style*="display: none"])',
  ],
  sliderSelectors: [
    '.slider-verify',
    '.nc-container',
    '[class*="slide"]:not([style*="display: none"])',
  ],
  rateLimitSelectors: [
    '.daily-limit-tip',
    '.rate-limit-modal',
    '[class*="limit"]:not([style*="display: none"])',
  ],
  loginExpiredSelectors: [
    '.session-timeout-modal',
    '.login-expired',
    '[class*="expired"]:not([style*="display: none"])',
  ],
}

/** 注入业务页面的风控配置（探测间隔 3s 更激进，pause 上限 10 分钟） */
export const GUARD_CONFIG: GuardConfig = {
  ...DEFAULT_GUARD_CONFIG,
  probeIntervalMs: 3000,
  ...RISK_SELECTORS,
}

/**
 * 风控包装：业务函数外面包 withGuard（检测 + 暂停 + 恢复）
 * waitForUserConfirm 必须在 CLI 层注入（避免 guard.ts 依赖 readline）
 */
let _waitForUserConfirm: () => Promise<void> = async () => {}

export function setWaitForUserConfirm(fn: () => Promise<void>) {
  _waitForUserConfirm = fn
}

/** BOSS 直聘城市编码映射 */
const CITY_CODES: Record<string, number> = {
  '全国': 100010000,
  '北京': 101010100,
  '上海': 101020100,
  '广州': 101280100,
  '深圳': 101280600,
  '杭州': 101210100,
  '成都': 101270100,
  '南京': 101190100,
  '武汉': 101200100,
  '西安': 101110100,
  '重庆': 101040100,
  '苏州': 101190400,
  '天津': 101030100,
  '长沙': 101250100,
  '郑州': 101180100,
  '东莞': 101281600,
  '青岛': 101120200,
  '沈阳': 101070100,
  '宁波': 101210400,
  '昆明': 101290100,
  '合肥': 101220100,
  '佛山': 101280300,
  '厦门': 101230200,
  '济南': 101120100,
  '大连': 101070200,
  '无锡': 101190200,
  '福州': 101230100,
  '南昌': 101240100,
  '贵阳': 101260100,
  '石家庄': 101090100,
  '哈尔滨': 101050100,
  '珠海': 101280700,
  '常州': 101190300,
  '太原': 101100100,
  '嘉兴': 101210300,
  '中山': 101281700,
  '绍兴': 101210500,
  '南宁': 101300100,
  '保定': 101090200,
  '兰州': 101160100,
  '海口': 101310100,
  '扬州': 101190600,
  '长春': 101060100,
  '泉州': 101230500,
  '呼和浩特': 101080100,
  '温州': 101210700,
  '乌鲁木齐': 101130100,
  '惠州': 101280300,
  '南通': 101190500,
  '金华': 101210900,
  '徐州': 101190800,
  '潍坊': 101120600,
  '烟台': 101120500,
  '唐山': 101090500,
  '洛阳': 101180900,
}

// ============================================================
// Cookie 持久化
// ============================================================

function getCookieDir(): string {
  const dir = path.dirname(COOKIE_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function saveCookies(cookies: any[]) {
  getCookieDir()
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2))
}

async function loadCookies(): Promise<any[]> {
  if (!fs.existsSync(COOKIE_PATH)) return []
  return JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8'))
}

// ============================================================
// CDP 模式 — Playwright connectOverCDP 接管用户真 Chrome
// ============================================================
// 取代 puppeteer-core.connect（puppeteer-core 保留作 fallback-only）。
// §5.2 反爬转向：主路径必须是接管，不是启新 Chromium。
// ============================================================

export async function createCDPSession() {
  // 1. 探测 CDP 端口（带明确报错 + 启动命令提示）
  const wrapper = await connectToUserChrome()

  // 2. 让 Playwright 接管用户 Chrome（不复用 puppeteer）
  const browser = await attachPlaywrightToCDP(wrapper)

  // 3. 用户的真身份 context（含 BOSS session cookie、Canvas 指纹等）
  const context = browser.contexts()[0]
  if (!context) {
    throw new Error(
      'CDP 接管成功，但未找到浏览器 context。\n' +
        '请确认 Chrome 已用 --user-data-dir 启动并至少打开过一个窗口。',
    )
  }
  // 2026-07-07 P0 修复：优先复用已在的 zhipin tab（保留真实用户 Session/Referer），
  //   仅当没有 zhipin tab 时才 newPage —— 否则 BOSS 会因缺少 Referer 拒服务
  const page = await pickZhipinTabOrNew(context)
  if (!context.pages().some((p: any) => (p.url?.() || '').includes('zhipin.com'))) {
    console.warn('[browser] 未找到已打开的 BOSS tab，已创建新 tab（请在 Chrome 窗口里至少打开一次 zhipin.com 以避免风控）')
  }

  return {
    browser,
    context,
    page,
    cdpURL: wrapper.cdpURL,
    cdpMode: true as const,
  }
}

/**
 * 复用已在的 zhipin tab；找不到再 newPage()
 * 2026-07-07 P0 抽出：避免 BOSS 因 Referer 缺失静默拒服务
 * @internal 导出供 unit test
 */
export async function pickZhipinTabOrNew(context: {
  pages(): Array<{ url(): string | undefined }>
  newPage(): Promise<unknown>
}): Promise<unknown> {
  const existing = context.pages().find((p) => (p.url() || '').includes('zhipin.com'))
  if (existing) return existing
  return await context.newPage()
}

// ============================================================
// Stealth Launch（fallback：CDP 不可用时的降级模式）
// ============================================================
// 仅当 user Chrome 未启用 remote-debug 时启用。
// 反爬能力显著弱于 CDP 接管（修补指纹 vs 真实身份）。
// ============================================================

export async function createBrowserSession(headless = false) {
  const { chromium } = await import('playwright-extra')
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  chromium.use(StealthPlugin())

  const browser = await chromium.launch({
    headless,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  const cookies = await loadCookies()
  if (cookies.length > 0) {
    await context.addCookies(cookies)
  }

  const page = await context.newPage()
  return { browser, context, page, cdpMode: false as const }
}

// ============================================================
// 关闭会话（双模式兼容：CDP 接管 / Stealth Launch）
// ============================================================

export async function closeBrowserSession(session: {
  browser: any
  page: any
  context?: any
  cdpMode: boolean
}) {
  const { browser, context, cdpMode } = session

  // 保存 Cookie
  let cookies: any[] = []
  try {
    if (context) {
      // Playwright: context.cookies()（CDP 与 Launch 模式均用此 API）
      cookies = await context.cookies()
    }
  } catch (err) {
    // 审计修复（穷尽审计 P1-1）：cookie 读取失败必须 warn
    // 否则用户下次启动会反复扫码登录（macOS 权限问题常见）
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[browser] Cookie 读取失败（已忽略，可能下次需重新登录）: ${msg}`)
  }

  if (cookies.length > 0) await saveCookies(cookies)

  if (cdpMode) {
    // CDP 接管：只断开与用户真 Chrome 的连接，不关浏览器
    try {
      await browser.close()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[browser] CDP browser.disconnect 失败（Chrome 进程可能已退出）: ${msg}`)
    }
    return
  }

  // Stealth Launch（fallback）：关闭我们启动的浏览器
  // 审计修复：cleanup 失败必须 warn，否则 Chrome 进程泄漏 → macOS zombie
  try {
    await context?.close()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[browser] context.close 失败（Chrome 可能已崩溃）: ${msg}`)
  }
  try {
    await browser.close()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[browser] browser.close 失败（可能僵尸进程）: ${msg}`)
  }
}

// ============================================================
// 登录（扫码）
// ============================================================

export async function loginByQR(page: any): Promise<void> {
  await page.goto(BOSS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  if (page.url().includes('zhipin.com') && !page.url().includes('/user/')) {
    console.log('✅ Cookie 有效，已登录')
    return
  }

  console.log('🔑 请在浏览器窗口中扫描二维码登录...')
  await page.goto('https://www.zhipin.com/web/user/?ka=header-login', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  let lastRefresh = Date.now()
  while (true) {
    await new Promise(r => setTimeout(r, 1000))

    if (page.url().includes('zhipin.com') && !page.url().includes('/user/')) {
      console.log('\n✅ 登录成功')
      await new Promise(r => setTimeout(r, 2000))
      return
    }

    if (page.url() === 'about:blank' && Date.now() - lastRefresh > 15_000) {
      await page.goto('https://www.zhipin.com/web/user/?ka=header-login', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      lastRefresh = Date.now()
    }
  }
}

// ============================================================
// 搜索岗位 — API + DOM 混合模式
// ============================================================

export interface SearchResult {
  id: string
  title: string
  company: string
  salary: string
  city: string
  experience: string
  degree: string
  labels: string[]
  brandStage: string
  brandIndustry: string
  brandScale: string
  welfare: string[]
  skills: string[]
  link: string
  /**
   * 招聘方 HR 的 BOSS 加密 uid（Sprint 2B）
   *
   * BOSS API 真实字段名：encryptBossId（probe 验证 2026-07-09）
   * 之前推断的 encryptUserId 是错的（BOSS 把 HR 也叫 "Boss"）
   * 契约测试基线：tests/fixtures/boss-schema.json
   */
  hrUid?: string
}

/**
 * 从 BOSS API 单个 job 对象提取 HR 加密 uid（Sprint 2B）
 *
 * 实测字段名：encryptBossId（probe 验证 2026-07-09）
 * 备选字段：encryptedBossId / hrEncryptId（BOSS 改版时扩展 fallback）
 *
 * 导出供单测使用（避免 page.evaluate mock 复杂性）
 */
export function extractHrUid(job: any): string | undefined {
  return job?.encryptBossId || job?.encryptedBossId || job?.hrEncryptId
}

/** DOM-First 滚动预加载 + 摘取（API 降级时的 fallback） */
async function extractJobsFromDOM(page: any): Promise<any[]> {
  return page.evaluate(async (cfg: any) => {
    const { scrollStep, waitMs, stableThreshold, maxRounds } = cfg
    let lastCount = 0
    let stableRounds = 0

    for (let round = 0; round < maxRounds; round++) {
      window.scrollBy(0, scrollStep)
      await new Promise(r => setTimeout(r, waitMs))

      const cards = document.querySelectorAll('.job-card-box, .job-card-wrapper')
      if (cards.length === lastCount && cards.length > 0) {
        stableRounds++
      } else {
        stableRounds = 0
      }
      lastCount = cards.length

      if (stableRounds >= stableThreshold) break
    }

    const results: any[] = []
    const finalCards = document.querySelectorAll('.job-card-box, .job-card-wrapper')
    finalCards.forEach((card) => {
      const jobName = card.querySelector('.job-name')?.textContent?.trim()
      const salary = card.querySelector('.salary')?.textContent?.trim()
      const company = card.querySelector('.company-name a')?.textContent?.trim() ||
                      card.querySelector('.brand-name')?.textContent?.trim()
      const hrefEl = card.querySelector('a[ka^="search_list_"]') ||
                     card.querySelector('.job-card-left')
      const href = hrefEl?.getAttribute('href') || ''
      const idMatch = href.match(/\/job_detail\/(.*?)\.html/)
      const jobId = idMatch ? idMatch[1] : ''

      if (jobName && company) {
        results.push({
          id: jobId || `dom_${Math.random().toString(36).slice(2, 9)}`,
          jobName,
          salary,
          company,
          detailUrl: href ? `https://www.zhipin.com${href}` : '',
        })
      }
    })
    return results
  }, { scrollStep: 180, waitMs: 400, stableThreshold: 5, maxRounds: 40 })
}

export async function searchJobs(
  page: any,
  keyword: string,
  city?: string,
): Promise<SearchResult[]> {
  // ---- Phase 1: 安全入口 ----
  // Sprint 2D 修复：避免连续跑 search 时的 BOSS SPA navigation race
  //   前一次 search 留下的 URL（如 /web/geek/jobs?query=...）若与目标同源，
  //   BOSS 客户端路由会 redirect → 中断 Playwright page.goto → throws
  // 解决：检测当前 page.url() 的 hostname，若已是 zhipin.com → 跳过 goto
  //
  // 安全考量（hook 审计反馈）：
  //   - ❌ 不能用 currentUrl.includes('zhipin.com') — query 参数含 zhipin.com 会假阳性
  //     （如 https://evil.com/redirect?url=https://zhipin.com）
  //   - ✅ 用 URL parse 提取 hostname（origin 一部分，不含 query/path）
  //   - ✅ 路径 regex 不要强求尾斜杠（/web/geek/jobs 实际无尾斜杠）
  //   - ✅ page.url() 可能 null（page closed）→ 防御
  const currentUrl = page.url() ?? ''
  let alreadyOnBoss = false
  try {
    if (currentUrl && currentUrl !== 'about:blank') {
      const u = new URL(currentUrl)
      // hostname 严格等于 zhipin.com（不含 m. 等子域，除非显式支持）
      if (u.hostname === 'zhipin.com' || u.hostname.endsWith('.zhipin.com')) {
        // 路径前缀匹配（不强求尾斜杠）
        const path = u.pathname
        if (
          path.startsWith('/web/geek') ||
          path.startsWith('/job_detail')
        ) {
          alreadyOnBoss = true
        }
      }
    }
  } catch {
    // URL parse 失败 → 保守走 goto
    alreadyOnBoss = false
  }

  if (!alreadyOnBoss) {
    // 首次跑 / 不在 BOSS 域 → 必须 goto 安全入口
    await page.goto('https://www.zhipin.com/web/geek/recommend', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
  }

  // 如果 recommend 也被重定向（仍 about:blank 或 /user/），抛错
  if (page.url() === 'about:blank' || page.url().includes('/user/')) {
    throw new Error('登录已失效，请先运行 bapply login 重新扫码登录')
  }

  // ---- Phase 2: API 直调 ----
  const apiBody: Record<string, any> = {
    query: keyword,
    scene: 1,
    page: 1,
    pageSize: 20,
  }
  if (city && CITY_CODES[city]) {
    apiBody.city = CITY_CODES[city]
  }

  // ⚠️ Sprint 2B P0 修复：env 判断移到 host 代码（page.evaluate 在浏览器上下文，
  //    process.env / node:fs / process.cwd() 都不可用 —— 之前会导致 ReferenceError）
  const isDebug = process.env.BOSS_SEARCH_DEBUG === '1'
  const isProbe = process.env.BOSS_SEARCH_PROBE === '1'

  const apiResult = await page.evaluate(async (body: any) => {
    try {
      const res = await fetch('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      return json
    } catch (e: any) {
      return { error: e.message }
    }
  }, apiBody)

  // 调试/探针：page.evaluate 之外做（host 有完整 Node API）
  if ((isDebug || isProbe) && apiResult?.zpData?.jobList?.[0]) {
    const firstJob = apiResult.zpData.jobList[0]
    if (isDebug) {
      const userKeys = Object.keys(firstJob).filter((k) =>
        /user|hr|encrypt/i.test(k),
      )
      console.log('[searchJobs] BOSS API 用户相关字段（验证用）:')
      for (const k of userKeys) {
        console.log(`  ${k}: ${firstJob[k]}`)
      }
    }
    if (isProbe) {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname, resolve } = await import('node:path')
      const schemaPath = resolve(process.cwd(), 'tests/fixtures/boss-schema.json')
      mkdirSync(dirname(schemaPath), { recursive: true })
      const sanitize = (key: string, value: unknown): unknown => {
        if (typeof value !== 'string') return value
        if (/name|brand|company|title|jobName/i.test(key)) {
          return value.length > 10 ? value.slice(0, 8) + '...' : value
        }
        if (/url|link/i.test(key)) return '[URL_OMITTED]'
        return value
      }
      const sanitized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(firstJob)) {
        sanitized[k] = sanitize(k, v)
      }
      const probePayload = {
        _meta: {
          capturedAt: new Date().toISOString(),
          source: 'BOSS /wapi/zpgeek/search/joblist.json',
          jobListIndex: 0,
          note: '契约测试的"黄金基准"。BOSS 改版时重新跑 npm run probe:boss 覆盖。',
        },
        sampleJob: sanitized,
        userRelatedFields: Object.keys(firstJob)
          .filter((k) => /user|hr|encrypt/i.test(k))
          .map((k) => ({ key: k, value: firstJob[k] })),
      }
      writeFileSync(schemaPath, JSON.stringify(probePayload, null, 2))
      console.log(`[searchJobs] ✅ schema dumped to ${schemaPath}`)
    }
  }

  // API 成功 → 解析结构化数据
  if (apiResult.code === 0 && apiResult.zpData?.jobList?.length > 0) {
    const jobs: SearchResult[] = apiResult.zpData.jobList.map((job: any) => ({
      id: job.encryptJobId || `api_${Math.random().toString(36).slice(2, 9)}`,
      title: job.jobName ?? '',
      company: job.brandName ?? '',
      salary: job.salaryDesc ?? '',
      city: job.cityName ?? '',
      experience: job.jobExperience ?? '',
      degree: job.jobDegree ?? '',
      labels: job.jobLabels ?? [],
      brandStage: job.brandStageName ?? '',
      brandIndustry: job.brandIndustry ?? '',
      brandScale: job.brandScaleName ?? '',
      welfare: job.welfareList ?? [],
      skills: job.skills ?? [],
      link: job.link ?? '',
      // Sprint 2B：HR 加密 uid（friend/add 第二参数 uid）
      // 实测字段名 encryptBossId（probe 验证 2026-07-09）
      // 契约基线：tests/fixtures/boss-schema.json userRelatedFields
      hrUid: extractHrUid(job),
    }))

    // ---- Phase 2.5: --city 警告（详见 ADR-0003 + city-utils.ts） ----
    if (city) {
      // SearchResult.city 字段对应 BOSS API 的 cityName，我们用 {cityName} 形式传给 helper
      const cityMatches: CityReportableJob[] = jobs.map((j) => ({ cityName: j.city }))
      const mismatchWarning = detectCityMismatch(city, cityMatches)
      if (mismatchWarning) {
        console.warn(mismatchWarning)
      }
    }

    // ---- Phase 3: DOM 补充提取（不阻塞主流程） ----
    try {
      const domJobs = await extractJobsFromDOM(page)
      if (domJobs.length > jobs.length) {
        // DOM 数据比 API 多（分页场景），补充合并
        const existingIds = new Set(jobs.map(j => j.id))
        for (const d of domJobs) {
          if (!existingIds.has(d.id) && d.jobName && d.company) {
            jobs.push({
              id: d.id,
              title: d.jobName,
              company: d.company,
              salary: d.salary ?? '',
              city: '', experience: '', degree: '',
              labels: [], brandStage: '', brandIndustry: '', brandScale: '',
              welfare: [], skills: [],
              link: d.detailUrl ?? '',
            })
          }
        }
      }
    } catch {
      // DOM 提取失败不影响 API 数据
    }

    return jobs
  }

  // ---- Fallback: API 失败，纯 DOM 提取 ----
  console.warn('⚠️ API 调用失败，降级到 DOM 提取模式')
  if (apiResult.message) console.warn(`   原因: ${apiResult.message}`)
  if (apiResult.error) console.warn(`   异常: ${apiResult.error}`)  // Sprint 2B P0: page.evaluate fetch 抛错信息

  await page.goto(`https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  // 如果被重定向，已无计可施
  if (page.url() === 'about:blank') {
    throw new Error('页面被反爬拦截，请使用 --cdp 模式连接真实 Chrome')
  }

  const domJobs = await extractJobsFromDOM(page)
  return domJobs.map((d: any) => ({
    id: d.id,
    title: d.jobName ?? '',
    company: d.company ?? '',
    salary: d.salary ?? '',
    city: '', experience: '', degree: '',
    labels: [], brandStage: '', brandIndustry: '', brandScale: '',
    welfare: [], skills: [],
    link: d.detailUrl ?? '',
  }))
}

// ============================================================
// 抓取岗位详情 (JD)
// ============================================================
// 2026-07-07 修 P0：原版硬编码 .job-sec-text，BOSS 改 HTML 后 100% 失败
// 现在用 fallback selector 链按顺序尝试，每个独立超时
// ============================================================

/**
 * JD 内容容器候选选择器（按优先级排序）
 * - 主选择器：旧版 BOSS 的 .job-sec-text
 * - 备选：覆盖 BOSS 最近几次改版的常见 class 名
 * - 末尾：模糊匹配兜底（[class*="job-sec"] 等）
 *
 * 如何新增：BOSS 改 HTML 时，跑 `scripts/probe-boss-selectors.sh` 找新选择器，
 * 把新选择器插到数组前面（不要删旧的，给老用户提供回滚机会）。
 */
export const JD_SELECTORS: ReadonlyArray<string> = [
  '.job-sec-text',          // 主（旧版）
  '.job-detail-section',    // 候选 1（2025+ 改版）
  '.job-intro-container',   // 候选 2
  '.text-desc',             // 候选 3（旧版备选）
  '[class*="job-sec"]',     // 模糊匹配（兜底）
  '[class*="job-detail"]',  // 模糊匹配（兜底）
]

/** 单个选择器独立超时（不要和 page.goto 的 30s 串行） */
const JD_SELECTOR_TIMEOUT_MS = 3_000

export async function fetchJobDetail(page: any, jobId: string, opts: { throttleMs?: number; minJdLength?: number } = {}): Promise<string> {
  // Sprint 2E：测试可通过 opts.minJdLength=0 跳过长度校验（聚焦 selector 链测试）
  const minJdLength = opts.minJdLength ?? DEFAULT_MIN_JD_LENGTH
  // ============================================================
  // Sprint 1A 修复 P0：先试 wapi JSON（带 cookie），失败再降级 page.goto
  // 原因：page.goto 高频触发 BOSS _security_check 反爬拦截
  // ============================================================

  // 尝试 1：wapi JSON（在 BOSS 域内 fetch，带页面 cookie + UA）
  try {
    const jdFromWapi = await fetchJobDetailViaWapi(page, jobId)
    if (jdFromWapi && jdFromWapi.length > 0) {
      // Sprint 2E：wapi 返了但长度不够 → 视为懒加载未完成，降级
      if (jdFromWapi.length >= minJdLength) {
        return jdFromWapi
      }
      console.warn(`[fetchJobDetail] wapi 返 ${jdFromWapi.length} 字符 < ${minJdLength}（懒加载未完成），降级到 page.goto`)
    }
    // wapi 返了但 jobDesc 为空 → 降级
  } catch (err) {
    // wapi 失败（无 zp_token / 网络 / 解析）→ 降级到 page.goto
    // 不静默吞：Sprint 1A 假绿零容忍
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[fetchJobDetail] wapi 失败，降级到 page.goto: ${msg}`)
  }

  // 尝试 2：降级到 page.goto + 限速（默认 3000ms，缓解反爬）
  // 测试时传 throttleMs: 0 跳过 sleep
  const throttleMs = opts.throttleMs ?? 3000
  const fullUrl = `https://www.zhipin.com/job_detail/${jobId}.html`

  // Sprint 2E 决策 3：throttleMs 之前 waitForSelector('body', 5s) 检查骨架
  // 防止"等 3 秒后页面 404 / 空白"浪费 selector 探针时间
  if (throttleMs > 0) {
    await sleep(throttleMs)
  }
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // Sprint 2E 决策 3（实际实现）：page.goto 后等 body 骨架
  // 防止"等 3 秒后页面 404 / 空白"浪费 selector 探针时间
  await page.waitForSelector('body', { timeout: 5_000 })

  // Fallback selector 链：每个独立超时，返回首个非空文本
  // Sprint 2E：替换 waitForSelector → waitForFunction(textLength >= MIN)
  // 防御 BOSS 首屏只渲染 60% JD（懒加载），等文本稳定到足够长
  const triedSelectors: string[] = []
  const lengthHistory: Record<string, number[]> = {}
  for (const selector of JD_SELECTORS) {
    triedSelectors.push(selector)
    lengthHistory[selector] = []
    try {
      await page.waitForFunction(
        (sel: string, minLen: number) => {
          const el = document.querySelector(sel)
          return el !== null && (el.textContent ?? '').trim().length >= minLen
        },
        selector,
        minJdLength,
        { timeout: JD_SELECTOR_TIMEOUT_MS, polling: 500 },
      )
    } catch {
      // 超时或未命中 → 试下一个
      continue
    }
    try {
      const jd = await page.$eval(selector, (el: any) => el.textContent?.trim() ?? '')
      if (jd && jd.length >= minJdLength) {
        return jd
      }
      // 选择器命中但长度不够（即使 waitForFunction resolve 了，仍二次校验）
      continue
    } catch {
      // $eval 失败（极少见：选择器 race condition）
      continue
    }
  }

  // 所有选择器都失败 → 抛 LazyLoadError（含 lengthHistory）
  throw new LazyLoadError({
    url: fullUrl,
    selectors: triedSelectors,
    lengthHistory,
    cause: 'all_selectors_lazy',
  })
}

/**
 * Sprint 1A P0 修复：通过 BOSS wapi JSON 抓取 JD（在 BOSS 域内 fetch，带 cookie）
 * 避免 page.goto 触发 _security_check 反爬
 *
 * 端点：/wapi/zpgeek/job/detail.json?jobId=XXX
 * 关键：
 *   - 必须在 BOSS 域内 fetch（CORS + cookie 限制）
 *   - 需要 zp_token cookie（搜索页就带）
 *   - 返 JSON：{ zpData: { jobDetail: { jobDesc: "..." } } }
 */
async function fetchJobDetailViaWapi(page: any, jobId: string): Promise<string> {
  // 在 BOSS 域内 fetch（page.evaluate 内 this = window）
  const result = await page.evaluate(async (jobId: string) => {
    try {
      const resp = await fetch(`/wapi/zpgeek/job/detail.json?jobId=${encodeURIComponent(jobId)}`, {
        credentials: 'include',  // 带 cookie
        headers: { Accept: 'application/json' },
      })
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}` }
      }
      const data: any = await resp.json()
      const jd = data?.zpData?.jobDetail?.jobDesc
      if (typeof jd !== 'string' || jd.length === 0) {
        return { ok: false, error: 'jobDesc 字段缺失或为空' }
      }
      return { ok: true, jd }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }, jobId)

  if (!result?.ok) {
    throw new Error(result?.error ?? 'wapi 返回未知错误')
  }
  return result.jd
}

/** 简单的 sleep（不用 setTimeout 包装为了类型清晰） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============================================================
// 发送打招呼消息（Sprint 2A：friend/add API）
// ============================================================
//
// 协议：POST https://www.zhipin.com/wapi/zpgeek/friend/add.json
//   - 在 BOSS 域内 fetch（page.evaluate，带 cookie + Referer，CDP 复用登录态）
//   - form-encoded body: gid=<jobId>&uid=<hrId>&message=<msg>&expectInfo=0
//
// 5 状态枚举（与飞书"打招呼状态"单选项严格对齐）：
//   - sent:             BOSS code=0，zpData 有 friendId
//   - failed:           业务错误（length>200 / BOSS 其他 code / 网络错误）
//   - rate_limited:     BOSS code=99991604（"too many requests today"）
//   - security_blocked: BOSS code=99991603（"verify required"）
//
// GuardError 仍由 withGuard 抛出（abort_today / abort）→ send-handler.ts 映射到 exit code
// ============================================================

/** 招呼语最大长度（BOSS friend/add message 字段上限） */
const MESSAGE_MAX = 200
const FRIEND_ADD_URL = 'https://www.zhipin.com/wapi/zpgeek/friend/add.json'

export type SendGreetingAction =
  | 'sent'
  | 'failed'
  | 'rate_limited'
  | 'security_blocked'

export interface SendGreetingResult {
  action: SendGreetingAction
  /** 仅 action='sent' 时有值（来自 BOSS zpData） */
  friendId?: string
  chatId?: string
  /** failed / rate_limited / security_blocked 都有：保留 BOSS message 便于调试 */
  error?: string
}

export async function sendGreeting(
  page: any,
  jobId: string,
  hrId: string,
  message: string,
): Promise<SendGreetingResult> {
  // 前置守卫：message 长度必须在 HTTP 调用之前校验（防 BOSS 拒绝后浪费配额）
  if (message.length > MESSAGE_MAX) {
    return {
      action: 'failed',
      error: `message 长度 ${message.length} 超过上限 ${MESSAGE_MAX} 字`,
    }
  }

  try {
    return await withGuard(
      page,
      async () => {
        // page.evaluate 在浏览器上下文执行 fetch（带 cookie + Referer）
        const data = await page.evaluate(
          async ({ url, body }: { url: string; body: string }) => {
            const resp = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              },
              body,
              credentials: 'include',
            })
            return await resp.json()
          },
          {
            url: FRIEND_ADD_URL,
            body: `gid=${encodeURIComponent(jobId)}&uid=${encodeURIComponent(hrId)}&message=${encodeURIComponent(message)}&expectInfo=0`,
          },
        )

        // 解析 BOSS 响应（参考 boss-zhipin-bot README 错误码）
        if (data?.code === 0) {
          return {
            action: 'sent' as const,
            friendId: data.zpData?.friendId,
            chatId: data.zpData?.chatId,
          }
        }
        if (data?.code === 99991603) {
          return { action: 'security_blocked' as const, error: data?.message }
        }
        if (data?.code === 99991604) {
          return { action: 'rate_limited' as const, error: data?.message }
        }
        return {
          action: 'failed' as const,
          error: data?.message ?? `BOSS 返 code=${data?.code}`,
        }
      },
      { config: GUARD_CONFIG, waitForUserConfirm: _waitForUserConfirm },
    )
  } catch (err) {
    // GuardError 必须透传（让 send-handler.ts 看到 abort_today / abort 决策）
    if (err instanceof GuardError) {
      throw err
    }
    // 业务错误（fetch 失败 / JSON 解析失败 / withGuard probe 抛错）
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`❌ sendGreeting 失败 (jobId=${jobId}):`, msg)
    return { action: 'failed', error: msg }
  }
}
