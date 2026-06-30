// ============================================================
// Playwright / Puppeteer 浏览器自动化层
// ============================================================
// 双模式架构:
//   launch 模式 → playwright-extra + stealth（登录、发消息）
//   CDP 模式   → puppeteer-core（真实 Chrome，搜岗位）
// ============================================================

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'

// ============================================================
// 常量
// ============================================================

const BOSS_URL = 'https://www.zhipin.com'
const COOKIE_PATH = path.join(os.homedir(), '.bapply', 'cookies.json')
const CDP_PORT = 9222
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`

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
// CDP 模式 — Puppeteer-core 连接 Chrome
// ============================================================

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function checkCDPRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

function launchChromeWithCDP(userDataDir?: string): void {
  const args = [`--remote-debugging-port=${CDP_PORT}`]
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`)

  const proc = spawn(CHROME_PATH, args, {
    stdio: 'ignore',
    detached: true,
  })
  proc.unref()
  console.log(`🚀 Chrome 已启动（端口 ${CDP_PORT}）`)
}

async function ensureCDP(): Promise<string> {
  const running = await checkCDPRunning()
  if (!running) {
    const dataDir = path.join(os.homedir(), '.bapply', 'chrome-profile')
    launchChromeWithCDP(dataDir)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      if (await checkCDPRunning()) {
        console.log('✅ CDP 就绪')
        return CDP_URL
      }
    }
    throw new Error('Chrome 启动超时（30 秒）')
  }
  return CDP_URL
}

export async function createCDPSession() {
  const endpointURL = await ensureCDP()
  // Puppeteer-core CDP 连接，兼容 Chrome 149+
  const puppeteer = await import('puppeteer-core')
  const browser = await puppeteer.connect({ browserURL: endpointURL })
  const page = await browser.newPage()

  // 注入 navigator.webdriver 修复
  const cdp = await page.createCDPSession()
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
  })
  await cdp.detach()

  return { browser, page, cdpMode: true as const }
}

// ============================================================
// 浏览器会话管理（Playwright launch 模式）
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
// 关闭会话（双模式兼容）
// ============================================================

export async function closeBrowserSession(session: {
  browser: any
  page: any
  context?: any
  cdpMode: boolean
}) {
  const { browser, page, context, cdpMode } = session

  // 保存 Cookie
  let cookies: any[] = []
  try {
    if (cdpMode) {
      // Puppeteer: page.cookies()
      cookies = await page.cookies(...(page.url().includes('zhipin.com') ? [BOSS_URL] : []))
    } else if (context) {
      // Playwright: context.cookies()
      cookies = await context.cookies()
    }
  } catch { /* cookie 读取失败不阻塞关闭 */ }

  if (cookies.length > 0) await saveCookies(cookies)

  if (cdpMode) {
    // Puppeteer CDP: 只断开连接，不关浏览器
    await browser.close()
    return
  }

  // Playwright: 关闭上下文和浏览器
  try { await context?.close() } catch {}
  try { await browser.close() } catch {}
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

export async function fetchJobDetail(page: any, jobId: string): Promise<string> {
  const fullUrl = `https://www.zhipin.com/job_detail/${jobId}.html`
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // 等待 JD 内容加载
  await page.waitForSelector('.job-sec-text', { timeout: 10_000 })
  const jd = await page.$eval('.job-sec-text', (el: any) => el.textContent?.trim() ?? '')
  return jd
}

// ============================================================
// 发送打招呼消息（API 直调，不依赖 DOM）
// ============================================================

export async function sendGreeting(page: any, jobId: string, message: string): Promise<boolean> {
  try {
    // 方案：打开聊天页 → evaluate 注入输入 + 点击发送
    await page.goto(`https://www.zhipin.com/web/chat?jobId=${jobId}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    })
    await page.waitForSelector('#chat-input', { timeout: 10_000 })

    // 通过 evaluate 设置输入并发送（兼容 Playwright 和 Puppeteer）
    await page.evaluate((msg: string) => {
      const input = document.querySelector('#chat-input') as HTMLTextAreaElement
      if (input) {
        input.value = msg
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const sendBtn = document.querySelector('.btn-send') as HTMLElement
      sendBtn?.click()
    }, message)

    console.log(`✅ 已向岗位 ${jobId} 发送打招呼消息`)
    return true
  } catch (err) {
    console.error(`❌ 向岗位 ${jobId} 发送消息失败:`, err)
    return false
  }
}
