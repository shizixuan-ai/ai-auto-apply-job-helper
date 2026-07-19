// ============================================================
// yaml-parser — Sprint 1B GREEN
// ============================================================
// 从本地 YAML 文件解析简历（强切自 Sprint 1A 的 md-fallback）
//
// 格式约定（docs/adr/0009-resume-yaml-format.md 详细）：
//   基础信息:        姓名 (required) + 性别/年龄/手机号/邮箱 (optional)
//   求职意向:        目标岗位 (optional)
//   教育背景:        毕业院校/学历层次/专业名称 (optional block)
//   是否985_211:    required boolean (顶层)
//   工作经历:        工作年限 (required) + 是否大厂背景 (required) + 经历 (optional array of objects)
//   技能清单:        required, min 1
//   自我介绍:        optional 多行块
//
// 校验库：Zod 3.24
// 错误类型：
//   - ResumeNotFoundError：文件不存在
//   - IncompleteResumeError：缺必填字段
//   - ResumeParseError：YAML 语法错 / schema 类型错
//
// 设计决策（与 md-fallback 区别）：
//   - 使用 `yaml` 包（不是 `js-yaml`）— 更现代，YAML 1.2 严格规范
//   - 推断字段（是否985_211/是否大厂背景）由候选人手填，不代码推
//   - 工作经历.经历是 array of objects（公司/时间段/职位/描述）
//     → 拍平时转字符串数组："{公司} - {时间段} - {职位} - {描述}"
//   - 空字符串手机号/邮箱 → undefined（避免下游 falsy 检查被 "" 干扰）
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { ResumeSummary } from '../types/index.js'

/** 默认简历路径（项目根 简历.yml） */
export const DEFAULT_RESUME_YML_PATH = '简历.yml'

// ============================================================
// 错误类型
// ============================================================

/** 简历 YAML 文件不存在 */
export class ResumeNotFoundError extends Error {
  constructor(path: string) {
    super(`简历文件不存在：${path}（请创建 简历.yml）`)
    this.name = 'ResumeNotFoundError'
  }
}

/** 简历 YAML 缺少必填字段（姓名 / 工作年限 / 技能清单 / 是否985_211 / 是否大厂背景） */
export class IncompleteResumeError extends Error {
  readonly missing: string[]
  constructor(missing: string[]) {
    super(
      `简历缺少必填字段：${missing.join('、')}（至少需要 姓名 + 工作年限 + 技能清单 + 是否985_211 + 是否大厂背景）`,
    )
    this.name = 'IncompleteResumeError'
    this.missing = missing
  }
}

/** YAML 语法错 / schema 类型错（与 Incomplete 区分：缺字段是用户漏填，类型错是数据格式不对） */
export class ResumeParseError extends Error {
  readonly raw?: string
  constructor(message: string, raw?: string) {
    super(message)
    this.name = 'ResumeParseError'
    this.raw = raw
  }
}

// ============================================================
// Zod schema
// ============================================================

/** 工作经历单条：{ 公司, 时间段, 职位, 描述 } */
const WorkHistoryItemSchema = z.object({
  公司: z.string().min(1),
  时间段: z.string(),
  职位: z.string().min(1),
  描述: z.string(),
})

/** 简历 YAML 完整 schema */
const ResumeYamlSchema = z.object({
  基础信息: z.object({
    姓名: z.string().min(1),                                  // required
    性别: z.enum(['男', '女', '未知']).optional(),
    年龄: z.number().int().positive().optional(),
    手机号: z.string().optional(),                             // 拍平时空串 → undefined
    邮箱: z.string().optional(),                               // 拍平时空串 → undefined
  }),
  求职意向: z
    .object({
      目标岗位: z.string().optional(),
    })
    .optional(),
  教育背景: z
    .object({
      毕业院校: z.string().optional(),
      学历层次: z.enum(['本科', '硕士', '博士', '其他']).optional(),
      专业名称: z.string().optional(),
    })
    .optional(),
  是否985_211: z.boolean(),                                    // 顶层 required
  工作经历: z.object({
    工作年限: z.number().int().nonnegative(),                  // required
    是否大厂背景: z.boolean(),                                 // required
    经历: z.array(WorkHistoryItemSchema).optional(),           // optional array of objects
  }),
  技能清单: z.array(z.string()).min(1),                        // required, min 1
  自我介绍: z.string().optional(),                             // optional 多行块
})

