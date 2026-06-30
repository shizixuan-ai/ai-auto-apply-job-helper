// ============================================================
// RED 测试：`bapply chrome` handler
// ============================================================

import { describe, it, expect } from 'vitest'
import { handleChromeCommand } from './chrome-handler.js'

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
