# ADR-0009: 简历格式从 MD 强切到 YAML + 15 字段扩展

> **状态**：已实施
> **作者**：AI + user（2026-07-19）
> **日期**：2026-07-19
> **关联**：Sprint 1B（前置 ADR-0004/0006 均为业务相关，本 ADR 单独立）
> **纪律**：按 `~/.claude/CLAUDE.md` §3.5 4 类图前置 + §3.9 错误传播图 + §3.10 refactor checklist

---

## 1. 背景与目标

Sprint 1A 用 简历.md（H2 分段）解析简历，只支持 5 字段。Sprint 1B 计划扩到 15 字段（含推断字段：是否 985/211、是否大厂背景）。

**问题**：
- 14 字段在 MD 里太密，视觉信息密度低
- 推断字段（"是否 985/211"）在 MD 中没有自然表达位置（"## 是否985/211" 段语义污染：这是工具判断不是简历事实）
- 嵌套结构（工作经历：多公司/时间段/职位/描述）MD 表达痛苦
- 校验靠 parser 猜类型，无 schema 保护

**目标**：
- 切换到结构化格式（YAML）
- 扩到 15 字段
- 推断字段由候选人手填（不代码推）
- 强切（无 fallback）简化代码路径
- 提供一次性迁移工具

---

## 2. 决策（Decision）

**采用方案 A：YAML 1.2 + Zod schema + 15 字段 + 推断字段手填 + 强切无 fallback。**

具体：
- 文件名 `简历.yml`（项目根）
- 解析库：`yaml` npm 包（YAML 1.2 严格规范，已在 deps）
- 校验库：`zod` 3.24.3（已在 deps）
- 字段：15 个（5 旧 + 10 新）
- `是否985_211` / `是否大厂背景`：必填 boolean（候选人最清楚自己）
- 工作经历：array of objects（公司/时间段/职位/描述）
- **简历来源：仅 `简历.yml`**（**不接入 BOSS API 补充**——避免 1A 路线引入额外复杂度；候选人手填全部数据，包括推断字段）
- 强切：删除 `md-fallback.ts` + 老测试 + `简历.md`，resolver 只走 yaml 路径
- 一次性迁移工具：`scripts/migrate-resume-md-to-yml.mjs`

---

## 3. 证据（已验证假设 / 必填）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | `yaml` 包能解析多行 `\|` 块（自我介绍） | 12/12 yaml-parser.test.ts PASS（含 `workSummary: '7 年 Java 后端。'` trim 测试）| vitest |
| H2 | Zod `received: 'undefined'` 标记必填字段缺失 | TEST 3-7 缺必填测试全 PASS（5 个 `IncompleteResumeError` 抛出）| vitest |
| H3 | YAML schema 能区分"缺字段"和"类型错"两类错误 | `parseResumeYaml` 内 `safeParse` 遍历 `issue.code === 'invalid_type' && received === 'undefined'` 分类 → Incomplete vs ParseError | vitest TEST 8 BROKEN_YAML → ResumeParseError |
| H4 | 强切不会破坏其他模块 | `vitest run` 全套 424/424 PASS（仅 1 skip，预存在）| `npx vitest run` 2026-07-19 |
| H5 | tsc 不会因类型扩展引入新错 | `npx tsc --noEmit` 仅 1 错：`puppeteer-extra-plugin-stealth` 类型缺失（**预存在**，与本 ADR 无关）| tsc 2026-07-19 |
| H6 | 迁移工具端到端可工作 | 用临时 简历.md 跑 `scripts/migrate-resume-md-to-yml.mjs` → 生成 简历.yml → yaml.parse 校验通过 → 删除 简历.md | 手动实测 |

---

## 4. 反例（已证伪假设 / 必填）

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | 继续用 MD，只在 14 字段上加 H2 段 | "是否 985/211" 段语义污染（这是工具判断不是简历事实）；14 段太密，视觉信息密度低 | 决策讨论（2026-07-19），用户明确选 YAML |
| E2 | JSON 格式 | 14 字段写出来繁琐（每行带引号逗号）；git diff 整行漂移（PR review 体验差）；无注释（"为啥年龄没填"无法标注）| 决策讨论（2026-07-19）|
| E3 | 推断字段由 LLM 推 | LLM 推"是否大厂"会幻觉（小米/华为/比亚迪算不算？边界模糊）→ 不可控；规则化查表用户可控、可单测、可审计 | 决策讨论（2026-07-19），用户明确选"yml 中手填" |
| E4 | 双格式共存（md + yml）| 强切简化代码路径（无 fallback 分支）；现有用户少（1A 上线时间短）| 决策讨论（2026-07-19）|
| E5 | 工作经历保持 string[]（不做 array of objects）| 失去嵌套结构（公司/时间段/职位/描述 不可独立表达）；6 维评分的"稳定性指标"无法推 | 决策讨论（2026-07-19），用户选"数组 of 对象（推荐）"|

