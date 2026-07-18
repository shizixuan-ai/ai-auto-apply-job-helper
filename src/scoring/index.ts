// ============================================================
// scoring — Sprint 1A GREEN
// ============================================================
// 用 LLM 对 JD + 简历 做匹配度打分（0~1）
//
// 流程：
//   1. 构建 prompt（JD 截断 800 字 + 简历摘要）
//   2. 调 LLMAdapter.generate
//   3. 解析返回的 JSON
//   4. 校验 score 字段（number, 0~1）
//
// 错误处理：
//   - LLM 调用失败 → 透传（让 handler 计入 failed）
//   - LLM 返非 JSON → ScoreParseError
//   - LLM 返 JSON 但缺 score 字段 → ScoreParseError
//   - score 越界（<0 或 >1） → ScoreParseError
// ============================================================

import type { LLMAdapter } from '../llm/index.js'
import type { ResumeSummary } from '../types/index.js'

/** 评分结果 */
export interface ScoreResult {
  score: number
  reason: string
}

/** LLM 返回 JSON 解析失败 */
export class ScoreParseError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message)
    this.name = 'ScoreParseError'
  }
}

/** JD 截断长度（避免超 token） */
const JD_MAX_CHARS = 800
/** 简历 skills 截断数量 */
const SKILLS_MAX = 20
/** recentProjects 截断数量 */
const PROJECTS_MAX = 5

/**
 * 构建评分 prompt
 * 要求 LLM 严格返 JSON：{"score": 0.85, "reason": "..."}
 */
export function buildScorePrompt(jd: string, summary: ResumeSummary): string {
  const jdTruncated = jd.length > JD_MAX_CHARS ? jd.slice(0, JD_MAX_CHARS) + '…' : jd

  const skillsText = (summary.skills ?? []).slice(0, SKILLS_MAX).join('、') || '（无）'
  const projectsText = (summary.recentProjects ?? []).slice(0, PROJECTS_MAX).join('；') || '（无）'

  return `你是求职匹配度评估专家。请根据以下【岗位描述】和【候选人简历】，给出 0~1 之间的匹配分。

【评分标准】
- 0.9+：高度匹配，技能 + 经验 + 学历均吻合
- 0.7~0.9：基本匹配，主要技能吻合
- 0.5~0.7：部分匹配，有 1~2 项不吻合
- <0.5：不匹配

【岗位描述】（已截断）
${jdTruncated}

【候选人简历】
- 姓名：${summary.name ?? '未知'}
- 工作年限：${summary.yearsOfExperience ?? '未知'}
- 学历：${summary.education ?? '未知'}
- 技能：${skillsText}
- 近期项目：${projectsText}

【输出要求】
仅返回严格 JSON（不要 markdown 代码块、不要任何解释文字）：
{"score": 0.85, "reason": "一句话说明匹配或不匹配的关键原因"}`
}

/**
 * 解析 LLM 返回文本为 ScoreResult
 * 容忍：前后空白、markdown 代码块包裹（```json ... ```）
 */
export function parseScoreResponse(raw: string): ScoreResult {
  let text = raw.trim()

  // 去掉 markdown 代码块包裹
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    text = fenced[1]!.trim()
  }

  // 尝试 JSON.parse
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ScoreParseError('LLM 返回非 JSON', raw)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ScoreParseError('LLM 返回不是 JSON object', raw)
  }

  const obj = parsed as Record<string, unknown>
  const score = obj['score']
  const reason = obj['reason']

  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new ScoreParseError('LLM 返回 JSON 缺 score 字段或类型错误', raw)
  }

  if (score < 0 || score > 1) {
    throw new ScoreParseError(`score 越界（${score}，应在 0~1 之间）`, raw)
  }

  return {
    score,
    reason: typeof reason === 'string' ? reason : '',
  }
}

/**
 * 评分主入口
 * @throws ScoreParseError 解析失败
 * @throws 其他 LLM 调用错误（透传）
 */
export async function scoreJob(
  jd: string,
  summary: ResumeSummary,
  llm: LLMAdapter,
): Promise<number> {
  const prompt = buildScorePrompt(jd, summary)
  const raw = await llm.generate(prompt)
  const result = parseScoreResponse(raw)
  return result.score
}
