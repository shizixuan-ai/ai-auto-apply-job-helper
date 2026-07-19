// ============================================================
// scoring — Sprint 1C GREEN（6 维加权评分 + 智能重试）
// ============================================================
// 用 LLM 对 JD + 简历 做 6 维加权评分（总分 0-1）
//
// 流程：
//   1. 构建 prompt（6 维 rubric + JD 截断 800 字 + 简历摘要）
//   2. 调 LLMAdapter.generate（callLLMWithRetry 包装，最多 2 次）
//   3. 解析 6 维 JSON（含 markdown 容错 + 前后空白 trim）
//      - 缺维度/null 维度 → 部分降级（默认 0.5 + "维度解析失败"）
//      - score 类型错/NaN/Infinity → ScoreParseError（不重试）
//      - score 越界 (<0 或 >1) → ScoreParseError（不重试）
//   4. 本地重算 totalScore（trust local arithmetic，忽略 LLM 的 totalScore 字段）
//
// 错误处理（智能分类）：
//   - LLM 调用错误（网络/API 抛错） → 重试 1 次后透传
//   - ScoreParseError（JSON 错/类型错/越界） → 不重试（重试也是同样脏数据）
// ============================================================

import type { LLMAdapter } from '../llm/index.js'
import type {
  ResumeSummary,
  ScoreDimensions,
  ScoreResult,
  ScoreWeights,
} from '../types/index.js'
import { computeWeightedTotal, DEFAULT_WEIGHTS } from './dimensions.js'

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

/** 6 维名称（强制 as const 保证 literal type） */
const DIMENSION_KEYS = [
  'education',
  'experience',
  'skill',
  'project',
  'stability',
  'potential',
] as const
type DimensionKey = (typeof DIMENSION_KEYS)[number]

/** 6 维中文名（用于 prompt + 校验错误） */
const DIMENSION_LABELS: Record<DimensionKey, string> = {
  education: '学历匹配',
  experience: '经验相关',
  skill: '技能契合',
  project: '项目深度',
  stability: '稳定性',
  potential: '综合潜力',
}

/**
 * 调用 LLM 失败时重试 1 次（仅重试 LLM 调用本身，不重试 parseScoreResponse 的业务错误）
 *
 * 智能分类：
 *   - llm.generate() 抛错（网络/API/超时） → 重试 1 次
 *   - ScoreParseError → 由 scoreJob 直接抛，不进入此函数
 */
async function callLLMWithRetry(prompt: string, llm: LLMAdapter): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await llm.generate(prompt)
    } catch (err) {
      lastErr = err
    }
  }
  // 2 次都失败，抛最后一次的错误
  throw lastErr
}

/**
 * 构建 6 维评分 prompt
 * 要求 LLM 严格返 JSON（含 totalScore + totalReason + 6 维 detail）
 */
export function buildScorePrompt(
  jd: string,
  summary: ResumeSummary,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): string {
  const jdTruncated = jd.length > JD_MAX_CHARS ? jd.slice(0, JD_MAX_CHARS) + '…' : jd

  const skillsText = (summary.skills ?? []).slice(0, SKILLS_MAX).join('、') || '（无）'
  const projectsText = (summary.recentProjects ?? []).slice(0, PROJECTS_MAX).join('；') || '（无）'

  const isEliteText =
    summary.isElite === undefined ? '未知' : summary.isElite ? '是' : '否'
  const isBigTechText =
    summary.isBigTech === undefined ? '未知' : summary.isBigTech ? '是' : '否'

  return `你是求职匹配度评估专家。请根据【岗位描述】和【候选人简历】，从 6 个维度分别评估（每个维度 0~1 之间的分数），然后给出 1 个加权总分（0~1）和 1 句话总结。

【6 个评估维度及权重】
- 学历匹配（权重 ${(weights.education * 100).toFixed(0)}%）：学校层次 + 专业相关性 + 是否 985/211
- 经验相关（权重 ${(weights.experience * 100).toFixed(0)}%）：工作年限 + 行业相关性 + 职位层级
- 技能契合（权重 ${(weights.skill * 100).toFixed(0)}%）：JD 要求技能 vs 候选人技能的覆盖度
- 项目深度（权重 ${(weights.project * 100).toFixed(0)}%）：近期项目的复杂度、规模、影响力
- 稳定性（权重 ${(weights.stability * 100).toFixed(0)}%）：跳槽频率 + 在职时长
- 综合潜力（权重 ${(weights.potential * 100).toFixed(0)}%）：成长性 + 学习能力 + 管理潜力

【岗位描述】（已截断）
${jdTruncated}

【候选人简历】
- 姓名：${summary.name ?? '未知'}
- 工作年限：${summary.yearsOfExperience ?? '未知'}
- 学历：${summary.degree ?? '未知'} ${summary.school ?? ''}
- 是否 985/211：${isEliteText}
- 是否大厂背景：${isBigTechText}
- 技能：${skillsText}
- 近期项目：${projectsText}

【输出要求】
仅返回严格 JSON（不要 markdown 代码块、不要任何解释文字），字段名严格一致：
{
  "education":   { "score": 0.85, "reason": "一句话理由" },
  "experience":  { "score": 0.90, "reason": "一句话理由" },
  "skill":       { "score": 0.75, "reason": "一句话理由" },
  "project":     { "score": 0.80, "reason": "一句话理由" },
  "stability":   { "score": 0.70, "reason": "一句话理由" },
  "potential":   { "score": 0.80, "reason": "一句话理由" },
  "totalScore":  0.82,
  "totalReason": "一句话总结匹配或不匹配的关键原因"
}`
}

