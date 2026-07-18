// ============================================================
// vitest 配置：明确覆盖率 include，让 B-1 业务层可见
// ============================================================
// Sprint Audit 修复：
//   之前默认 v8 reporter 的 include 不显示 src/feishu/ 和 src/template/
//   （虽然测试运行了，但表格里看不到这两个目录）
//   显式声明后能完整呈现 B-1 的覆盖率贡献
// ============================================================

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ============================================================
    // Sprint 2B Step B：集成测试全局 setup
    // ------------------------------------------------------------
    // - tests/integration/setup.ts 启动 msw server
    // - afterEach 强断言所有发出的请求都被 handler 匹配（未匹配 = fail）
    // - 单测（*.test.ts）也会加载 setup.ts，但单测不发 HTTP 所以无副作用
    // ============================================================
    setupFiles: ['./tests/integration/setup.ts'],
    // ============================================================
    // Sprint Smoke 1：smoke runner 测试在 scripts/ 下
    // ============================================================
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/.vitest-cache/**',
      ],
      // 显示每个文件（包括 0% 覆盖的文件）
      reportOnFailure: true,
      // 不设置 thresholds（避免 CI 失败，单独跑审计时再检查）
      thresholds: {
        // 当前不强制 100%，等补完 chrome-handler / cli/index 测试后再加
        // lines: 80,
        // branches: 70,
        // functions: 80,
        // statements: 80,
      },
    },
  },
})