---

## 5. 备选方案（取舍 / 必填）

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **A. YAML 1.2 + Zod + 15 字段 + 强切（本方案）** | 人类可读 + 注释 + 嵌套 + 推断字段表达自然 + git diff 友好 + schema 校验 | 需迁移 + 强切不可逆 | ✓ |
| B. JSON + Zod | 类型安全 + 生态最熟 | 每天手写 JSON 烦、git diff 乱、无注释 | ✗ |
| C. 继续 MD + 14 字段 | 零迁移 | 推断字段语义污染、视觉信息密度低 | ✗ |
| D. YAML + 双格式共存 | 渐进迁移 | 代码路径复杂（resolver 双分支）、测试矩阵 2 倍 | ✗ 强切已能覆盖 |

---

## 6. 行为契约（可证伪 / 必填）

- ✓ **[已实测通过]**：`readResumeYaml` 读 简历.yml → 拍平到 15 字段 ResumeSummary —— 12/12 yaml-parser.test.ts PASS
- ✓ **[已实测通过]**：缺 基础信息.姓名 → 抛 IncompleteResumeError（`missing: ['姓名']`）—— TEST 3 PASS
- ✓ **[已实测通过]**：YAML 语法错 → 抛 ResumeParseError —— TEST 8 PASS
- ✓ **[已实测通过]**：工作经历.经历 array of objects → recentProjects 字符串数组（`"{公司} - {时间段} - {职位} - {描述}"`）—— TEST 10 PASS
- ✓ **[已实测通过]**：空手机号/邮箱 → undefined（不是 `""`）—— TEST 11 PASS
- ✓ **[已实测通过]**：全套 vitest 424/424 PASS（无新失败）—— 2026-07-19
- ✗ **[不在本 ADR 范围]**：6 维加权评分（拆 Sprint 1C）
- ✗ **[不在本 ADR 范围]**：BOSS API 补充简历字段（拆 Sprint 1D）

---

## 7. 4 类图（必填 / ASCII）

### 7.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│  src/cli/index.ts (CLI 入口 — bapply search --write)        │
│  └─ runSearchAndWrite(opts, deps)                           │
└──────────────────┬──────────────────────────────────────────┘
                   │ deps.resolveResume()
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  src/resume/resolver.ts                                     │
│  └─ resolveResume() → readResumeYaml('简历.yml')            │
└──────────────────┬──────────────────────────────────────────┘
                   │ 返 ResumeSummary（15 字段）
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  src/resume/yaml-parser.ts                                  │
│  └─ readFileSync('简历.yml')                                │
│  └─ yaml.parse() (YAML 1.2)                                 │
│  └─ Zod schema 校验                                         │
│  └─ flatten() 拍平到 ResumeSummary                          │
└──────────────────┬──────────────────────────────────────────┘
                   │ 抛错 → ResumeNotFoundError / IncompleteResumeError / ResumeParseError
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  ResumeSummary（types/index.ts 扩展到 15 字段）              │
│  → 传给 scoring/index.ts 的 scoreJob(jd, summary, llm)      │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 时序图

```
CLI            resolver        yaml-parser       Zod         scoring
 │                │                │                │             │
 │--resolve()--->│                │                │             │
 │                │--existsSync──>│                │             │
 │                │--readFileSync>│                │             │
 │                │                │--yaml.parse──>│             │
 │                │                │--safeParse──> │             │
 │                │                │  抛 IncompleteResumeError ──→ │
 │                │<─ResumeSummary(15 字段)───────  │             │
 │<─ResumeResolution(source:'yaml')──             │             │
 │                │                │                │             │
 │                │────────────────────────────────────scoreJob──>│
```

### 7.3 关系图

```
┌────────────────────────┐
│ ResumeSummary（15 字段）│   ← 所有字段 optional（defensive）
└────────────────────────┘
       ▲
       │ 直接读（手填）
       │
┌──────┴─────┐
│ 简历.yml   │
│ (YAML 1.2) │
└────────────┘

字段依赖（手填，无代码推断）：
  必填 (5)：name / 工作年限 / 技能清单 / 是否985_211 / 是否大厂背景
  optional (10)：gender / age / phone / email / targetRole /
                 school / degree / major / recentProjects / workSummary
```

### 7.4 流程图

