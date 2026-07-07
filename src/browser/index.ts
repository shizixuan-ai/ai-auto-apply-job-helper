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
  await page.goto('https://www.zhipin.com/web/geek/recommend', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  // 如果 recommend 也被重定向，抛错
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

  const apiResult = await page.evaluate(async (body: any) => {
    try {
      const res = await fetch('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return await res.json()
    } catch (e: any) {
      return { error: e.message }
    }
  }, apiBody)

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

export async function fetchJobDetail(page: any, jobId: string): Promise<string> {
  const fullUrl = `https://www.zhipin.com/job_detail/${jobId}.html`
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // Fallback selector 链：每个独立超时，返回首个非空文本
  const triedSelectors: string[] = []
  for (const selector of JD_SELECTORS) {
    triedSelectors.push(selector)
    try {
      await page.waitForSelector(selector, { timeout: JD_SELECTOR_TIMEOUT_MS })
    } catch {
      // 超时或未命中 → 试下一个
      continue
    }
    try {
      const jd = await page.$eval(selector, (el: any) => el.textContent?.trim() ?? '')
      if (jd && jd.length > 0) {
        return jd
      }
      // 选择器命中但内容为空（BOSS 改了结构）→ 继续试下一个
      continue
    } catch {
      // $eval 失败（极少见：选择器 race condition）
      continue
    }
  }

  // 所有选择器都失败
  throw new Error(
    `fetchJobDetail 失败：尝试了 ${triedSelectors.length} 个选择器都未命中 JD 容器\n` +
      `  URL: ${fullUrl}\n` +
      `  已尝试: ${triedSelectors.join(', ')}\n` +
      `  可能原因：(1) BOSS 又改 HTML（跑 scripts/probe-boss-selectors.sh 找新选择器）` +
      ` (2) jobId 无效/岗位已下架 (3) 登录态失效`,
  )
}

// ============================================================
// 发送打招呼消息（API 直调，不依赖 DOM）
// ============================================================

export async function sendGreeting(
  page: any,
  jobId: string,
  message: string,
  typeTextOptions?: TypeTextOptions,
): Promise<boolean> {
  return withGuard(
    page,
    async () => {
      try {
        // 方案：打开聊天页 → 人类节奏键入（typeText 模拟真人输入）→ 点击发送
        await page.goto(`https://www.zhipin.com/web/chat?jobId=${jobId}`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        })
        await page.waitForSelector('#chat-input', { timeout: 10_000 })

        // 用 typeText 替代直接 evaluate：触发真实键盘事件 + 随机延迟 + typo 注入
        const result = await typeText(page, '#chat-input', message, typeTextOptions)
        await page.click('.btn-send')

        console.log(`✅ 已向岗位 ${jobId} 发送打招呼消息 (typed=${result.typed}, typos=${result.typos})`)
        return true
      } catch (err) {
        // backlog #7: GuardError 必须透传（不让风控决策被业务 catch 吞掉）
        // 业务错误（page.goto 抛 navigation timeout 等）仍返回 false
        if (err instanceof GuardError) {
          throw err
        }
        console.error(`❌ 向岗位 ${jobId} 发送消息失败:`, err)
        return false
      }
    },
    { config: GUARD_CONFIG, waitForUserConfirm: _waitForUserConfirm },
  )
}
