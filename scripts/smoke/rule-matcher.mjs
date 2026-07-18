// ============================================================
// rule-matcher.mjs — Sprint Smoke 2
// ============================================================
// 契约：
//   matchRules(changedFiles, rulesPath, opts?) → { triggers, skipped }
//     - triggers: SmokeTrigger[]（传给 runner）
//     - skipped:  { ruleIndex, reason }[]（报告里提示用户手动跑）
//
// 匹配流程：
//   1. 加载 YAML（用 yaml 包）
//   2. 对每个 rule：
//      a. pattern glob 是否命中任一 changedFile？
//      b. required_for 精确文件（如果 rule 有）是否在 changedFiles？
//         - 是 → 强制触发
//         - 否 → 跳过此 rule
//      c. skip_when（如果 rule 有）→ 用 child_process.execSync 跑
//         - exit 0 → 跳过此 rule（环境就绪 → skip）
//         - exit 非 0 → 不 skip，继续
// ============================================================

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import YAML from 'yaml'

// ============================================================
// YAML 加载（用 yaml 包）
// ============================================================

/** 暴露给测试的 parser wrapper */
export function parseYamlSafe(rulesPath) {
  return YAML.parse(readFileSync(rulesPath, 'utf-8'))
}

// ============================================================
// 公开 API
// ============================================================

/**
 * @typedef {import('./smoke-agent-runner.mjs').SmokeTrigger} SmokeTrigger
 */

/**
 * @typedef {Object} MatchOptions
 * @property {(cmd: string) => number} [execSyncFn] - 可注入的 execSync（测试用）
 */

/**
 * @typedef {Object} MatchResult
 * @property {SmokeTrigger[]} triggers
 * @property {Array<{ ruleIndex: number; reason: string }>} skipped
 */

/**
 * 加载 rules.yaml + 匹配 changedFiles，返回要跑的 trigger 列表
 *
 * @param {string[]} changedFiles
 * @param {string} rulesPath
 * @param {MatchOptions} [opts]
 * @returns {MatchResult}
 */
export function matchRules(changedFiles, rulesPath, opts = {}) {
  const exec = opts.execSyncFn ?? defaultExecSync
  const rules = YAML.parse(readFileSync(rulesPath, 'utf-8'))
  const triggers = []
  const skipped = []

  for (let i = 0; i < (rules.rules ?? []).length; i++) {
    const rule = rules.rules[i]
    const pattern = rule.pattern
    if (!pattern) continue

    // 1. pattern glob 命中？
    const patternHits = changedFiles.some((f) => globMatch(pattern, f))
    if (!patternHits) continue

    // 2. required_for 精确匹配（如果 rule 有）
    if (rule.required_for) {
      const requiredFiles = Array.isArray(rule.required_for)
        ? rule.required_for
        : [rule.required_for]
      const hasRequired = requiredFiles.some((rf) => changedFiles.includes(rf))
      if (!hasRequired) continue
    }

    // 3. skip_when 评估（exit 0 → 跳过此 rule）
    if (rule.skip_when) {
      const exitCode = exec(rule.skip_when)
      if (exitCode === 0) {
        skipped.push({
          ruleIndex: i,
          reason: `skip_when satisfied: ${rule.skip_when}`,
        })
        continue
      }
    }

    // 4. 收集此 rule 的所有 trigger
    const ruleTriggers = rule.triggers ?? []
    for (const t of ruleTriggers) {
      triggers.push({
        id: t.id,
        command: t.command,
        timeout_sec: Number(t.timeout_sec ?? 60),
        reason: t.reason,
      })
    }
  }

  return { triggers, skipped }
}

/**
 * 简单 glob 匹配（picomatch 子集）
 *  - ** 匹配任意深度
 *  - * 匹配单层（不含 /）
 *  - 字面量匹配
 */
function globMatch(pattern, path) {
  const regexStr = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(path)
}

/**
 * 默认 execSync（用 node:child_process）
 */
function defaultExecSync(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' })
    return 0
  } catch (err) {
    return err.status ?? 1
  }
}