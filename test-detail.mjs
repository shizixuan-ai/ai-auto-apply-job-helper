import { createBrowserSession, searchJobs } from './src/browser/index.ts'
import fs from 'node:fs'

;(async () => {
  console.log('🚀 启动浏览器 + 搜索...')
  const session = await createBrowserSession(false)
  const page = session.page
  try {
    const jobs = await searchJobs(page, 'Java后端')
    console.log(`\n=== 找到 ${jobs.length} 个岗位 ===`)
    if (jobs.length === 0) { console.log('❌ 无结果'); return }
    const target = jobs[0]
    console.log(`目标: ${target.title} @ ${target.company}`)
    console.log(`  jobId: ${target.id}`)
    
    // 测 detail.json
    console.log('\n=== 在浏览器内 fetch detail.json（带 cookie）===')
    const detailResp = await page.evaluate(async (jobId) => {
      try {
        const resp = await fetch(`/wapi/zpgeek/job/detail.json?jobId=${encodeURIComponent(jobId)}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
        const data = await resp.json()
        return { http: resp.status, body: data }
      } catch (e) { return { error: e.message } }
    }, target.id)
    
    console.log('HTTP:', detailResp.http)
    if (detailResp.error) {
      console.log('ERROR:', detailResp.error)
    } else {
      console.log('code:', detailResp.body?.code, 'message:', detailResp.body?.message)
      console.log('zpData keys:', Object.keys(detailResp.body?.zpData || {}))
      if (detailResp.body?.zpData?.jobDetail) {
        console.log('jobDetail keys:', Object.keys(detailResp.body.zpData.jobDetail))
        const jd = detailResp.body.zpData.jobDetail.jobDesc
        console.log(`jobDesc length: ${typeof jd} (${(jd || '').length} 字符)`)
        console.log(`jobDesc 头 100 字: ${(jd || '').slice(0, 100)}`)
      }
      console.log('\n完整响应前 1500 字符:')
      console.log(JSON.stringify(detailResp.body, null, 2).slice(0, 1500))
    }
    
    // 对比测 card.json
    console.log('\n\n=== 对比测 card.json ===')
    const cardResp = await page.evaluate(async (jobId) => {
      try {
        const resp = await fetch(`/wapi/zpgeek/job/card.json?jobId=${encodeURIComponent(jobId)}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
        const data = await resp.json()
        return { http: resp.status, body: data }
      } catch (e) { return { error: e.message } }
    }, target.id)
    
    console.log('HTTP:', cardResp.http, 'code:', cardResp.body?.code)
    if (cardResp.body?.zpData?.jobCard) {
      const jc = cardResp.body.zpData.jobCard
      console.log(`  postDescription length: ${(jc.postDescription || '').length}`)
      console.log(`  activeTimeDesc: ${jc.activeTimeDesc}`)
      console.log(`  friendStatus: ${jc.friendStatus}`)
    }
  } finally {
    await session.browser.close()
  }
})().catch(e => { console.error('ERROR:', e); process.exit(1) })