// ============================================================
// 纯函数：parseResumeYaml（不读盘，便于单测）
// ============================================================

/**
 * 解析 YAML 字符串为 ResumeSummary
 * @throws ResumeParseError YAML 语法错或 schema 类型错
 * @throws IncompleteResumeError 缺必填字段
 */
export function parseResumeYaml(content: string): ResumeSummary {
  // 1) YAML 解析
  let raw: unknown
  try {
    raw = parseYaml(content)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ResumeParseError(`YAML 语法错误：${msg}`, content)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ResumeParseError('YAML 顶层必须是 mapping（对象）', content)
  }

  // 2) Zod schema 校验
  const result = ResumeYamlSchema.safeParse(raw)
  if (!result.success) {
    // 区分：缺必填（incomplete）vs 类型错（parse error）
    const missing: string[] = []
    const typeErrors: string[] = []
    for (const issue of result.error.issues) {
      // Zod v3 标记必填字段缺失的标志：code='invalid_type' + received='undefined'
      if (
        issue.code === 'invalid_type' &&
        (issue as { received?: unknown }).received === 'undefined'
      ) {
        // 取 path 最后一段作为用户友好的字段名
        const lastSeg = issue.path[issue.path.length - 1] ?? '(root)'
        missing.push(String(lastSeg))
      } else {
        const path = issue.path.join('.')
        typeErrors.push(`${path}: ${issue.message}`)
      }
    }
    if (missing.length > 0) {
      throw new IncompleteResumeError(missing)
    }
    throw new ResumeParseError(
      `schema 校验失败：${typeErrors.join('; ')}`,
      content,
    )
  }

  // 3) 拍平到 ResumeSummary
  return flatten(result.data)
}

/** 拍平函数：YAML 嵌套结构 → 扁平的 ResumeSummary */
function flatten(yaml: z.infer<typeof ResumeYamlSchema>): ResumeSummary {
  // 工作经历.经历 array of objects → recentProjects 字符串数组
  // 格式："{公司} - {时间段} - {职位} - {描述}"（用于搜索结果显示，不破坏 ResumeSummary.recentProjects 的 string[] 形状）
  const recentProjects = (yaml.工作经历.经历 ?? []).map(
    (it) => `${it.公司} - ${it.时间段} - ${it.职位} - ${it.描述}`,
  )

  return {
    name: yaml.基础信息.姓名,
    gender: yaml.基础信息.性别,
    age: yaml.基础信息.年龄,
    // 空字符串 → undefined（避免下游 falsy 检查被 "" 干扰，比如 `if (email)` 在 "" 时为 false）
    phone: yaml.基础信息.手机号 || undefined,
    email: yaml.基础信息.邮箱 || undefined,
    targetRole: yaml.求职意向?.目标岗位 || undefined,
    school: yaml.教育背景?.毕业院校 || undefined,
    degree: yaml.教育背景?.学历层次,
    major: yaml.教育背景?.专业名称 || undefined,
    isElite: yaml.是否985_211,
    yearsOfExperience: yaml.工作经历.工作年限,
    isBigTech: yaml.工作经历.是否大厂背景,
    recentProjects,
    skills: yaml.技能清单,
    // 自我介绍 YAML `|` 块会带 trailing newline，trim 掉
    workSummary: yaml.自我介绍?.trim() || undefined,
  }
}

// ============================================================
// 入口：读盘 + 解析
// ============================================================

/**
 * 读指定路径的 YAML 简历并解析
 * @throws ResumeNotFoundError 文件不存在
 * @throws ResumeParseError YAML 语法错 / schema 类型错
 * @throws IncompleteResumeError 缺必填字段
 */
export function readResumeYaml(path: string = DEFAULT_RESUME_YML_PATH): ResumeSummary {
  if (!existsSync(path)) {
    throw new ResumeNotFoundError(path)
  }
  const content = readFileSync(path, 'utf8')
  return parseResumeYaml(content)
}
