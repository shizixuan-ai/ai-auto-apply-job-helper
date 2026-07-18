// ============================================================
// 集成测试基础设施（Sprint 2B Step B）
// ============================================================
// 用途：
//   - 用 msw 拦截 BOSS / Feishu API 真实请求（不发到 zhipin.com）
//   - afterEach 强断言：所有发出的请求都必须被 handler 匹配（未匹配 = 0）
//     → 防止假绿（mock 没拦到但测试还绿）
//   - 用 setupServer（不是 setupWorker）—— Node 环境不需要 Service Worker
//
// 设计原则：
//   - 不引入新依赖在产品代码（msw 仅 devDependency）
//   - 每个测试文件 import 此 setup，单例 server（listen/unlisten 在 file 全局）
//   - 用 vitest 的 beforeAll/afterAll/afterEach hooks
// ============================================================

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll } from 'vitest'

// 共享 server（test file 间复用，避免重复 listen/unlisten 浪费）
export const server = setupServer()

beforeAll(() => {
  server.listen({
    // 不要 warn unhandled requests（afterEach 会强断言，未匹配 = fail）
    onUnhandledRequest: 'error',
  })
})

afterEach(() => {
  // 关键：每个测试结束清理 handler，防止泄漏到下一个测试
  server.resetHandlers()
})

afterAll(() => {
  server.close()
})

/**
 * 工具：动态添加 handler（per-test 用）
 *
 * 用法：
 *   import { server } from './setup.js'
 *   import { http, HttpResponse } from 'msw'
 *
 *   server.use(
 *     http.post('https://www.zhipin.com/wapi/zpgeek/search/joblist.json', () => {
 *       return HttpResponse.json({ code: 0, zpData: { jobList: [...] } })
 *     }),
 *   )
 */