/**
 * 解析 6 维 ScoreDimensions
 * 容忍：缺维度 / null 维度 → 降级为 0.5
 * 严格：score 类型错 / NaN / Infinity / 越界 → 抛 ScoreParseError
 */
function parseDimensions(parsed: Record<string, unknown>): ScoreDimensions {
  const result = {} as Record<DimensionKey, { score: number; reason: string }>

  for (const key of DIMENSION_KEYS) {
    const dim = parsed[key]

    // 缺维度 / null → 部分降级
    if (dim === undefined || dim === null) {
      result[key] = { score: 0.5, reason: '维度解析失败' }
      continue
    }

    // 必须是对象
    if (typeof dim !== 'object' || Array.isArray(dim)) {
      throw new ScoreParseError(`LLM 返回的 ${DIMENSION_LABELS[key]} 不是对象`)
    }

    const obj = dim as Record<string, unknown>
    const score = obj['score']
    const reason = obj['reason']

    // score 类型 + 有限性校验
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new ScoreParseError(
        `LLM 返回的 ${DIMENSION_LABELS[key]}.score 缺失或类型错误`,
      )
    }

    // score 范围校验
    if (score < 0 || score > 1) {
      throw new ScoreParseError(
        `LLM 返回的 ${DIMENSION_LABELS[key]}.score 越界（${score}，应在 0~1 之间）`,
      )
    }

    result[key] = {
      score,
      reason: typeof reason === 'string' ? reason : '',
    }
  }

  return result as ScoreDimensions
}

/**
 * 解析 LLM 返回文本为 ScoreResult
 *
 * 容忍：前后空白、markdown ```json ... ``` 包裹
 * 严格：JSON.parse 失败、JSON 不是 object、任一维度 score 越界 → 抛 ScoreParseError
 * 降级：单维缺失/null → 默认 0.5
 * trust local：totalScore 本地重算，忽略 LLM 的 totalScore 字段（防 LLM 算错）
 */
export function parseScoreResponse(
  raw: string,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreResult {
  let text = raw.trim()

  // 去掉 markdown 代码块包裹
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    text = fenced[1]!.trim()
  }

  // JSON.parse
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ScoreParseError('LLM 返回非 JSON', raw)
  }

  // 必须是 object（排除 array、string、number、null）
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ScoreParseError('LLM 返回不是 JSON object', raw)
  }

  const obj = parsed as Record<string, unknown>

  // 6 维解析
  const dimensions = parseDimensions(obj)

  // totalReason（类型错时默认空串）
  const totalReason =
    typeof obj['totalReason'] === 'string' ? obj['totalReason'] : ''

  // 本地重算 totalScore（trust local arithmetic）
  const totalScore = computeWeightedTotal(dimensions, weights)

  return { totalScore, totalReason, dimensions }
}

/**
 * 评分主入口
 *
 * @throws ScoreParseError 解析失败（**不重试** — 重试也是同样脏数据）
 * @throws LLM 调用错误（网络/API）— 重试 1 次后透传
 */
export async function scoreJob(
  jd: string,
  summary: ResumeSummary,
  llm: LLMAdapter,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): Promise<ScoreResult> {
  const prompt = buildScorePrompt(jd, summary, weights)
  const raw = await callLLMWithRetry(prompt, llm) // LLM 错误重试 1 次
  return parseScoreResponse(raw, weights) // 业务错误不重试
}
