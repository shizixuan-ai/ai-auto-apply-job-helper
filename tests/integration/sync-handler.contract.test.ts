// ============================================================
// sync-handler 集成测试 — Sprint 2B Step B
// ============================================================
// 目的：用 msw 拦截真实 BOSS + Feishu API，验证 handler 端到端契约
//
// 与单测区别：
//   - 单测：mock runSendCommand / listRecords（handler 的边界）
//   - 集成测试：跑真实 handler + msw 拦 HTTP（验证真实代码路径）
//
// 关键防护（来自"假绿零容忍"memory）：
//   - afterEach 强断言 msw 未匹配请求数 = 0（setup.ts 配置）
//   - 任何发出的请求没被 handler 拦截 → 测试失败（不是 warn）
//
// 契约：
//   - searchJobs(page, keyword) → fetch BOSS /wapi/zpgeek/search/joblist.json
//     → 解析 → SearchResult[]（含 hrUid，从 encryptBossId 提取）
//   - runSyncCommand({mode:'auto-greet'}) → fetch Feishu listRecords
//     → 对每个『待投递』调 generateGreeting + runSendCommand
//     → 成功 → updateRecord『已投递』
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import bossSchemaFixture from '../fixtures/boss-schema.json' with { type: 'json' }
import feishuSchemaFixture from '../fixtures/feishu-schema.json' with { type: 'json' }

// ============================================================
// vi.hoisted + vi.mock：必须在 import handler 之前注册
// ------------------------------------------------------------
// vitest 的 vi.mock 会被静态提升到文件顶部，但 vi.fn() 是运行时创建
// 用 vi.hoisted 创建 mocks（先于 import 执行）
// ============================================================
const {
  mockLoadConfig,
  mockRunSendCommand,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockRunSendCommand: vi.fn(),
}))

// 静态 mock（提升到 import 之前）
vi.mock('../../src/config/index.js', () => ({
  loadConfig: mockLoadConfig,
}))
vi.mock('../../src/cli/handlers/send-handler.js', () => ({
  runSendCommand: mockRunSendCommand,
}))

// ============================================================
// BOSS search API mock
// ------------------------------------------------------------
// 关键：用 boss-schema.json 的真实 sampleJob（Step A 探针捕获）
// 这样我们测的就是"BOSS 真实 schema 下我的代码能正确解析"
// 而不是测"我以为的 schema"（即假绿防护）
// ============================================================

const BOSS_SEARCH_URL = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json'

function buildBossJobListResponse() {
  // 从 boss-schema.json 拷出 sampleJob 的 userRelatedFields（含 encryptBossId）
  // 完整 sampleJob 太长（带 gps 等敏感字段），mock 时只取关键字段
  const sampleJob = bossSchemaFixture.sampleJob
  return {
    code: 0,
    message: 'success',
    zpData: {
      jobList: [
        {
          encryptJobId: sampleJob.encryptJobId,
          jobName: sampleJob.jobName,
          brandName: sampleJob.brandName,
          salaryDesc: sampleJob.salaryDesc,
          cityName: sampleJob.cityName,
          jobExperience: sampleJob.jobExperience,
          jobDegree: sampleJob.jobDegree,
          jobLabels: sampleJob.jobLabels,
          brandStageName: sampleJob.brandStageName,
          brandIndustry: sampleJob.brandIndustry,
          brandScaleName: sampleJob.brandScaleName,
          welfareList: sampleJob.welfareList,
          skills: sampleJob.skills,
          encryptBossId: sampleJob.encryptBossId,  // ← 关键：HR 加密 uid
        },
      ],
      totalCount: 1,
    },
  }
}

// ============================================================
// Feishu API mock
// ------------------------------------------------------------
// 用 feishu-schema.json 的 listRecords / updateRecord 真实响应形状
// ============================================================

// ============================================================
// Feishu API URL
// ------------------------------------------------------------
// listRecords 内部链：
//   1. getTenantToken() → POST /open-apis/auth/v3/tenant_access_token/internal
//   2. request('GET', '/bitable/v1/apps/{appToken}/tables/{tableId}/records?page_size=N')
//
// msw URL 必须完全匹配（含 query string）。用通配 path 让 msw 按 path 匹配，
// query string 通过 req.url.searchParams 验证。
// ============================================================
const FEISHU_BASE = 'https://open.feishu.cn/open-apis'
const FEISHU_TOKEN_URL = `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`
const FEISHU_BITABLE_RECORDS_URL = `${FEISHU_BASE}/bitable/v1/apps/appTok/tables/tblId/records`
const FEISHU_BITABLE_RECORD_URL = `${FEISHU_BASE}/bitable/v1/apps/appTok/tables/tblId/records/rec_test_001`

