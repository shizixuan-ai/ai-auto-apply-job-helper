// ============================================================
// cookie-path.test.ts — Sprint E-3.x — Q3a B 决策
// ============================================================
// 行为契约 (per grill-me Q3a B):
//   - getCookiePath() 返回 cwd 相对 ".bapply-state/cookies.json"
//   - 与 T11 (config-loader cwd 相对 ./auto.yaml) + T12 (init-config cwd 相对)
//     + T13/T14 (counter/accountMeta cwd 相对 .bapply-state) 模式一致
//   - 替代原 const COOKIE_PATH = '~/.bapply/cookies.json' (Q3a B 改 cwd 相对)
//
// TDD 状态: RED (src 未改, getCookiePath 还未导出, src 仍用 const COOKIE_PATH + os.homedir)

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'

describe('getCookiePath — Q3a B 决策 (cwd 相对 .bapply-state/cookies.json)', () => {
  it('T15: getCookiePath() 返回 path.join(process.cwd(), ".bapply-state/cookies.json")', async () => {
    // Act: 调 getCookiePath
    const { getCookiePath } = await import('../../../src/browser/index.js')
    const actual = getCookiePath()

    // Assert: 期望 cwd 相对 .bapply-state/cookies.json
    const expected = path.join(process.cwd(), '.bapply-state/cookies.json')
    expect(actual).toBe(expected)
  })
})