```
                简历.yml 存在？
                     │
              ┌──────┴──────┐
              ▼             │
            是              否
              │             │
              ▼             ▼
        yaml.parse    ResumeNotFoundError
              │             (CLI 退出)
              ▼
        Zod safeParse
              │
       ┌──────┴──────┐
       ▼             ▼
    成功          失败
       │             │
       ▼             ├─ 缺必填 → IncompleteResumeError
  拍平 + 经验检查    │
       │             └─ 类型错 → ResumeParseError
       ▼
  返 ResumeSummary(15 字段)
       │
       ▼
  传给 scoreJob(jd, summary, llm)
```

### 7.5 错误传播图（§3.9）

```
[op1: existsSync('简历.yml')]
      │
      ├─ true ─→ [op2: readFileSync]
      │              │
      │              ├─ ok ─→ [op3: yaml.parse]
      │              │           │
      │              │           ├─ ok ─→ [op4: Zod safeParse]
      │              │           │           │
      │              │           │           ├─ ok ─→ [op5: flatten]
      │              │           │           │           │
      │              │           │           │           ▼
      │              │           │           │      [op6: 返 ResumeSummary] ─→ 传 scoring
      │              │           │           │
      │              │           │           ├─ throw invalid_type(received=undefined) ──→ IncompleteResumeError ─→ 透传
      │              │           │           │
      │              │           │           └─ throw 其他 ──→ ResumeParseError ─→ 透传
      │              │           │
      │              │           └─ throw ──→ [op3 catch: ResumeParseError] ─→ 透传
      │              │
      │              └─ throw ──→ [op2 catch: ResumeReadError] ─→ 透传
      │
      └─ false ─→ [op1 catch: ResumeNotFoundError] ─→ 透传（CLI 退出）
```

**每个 throw 显式对应 catch**，无逃逸到外层。

---

## 8. TDD 流程（必填）

| Step | 状态 | 证据 |
|------|------|------|
| RED | ✓ | `src/resume/yaml-parser.test.ts` 12 个 case（RED 阶段 import 失败：Cannot find module → 0/0 跑） |
| GREEN | ✓ | `src/resume/yaml-parser.ts` 实现（YAML + Zod schema + flatten）→ 12/12 PASS |
| REFACTOR | N/A | 一次实现即通过，无明显重复需要重构 |
| 自验证 | ✓ | 全套 vitest 424/424 PASS（仅 1 skip 预存在）；tsc 仅 1 预存在 `puppeteer-extra-plugin-stealth` 错 |

---

## 9. 后续（不在本 ADR 范围 / 必填）

- [ ] **Sprint 1C**：6 维加权评分（学历匹配度 / 经验相关性 / 技能契合度 / 项目深度 / 稳定性指标 / 综合潜力）
- [ ] **已确定不做**：BOSS API 补充简历字段（决策：简历来源仅 简历.yml，不引入 BOSS profile 拉数据）
- [ ] **新 issue**：puppeteer-extra-plugin-stealth 类型缺失（与 1B 无关，但 tsc 跑不过）

---

## 10. 真相变了怎么办（强制重写）

如果 §3-6 中任何一段被推翻（例如：6 维评分需要某些字段在 yml 顶层而不是教育背景/工作经历内），必须重写整个 ADR，不打补丁。

重写步骤：
1. 在 frontmatter 加 `superseded-by: ADR-NNNN`
2. 新建 ADR-NNNN 写新真相
3. 本文档保留作为历史归档
4. commit message 明确写 "重写 ADR-0009：旧归因 [X] → 新归因 [Y]"

---

## Debug Gate 5 项

**N/A**（本 ADR 是新功能 / 重构，不是 bug 修复）

---

## 自检 Checklist

- [x] §3 证据：每个假设都有独立证据（vitest / tsc 输出 / 实测）
- [x] §4 反例：每个被排除的假设都有证伪过程
- [x] §5 备选：评估 4 个备选方案 + 明确选择理由
- [x] §6 行为契约：每条都可观测 / 可测试
- [x] §7 4 类图：触发 §3.5 的改动必画（架构/时序/关系/流程/错误传播）
- [x] §8 TDD：流程完整（RED → GREEN → 自验证）
- [x] §9 后续：列出本 ADR 不解决的待办（1C/1D/类型缺失）
- [x] 未引用未验证的归因（不出现"估计" / "应该" / "可能是" 等未验证用词）
- [N/A] Debug Gate 5 项（非 bug 修复）
- [N/A] 真相已变重写流程（首次写）

---

**纪律引用**：
- `~/.claude/CLAUDE.md` §3.5 4 类图前置
- `~/.claude/CLAUDE.md` §3.9 错误传播图
- `~/.claude/CLAUDE.md` §3.10 refactor 改动前盘点
- `~/.claude/CLAUDE.md` §4 TDD 6 步流程
- memory `feedback_zero_tolerance_fake_green.md`（假绿零容忍）