describe('searchJobs（端到端契约）', () => {
  it('真实 BOSS schema → searchJobs 正确解析 hrUid (extractHrUid from encryptBossId)', async () => {
    // 1. 拦 BOSS search API：返 boss-schema.json 的真实 sampleJob
    server.use(
      http.post(BOSS_SEARCH_URL, () => {
        return HttpResponse.json(buildBossJobListResponse())
      }),
    )

    // 2. 动态 import handler（不 mock 任何边界模块）
    const { searchJobs } = await import('../../src/browser/index.js')

    // 3. 构造最小 mock page（只支持 page.evaluate + page.goto + page.url）
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://www.zhipin.com/web/geek/recommend'),
      evaluate: vi.fn().mockImplementation(async (body: unknown) => {
        // searchJobs 用 page.evaluate 在浏览器上下文发 fetch
        // 我们直接调 Node fetch（同源策略：URL 形如 'https://www.zhipin.com/wapi/...'）
        const resp = await fetch(BOSS_SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        return await resp.json()
      }),
    }

    // 4. 调 searchJobs
    const jobs = await searchJobs(mockPage as any, '前端')

    // 5. 断言契约：从真实 BOSS schema 解析出 hrUid（encryptBossId 字段）
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.id).toBe(bossSchemaFixture.sampleJob.encryptJobId)
    expect(jobs[0]?.hrUid).toBe(bossSchemaFixture.sampleJob.encryptBossId)
    // 6. 关键断言：不是空字符串 / 不是 undefined（防止 GAP-B 又被改回去）
    expect(jobs[0]?.hrUid).toBeTruthy()
    expect(jobs[0]?.hrUid).not.toBe('')
  })
})

describe('runSyncCommand auto-greet（端到端契约）', () => {
  // ============================================================
  // 关键设计：要让 msw 拦住所有真实 HTTP 调用
  //   - listRecords (Feishu)
  //   - updateRecord (Feishu)
  //   - generateGreeting 内部调 fetchJobDetail (BOSS wapi) ← 这里要拦
  //   - runSendCommand 内部调 sendGreeting (BOSS friend/add) ← 这里要拦
  //
  // 因为这是集成测试，要跑真实 handler 链，只在 deps 注入最小边界：
  //   - loadConfig (env)
  //   - runSendCommand (browser session 太重)
  // ============================================================

  it('auto-greet 端到端：feishu listRecords → 拆字段 → runSendCommand（mock） → feishu updateRecord', async () => {
    // 1. Mock Feishu 全部调用链（token + list + update）
    server.use(
      // 1a. tenant_access_token（listRecords 内部必调）
      http.post(FEISHU_TOKEN_URL, () => {
        return HttpResponse.json({
          code: 0,
          msg: 'ok',
          tenant_access_token: 'mock-tenant-token',
          expire: 7200,
        })
      }),
      // 1b. listRecords
      http.get(FEISHU_BITABLE_RECORDS_URL, () => {
        return HttpResponse.json(feishuSchemaFixture.listRecords)
      }),
      // 1c. updateRecord — 两条记录都可能被 update（mock 全通用）
      http.put(
        `${FEISHU_BASE}/bitable/v1/apps/appTok/tables/tblId/records/:recordId`,
        () => {
          return HttpResponse.json(feishuSchemaFixture.updateRecord)
        },
      ),
    )

    // 3. 配置 mock loadConfig（静态 vi.mock 在文件顶部已完成）
    mockLoadConfig.mockReturnValue({
      feishu: { appId: 'cli_x', appSecret: 'sec_x', appToken: 'appTok', tableId: 'tblId' },
      llm: { provider: 'deepseek' as const },
      boss: {},
      browser: {},
    })
    mockRunSendCommand.mockResolvedValue({
      action: 'ok' as const,
      reason: '已打招呼',
    })

    // 4. 动态 import handler（静态 mock 已经生效）
    const { runSyncCommand } = await import('../../src/cli/handlers/sync-handler.js')

    // 5. 跑 auto-greet
    const generateGreetingMock = vi.fn().mockResolvedValue('Hi, 我对贵岗位很感兴趣')
    const result = await runSyncCommand(
      { mode: 'auto-greet', limit: 10 },
      { generateGreeting: generateGreetingMock },
    )

    // 6. 验证契约
    if (result.action !== 'auto-greet') {
      throw new Error(`expected auto-greet, got ${result.action}: ${JSON.stringify(result)}`)
    }
    // 3 条样本，2 条『待投递』被处理（rec_test_003 状态是『已沟通』，跳过）
    expect(result.total).toBe(2)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)

    // 7. 关键契约：runSendCommand 必须接收 BOSS_ID（不是 record_id） + lid/securityId + recordId
    // Sprint 2026-07-14 / ADR-0007：sync 路径用 PLACEHOLDER_LID/SID_TODO 等 Sprint C（飞书 schema 升级后）
    expect(mockRunSendCommand).toHaveBeenCalledTimes(2)
    expect(mockRunSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'boss_job_001',  // BOSS encryptJobId（不是 rec_test_001）
        lid: 'PLACEHOLDER_LID_TODO',
        securityId: 'PLACEHOLDER_SID_TODO',
        recordId: 'rec_test_001',  // Feishu record_id（writeback 用）
      }),
    )

    // 8. 验证 listRecords 被真调过（mock 命中）
    // 通过 msw server 状态推断（不强验证 mock 调用次数，避免脆）
    expect(result.formatted).toContain('✅ 成功:   2')
  })
})