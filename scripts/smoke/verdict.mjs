// ============================================================
// verdict.mjs — Sprint Smoke 6 (verdict 重构)
// ============================================================
// 目的：把 pre-commit hook 的 verdict 决策树抽成独立模块
//
// 设计动机：
//   原 pre-commit.mjs 在顶层直接 main()（git 调用时跑），
//   vitest 静态 import 会触发副作用（污染测试环境）。
//   pre-commit.test.ts 只能用 spawn node -e 镜像 verdict 逻辑，
//   这是"假绿"反模式（测试与生产代码不一致）。
//
// 抽取策略：
//   - computeVerdict(results) 是纯函数（无副作用）
//   - pre-commit.mjs 改为 import 这个函数
//   - verdict.test.ts 直接 import 测真实实现
//
// BLOCK 关键词（硬契约 — 任一命中即 BLOCK commit）：
//   - encryptBossId.*missing      BOSS 抓取层硬契约
//   - encryptJobId.*missing       同上
//   - jobDetail.*0\s*\/\s*\d+     selector 命中 0%
//   - HR_UID.*not found           飞书表必填字段缺失
//   - FieldNameNotFound           飞书表字段名错
//
// 其他 failed / timeout → WARN（不阻塞 commit）
// ============================================================

// 硬契约关键词（与 pre-commit.mjs 原内嵌版本一致）
const HARD_CONTRACT_PATTERNS = [
  /encryptBossId.*missing/i,
  /encryptJobId.*missing/i,
  /jobDetail.*0\s*\/\s*\d+/i, // selector 命中 0%
  /HR_UID.*not found/i,
  /FieldNameNotFound/i,
]

/**
 * 根据 smoke agent 执行结果计算 verdict
 *
 * @param {Array<{
 *   id: string,
 *   status: 'passed' | 'failed' | 'timeout' | 'skipped',
 *   exitCode: number | null,
 *   stdout: string,
 *   stderr: string,
 *   duration_ms: number,
 *   error: string | null
 * }>} results
 * @returns {'OK' | 'WARN' | 'BLOCK'}
 */
export function computeVerdict(results) {
  let hasBlock = false
  let hasWarn = false

  for (const r of results) {
    if (r.status === 'passed') continue

    if (r.status === 'timeout') {
      // timeout 默认 warn（MVP 阶段：先全部 warn，后续细化）
      hasWarn = true
      continue
    }

    if (r.status === 'failed') {
      // 硬契约检测（关键词匹配 — stdout + stderr 都查）
      const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`
      const isHardContract = HARD_CONTRACT_PATTERNS.some((p) => p.test(combined))

      if (isHardContract) {
        hasBlock = true
      } else {
        hasWarn = true
      }
    }
    // 'skipped' 不影响 verdict（已经在 pre-commit 主流程里分开了）
  }

  if (hasBlock) return 'BLOCK'
  if (hasWarn) return 'WARN'
  return 'OK'
}