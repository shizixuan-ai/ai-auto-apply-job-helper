// ============================================================
// loadConfig — RED 测试 (Sprint 1D Phase 1 TDD Step 1)
// ============================================================
// 覆盖 ADR-0011 §6 行为契约 B3/B4/B6：
//   - R3 (B3): DEEPSEEK_API_KEY 存在 + LLM_API_KEY 未设 → throw
//   - R4 (B4): LLM_PROVIDER unset → provider = 'deepseek'（default 行为锁定）
//   - R6 (B6): 老 5 env 同时存在 → throw 一次性列全 5 个（不逐个报）
//
// TDD 状态：RED（实现未到位，期望 R3/R6 测试 fail，R4 已 PASS 作为契约锁定）
//
// Mock 策略：
//   - beforeEach/afterEach 保存/恢复 process.env（避免污染其他测试）
//   - 设置最小 feishu env（FEISHU_APP_ID/SECRET，loadConfig requireEnv 必需）
//   - LLM_* 4 env 用 vi.fn / 直接 process.env 设置（无 LLM 调用）
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from './index.js'

// ============================================================
// Env 隔离：每个测试保存 process.env，afterEach 恢复
// ============================================================

describe('loadConfig — LLM env 统一（Sprint 1D Phase 1, ADR-0011）', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    // loadConfig 依赖 FEISHU_APP_ID/SECRET（requireEnv）—— 最小集
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'secret_test'
  })

  afterEach(() => {
    process.env = savedEnv
  })

  // ----------------------------------------------------------
  // R4 (B4): LLM_PROVIDER unset → provider = 'deepseek'（契约锁定）
  // ----------------------------------------------------------
  // 说明：老代码 (process.env.LLM_PROVIDER ?? 'deepseek') 已实现此行为，
  //       本测试作为契约锁定，防止 Phase 2/3 误改 default。

  it('R4: LLM_PROVIDER unset → config.llm.provider === "deepseek"', () => {
    // Arrange: 清空 LLM_PROVIDER（确保 unset）
    delete process.env.LLM_PROVIDER
    // 新 4 env 都设（避免 R3/R6 老 env 检测干扰本测试）
    process.env.LLM_API_KEY = 'sk-new-test'
    process.env.LLM_BASE_URL = 'https://api.test.com/v1'
    process.env.LLM_MODEL = 'test-model'

    // Act
    const config = loadConfig()

    // Assert
    expect(config.llm.provider).toBe('deepseek')
  })

  // ----------------------------------------------------------
  // R3 (B3): DEEPSEEK_API_KEY 存在 + LLM_API_KEY 未设 → throw
  // ----------------------------------------------------------

  it('R3: DEEPSEEK_API_KEY 存在 + LLM_API_KEY 未设 → throw 含迁移提示', () => {
    // Arrange: 清空新 env + 设老 env
    delete process.env.LLM_API_KEY
    delete process.env.LLM_BASE_URL
    delete process.env.LLM_MODEL
    delete process.env.LLM_PROVIDER // default deepseek 不影响 R3
    process.env.DEEPSEEK_API_KEY = 'sk-old-deepseek'

    // Act + Assert: loadConfig 应 throw，错误信息含老 env 名 + 新 env 名
    expect(() => loadConfig()).toThrow(/DEEPSEEK_API_KEY[\s\S]*LLM_API_KEY/)
  })

  // ----------------------------------------------------------
  // R6 (B6): 老 5 env 同时存在 → throw 一次性列全 5 个
  // ----------------------------------------------------------
  // 说明：R6 验证 ADR §2.4 "同时多个老 env 存在 → 一次性列全，不逐个报错"
  //       用正则匹配错误信息是否同时含 5 个老 env 名

  it('R6: 老 5 env 同时存在 → throw 一次性列全 5 个（不逐个报）', () => {
    // Arrange: 清空新 env + 设全部 5 个老 env
    delete process.env.LLM_API_KEY
    delete process.env.LLM_BASE_URL
    delete process.env.LLM_MODEL
    delete process.env.LLM_PROVIDER
    process.env.DEEPSEEK_API_KEY = 'sk-old-ds'
    process.env.OPENAI_API_KEY = 'sk-old-oai'
    process.env.ANTHROPIC_API_KEY = 'sk-old-ant'
    process.env.OLLAMA_BASE_URL = 'http://old-ollama'
    process.env.OLLAMA_MODEL = 'old-llama3'

    // Act + Assert: 错误信息必须同时含 5 个老 env 名（顺序不强制）
    expect(() => loadConfig()).toThrow(
      /DEEPSEEK_API_KEY[\s\S]*OPENAI_API_KEY[\s\S]*ANTHROPIC_API_KEY[\s\S]*OLLAMA_BASE_URL[\s\S]*OLLAMA_MODEL/,
    )
  })
})

// ============================================================
// loadConfig — LLM_AUTH_STYLE（ADR-0013）
// ============================================================
// R14: LLM_AUTH_STYLE=bearer → config.llm.authStyle === 'bearer'
// R15: LLM_AUTH_STYLE=非法值 → throw "仅支持 'x-api-key' | 'bearer'"
// R16: LLM_AUTH_STYLE unset → config.llm.authStyle === 'bearer'（默认）
// ============================================================

describe('loadConfig — LLM_AUTH_STYLE（ADR-0013）', () => {
  beforeEach(() => {
    // 最小 feishu env（loadConfig requireEnv 必需）
    process.env.FEISHU_APP_ID = 'cli_test'
    process.env.FEISHU_APP_SECRET = 'secret_test'
    // 清掉本组关心的 env,避免其他测试残留
    delete process.env.LLM_AUTH_STYLE
    delete process.env.LLM_API_KEY
  })

  afterEach(() => {
    delete process.env.LLM_AUTH_STYLE
  })

  it('R14: LLM_AUTH_STYLE=bearer → config.llm.authStyle === "bearer"', () => {
    process.env.LLM_AUTH_STYLE = 'bearer'
    const config = loadConfig()
    expect(config.llm.authStyle).toBe('bearer')
  })

  it('R14: LLM_AUTH_STYLE=x-api-key → config.llm.authStyle === "x-api-key"', () => {
    process.env.LLM_AUTH_STYLE = 'x-api-key'
    const config = loadConfig()
    expect(config.llm.authStyle).toBe('x-api-key')
  })

  it('R15: LLM_AUTH_STYLE=garbage → throw 含"仅支持" + 列表', () => {
    process.env.LLM_AUTH_STYLE = 'bearer-x'
    expect(() => loadConfig()).toThrow(/LLM_AUTH_STYLE.*仅支持.*x-api-key.*bearer/)
  })

  it('R16: LLM_AUTH_STYLE unset → config.llm.authStyle === "bearer"（默认）', () => {
    // 不设 LLM_AUTH_STYLE
    const config = loadConfig()
    expect(config.llm.authStyle).toBe('bearer')
  })
})