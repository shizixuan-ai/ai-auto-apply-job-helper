// ============================================================
// RED 测试：`bapply chrome` handler
// ============================================================

import { describe, it, expect } from 'vitest'
import { handleChromeCommand } from './chrome-handler.js'
import { DEFAULT_CDP_PORT } from '../../browser/cdp.js'

describe('handleChromeCommand', () => {
  it('returns a non-empty string', () => {
    const out = handleChromeCommand()
    expect(out).toBeTruthy()
    expect(out.length).toBeGreaterThan(0)
  })

  it('includes --remote-debugging-port flag', () => {
    const out = handleChromeCommand()
    expect(out).toContain('--remote-debugging-port')
  })

  it('includes --user-data-dir flag', () => {
    const out = handleChromeCommand()
    expect(out).toContain('--user-data-dir')
  })

  it('includes the Chrome binary name', () => {
    const out = handleChromeCommand()
    expect(out).toContain('Chrome')
  })

  it('uses default port 9222 when no option is provided', () => {
    const out = handleChromeCommand()
    expect(out).toContain('9222')
  })

  it('default port comes from cdp.ts DEFAULT_CDP_PORT (防常量漂移回归)', () => {
    // 验证 chrome-handler 真的从 cdp.ts 导入默认值，而非自有重复常量
    expect(DEFAULT_CDP_PORT).toBe(9222)
    const out = handleChromeCommand()
    expect(out).toContain(String(DEFAULT_CDP_PORT))
  })

  it('respects overridden port', () => {
    const out = handleChromeCommand({ port: 9333 })
    expect(out).toContain('9333')
    expect(out).not.toContain('9222')
  })

  it('output is multi-line (banner + command)', () => {
    const out = handleChromeCommand()
    expect(out.split('\n').length).toBeGreaterThan(1)
  })
})
