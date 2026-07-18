import { createBrowserSession, searchJobs } from './src/browser/index.ts'

;(async () => {
  console.log('🚀 启动浏览器 + 搜索...')
  const session = await createBrowserSession(false)
  const page = session.page
  try {
    const jobs = await searchJobs(page, '前端开发')
    console.log(`\n=== 找到 ${jobs.length} 个岗位 ===\n`)
    const target = jobs[0]
    console.log(`目标: ${target.title} @ ${target.company}`)
    console.log(`  jobId (encryptJobId): ${target.id}`)
    console.log(`  hrUid (encryptBossId): ${target.hrUid}`)
    console.log(`  Link (空 = searchJobs 没填): "${target.link}"`)
    
    // 1) 直接从 DOM 拿 Vue 真实数据
    console.log('\n=== 从 Vue 实例读真实数据 ===')
    const vueData = await page.evaluate(() => {
      const card = document.querySelector('.job-card-wrapper')
      if (!card) return { error: 'no .job-card-wrapper found' }
      const v = card.__vue__
      if (!v) return { error: 'no __vue__ on card' }
      // Vue 2 的 data 在 __vue__ 上；Vue 3 在 setupState
      const data = v.data || v.setupState || v.props?._data || null
      if (!data) return { error: 'no data on vue', vueKeys: Object.keys(v) }
      return { keys: Object.keys(data), sample: JSON.parse(JSON.stringify(data)) }
    })
    console.log('  Vue data:', JSON.stringify(vueData, null, 2).slice(0, 1500))
    
    // 2) 从真实 link 提取参数
    console.log('\n=== 拿到真实 link 后再测接口 1 ===')
    const realLink = await page.evaluate(() => {
      const a = document.querySelector('.job-card-wrapper .job-card-left a')
      return a?.getAttribute('href') || a?.href || ''
    })
    console.log(`  真实 link: ${realLink}`)
    
    // 解析 link 拿参数
    const url = new URL(realLink, 'https://www.zhipin.com')
    const lid = url.searchParams.get('lid') || ''
    const securityId = url.searchParams.get('securityId') || ''
    console.log(`  lid=${lid}`)
    console.log(`  securityId=${securityId}`)
    
    if (lid && securityId) {
      // 测试接口 1
      const wapiUrl = `https://www.zhipin.com/wapi/zpgeek/job/card.json?lid=${encodeURIComponent(lid)}&securityId=${encodeURIComponent(securityId)}&sessionId=`
      console.log(`\n=== 测试接口 1: ${wapiUrl.slice(0, 100)}... ===`)
      const resp = await fetch(wapiUrl, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/125.0' }})
      const json = await resp.json()
      console.log(`  HTTP ${resp.status}, code=${json.code}, message=${json.message}`)
      if (json.code === 0 && json.zpData?.jobCard) {
        const jc = json.zpData.jobCard
        console.log(`  ✅ 接口 1 完全可用！字段：${Object.keys(jc).join(', ')}`)
        console.log(`     postDescription 长度: ${(jc.postDescription || '').length}`)
        console.log(`     activeTimeDesc: ${jc.activeTimeDesc}`)
        console.log(`     friendStatus: ${jc.friendStatus}`)
      } else {
        console.log(`  ❌ ${JSON.stringify(json).slice(0, 400)}`)
      }
    }
    
    // 3) 试接口 2 投递（不真投，只测参数）
    console.log('\n=== 试接口 2: friend/add.json 用真实 jobId ===')
    const testUrl2 = `https://www.zhipin.com/wapi/zpgeek/friend/add.json?securityId=${encodeURIComponent(securityId)}&jobId=${encodeURIComponent(target.id)}&lid=${encodeURIComponent(lid)}`
    console.log(`  URL: ${testUrl2.slice(0, 120)}...`)
    const resp2 = await fetch(testUrl2, {
      method: 'POST',
      headers: { 
        'User-Agent': 'Mozilla/5.0 Chrome/125.0',
        'Content-Type': 'application/json',
        'Zp_token': 'test_token'  // 探一下要不要 Zp_token
      },
      body: '{}'
    })
    const json2 = await resp2.json()
    console.log(`  HTTP ${resp2.status}, code=${json2.code}, message=${json2.message}`)
    console.log(`  响应: ${JSON.stringify(json2).slice(0, 400)}`)
    
  } finally {
    await session.browser.close()
  }
})().catch(e => { console.error('ERROR:', e); process.exit(1) })
