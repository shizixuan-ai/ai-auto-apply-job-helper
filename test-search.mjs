import { createBrowserSession, searchJobs } from './src/browser/index.ts'

;(async () => {
  console.log('🚀 启动浏览器...')
  const session = await createBrowserSession(false)
  try {
    console.log('🔍 搜索 职位：前端开发 / 上海...')
    const jobs = await searchJobs(session.page, '前端开发', '上海')
    console.log(`\n=== 找到 ${jobs.length} 个岗位 ===\n`)
    if (jobs.length === 0) {
      console.log('❌ 没找到任何岗位 — 可能在风控页或 cookie 失效')
      console.log('   当前 URL:', session.page.url())
      return
    }
    for (const job of jobs.slice(0, 3)) {
      console.log(`  标题: ${job.title}`)
      console.log(`  公司: ${job.company}`)
      console.log(`  ID:   ${job.id}`)
      console.log(`  HR:   ${job.hrUid}`)
      console.log(`  Link: ${job.link}`)
      console.log()
    }
    const target = jobs[0]
    console.log('=== 测试接口 1: job/card.json 用真实参数 ===')
    const lid = target.link.match(/lid=([^&]+)/)?.[1] || ''
    const securityId = target.link.match(/securityId=([^&]+)/)?.[1] || ''
    const jobId = target.id
    console.log(`  lid=${lid}`)
    console.log(`  securityId=${securityId}`)
    console.log(`  jobId=${jobId}`)
    
    const url = `https://www.zhipin.com/wapi/zpgeek/job/card.json?lid=${encodeURIComponent(lid)}&securityId=${encodeURIComponent(securityId)}&sessionId=`
    console.log(`  URL: ${url}`)
    
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0' }
    })
    const json = await resp.json()
    console.log(`  HTTP ${resp.status}, code=${json.code}, message=${json.message}`)
    if (json.code === 0 && json.zpData) {
      console.log(`  ✅ 接口 1 完全可用！返回字段：`)
      console.log(`     ${Object.keys(json.zpData).join(', ')}`)
      if (json.zpData.jobCard) {
        const jc = json.zpData.jobCard
        console.log(`     jobCard 字段：${Object.keys(jc).join(', ')}`)
        console.log(`     postDescription 长度：${(jc.postDescription || '').length} 字符`)
        console.log(`     activeTimeDesc：${jc.activeTimeDesc}`)
        console.log(`     friendStatus：${jc.friendStatus}`)
        console.log(`     salary：${jc.salary}`)
        console.log(`     city：${jc.cityName}`)
      }
    } else {
      console.log(`  ❌ 接口调用失败: ${JSON.stringify(json).slice(0, 300)}`)
    }
  } finally {
    await session.browser.close()
  }
})().catch(e => { console.error('ERROR:', e); process.exit(1) })
