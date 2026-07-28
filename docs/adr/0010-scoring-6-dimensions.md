# ADR-0010: 6 维加权评分 + 本地重算 + 智能重试

> **状态**：已实施
> **作者**：AI + user（2026-07-19）
> **日期**：2026-07-19
> **关联**：Sprint 1C（前置 ADR-0009 简历 YAML 化；ADR-0010 独立）
> **纪律**：按 `~/.claude/CLAUDE.md` §3.5 4 类图前置 + §3.8 调试纪律 + §3.9 错误传播图 + §3.10 refactor checklist + §3.11 不能只信 hook + §4 TDD 6 步

---

## 1. 背景与目标

Sprint 1A 用 LLM 对 JD + 简历做单维 0-1 评分（`ScoreResult = { score, reason }`），无法表达"为什么匹配 / 不匹配哪一项"。

Sprint 1B 把简历扩到 15 字段（Sprint 1B 详见 ADR-0009），为多维评分提供了输入。

**问题**：
- 单维 score 是黑盒：0.85 是因为"经验匹配"还是"技能全中"？用户无法知道
- 老阈值 0.85 是单维 magic number，没法调整权重
- 简历推断字段（是否 985/211、是否大厂）单维评分用不上
- LLM 偶发抽风（API 限流、网络抖动）失败一次就计入 failed，无重试

**目标**：
- LLM 一次调用返 6 维 JSON（学历匹配 / 经验相关 / 技能契合 / 项目深度 / 稳定性 / 综合潜力）
- 加权总分 0-1（与 Sprint 1A 兼容，老 threshold 0.85 直接复用）
- 单维缺失降级（不 fail 整体）
- LLM 调用错重试 1 次（业务错不重试，避免脏数据浪费）
- 飞书表"六维详情"长文本字段塞 JSON

---

## 2. 决策（Decision）

**采用方案 A：6 维 JSON + 加权求和 + 本地重算 totalScore + 智能重试 + 飞书长文本字段塞 JSON**

具体：

| 维度 | 权重 | 评估依据 |
|------|------|---------|
| 学历匹配 | 0.10 | 学校层次 + 专业相关性 + 是否 985/211 |
| 经验相关 | **0.30** | 工作年限 + 行业相关性 + 职位层级 |
| 技能契合 | 0.10 | JD 要求技能 vs 候选人技能的覆盖度 |
| 项目深度 | **0.30** | 近期项目的复杂度、规模、影响力 |
| 稳定性 | 0.10 | 跳槽频率 + 在职时长 |
| 综合潜力 | 0.10 | 成长性 + 学习能力 + 管理潜力 |
| **合计** | **1.00** | |

实现要点：
- **1 次 LLM 调用**：prompt 含 6 维 rubric + JSON 模板，1 次返完整结构
- **总分范围 0-1**（与 Sprint 1A 老 threshold 0.85 兼容，**老 .env 配置不动**）
- **每维 score 范围 0-1**
- **本地重算 totalScore**（trust local arithmetic，不信任 LLM 算术）—— Sprint 1C 调试教训：LLM 算 0.1 × 6 维 ≠ Σ 算术和，必须本地重算覆盖
- **降级**：单维缺失 / null → 默认 `{ score: 0.5, reason: '维度解析失败' }`（不 fail 整体）
- **重试 1 次 + 智能分类**：
  - LLM 调用错（网络/API/超时） → 重试 1 次，仍失败透传
  - `ScoreParseError`（JSON 错 / 类型错 / 越界） → **不重试**（重试也是同样脏数据）
- **精度**：保留 3 位小数（避免浮点尾数 0.7950000000000001）
- **飞书字段**："六维详情"（中文"六" U+516D 非 ASCII 数字，TS lexer 合法；最初用"6维详情"踩 TS TS1351 错）
- **SCORE_WEIGHTS env**：可选覆盖默认权重，格式 `key:value,key:value,...`

---

## 3. 证据（已验证假设 / 必填）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | 6 维加权求和公式正确 | TEST D1：0.81 = 0.8×0.1 + 0.9×0.3 + 0.7×0.1 + 0.85×0.3 + 0.6×0.1 + 0.75×0.1 | vitest |
| H2 | 缺 1 维降级为 0.5 + 总分按降级后算 | TEST 3：缺 potential → 默认 0.5 → total = 0.785 | vitest |
| H3 | 本地重算覆盖 LLM 错的 totalScore | TEST 5：LLM 返 totalScore=0.1（错的），实际返 0.81（本地重算）| vitest |
| H4 | LLM 第一次抛错 → 重试 1 次 + 第二次成功 | TEST 12：mock 第一次 mockRejectedValueOnce('network timeout')，第二次 mockResolvedValueOnce(...) | vitest |
| H5 | LLM 两次都抛错 → 抛最后一次错误 | TEST 13：mock 两次都 reject，断言抛 'network timeout 2' | vitest |
| H6 | markdown ` ```json ``` ` 代码块容错 | TEST 8：LLM 返 markdown 代码块包裹 → parseScoreResponse 正确剥离 | vitest |
| H7 | 前后空白 trim 容错 | TEST 9：LLM 返前后带空白 → 正确 trim | vitest |
| H8 | 单维 score 字符串类型 → 抛 ScoreParseError | TEST 10：score: '0.8' → 抛 | vitest |
| H9 | 单维 score 负数越界 → 抛 ScoreParseError | TEST 11：score: -0.1 → 抛 | vitest |
| H10 | 单维 score > 1 越界 → 抛 ScoreParseError | TEST 4：score: 1.5 → 抛 | vitest |
| H11 | 单维是 null → 降级为 0.5 | parseDimensions 检查 `dim === null \|\| dim === undefined` 都降级 | 静态代码检查（vitest TEST 3 覆盖 undefined 路径） |
| H12 | JSON 非 object（数组/字符串）→ 抛 ScoreParseError | parseScoreResponse 检查 `typeof parsed !== 'object' \|\| Array.isArray(parsed)` | 静态代码检查（防御性） |
| H13 | 权重和不归一化 → 抛 Error | TEST D3：weights sum=1.5 → 抛 /权重和不归一化/ | vitest |
| H14 | formatDimensionsForFeishu roundtrip 完整 | TEST P1/P2：ScoreResult → JSON → parse → 拿回 6 维 + totalReason | vitest |
| H15 | 飞书"六维详情"字段 TS 合法 | 编译通过（最初用"6维详情"踩 TS1351 "An identifier or keyword cannot immediately follow a numeric literal"，改"六维详情"修复） | tsc 0 新错 |
| H16 | 老 Sprint 1A threshold 0.85 兼容 | handler `result.totalScore >= deps.threshold` 直接工作，无需迁移 | 静态代码检查 |
| H17 | handler 写飞书含六维详情 | search-and-write.test.ts TEST 6：mock 返 ScoreResult → assert createRecord fields['六维详情'] = JSON.stringify(dimensions) | vitest |
| H18 | 全套 vitest 443 PASS | `npx vitest run` 输出 PASS (443) FAIL (0) skipped (1) | 2026-07-19 |
| H19 | tsc 0 新错 | `npx tsc --noEmit` 仅 1 预存在错（`puppeteer-extra-plugin-stealth` 类型缺失，与 1C 无关） | 2026-07-19 |

---

## 4. 反例（已证伪假设 / 必填）

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | 多次调 LLM（每维 1 次）| 慢 6 倍 + 贵 6 倍；单维失败率高，6 次都过概率 < 一次过的概率 | 决策讨论（2026-07-19），1 次调 + 本地重算 |
| E2 | 信任 LLM 返的 totalScore 字段 | LLM 算术不稳（验证 H3）：重算覆盖而非信任 | 决策讨论（2026-07-19）|
| E3 | 单维错就整体 fail | 5 维的努力白费；用户体检差（明明 5 维都好就因为 1 维缺）| 决策讨论（2026-07-19），单维降级为 0.5 |
| E4 | 所有错都重试 | 业务错（JSON 错、越界）重试也是同样脏数据；浪费 API 配额 | 决策讨论（2026-07-19），智能分类 |
| E5 | 飞书"分数"字段存 6 维 JSON | 飞书数字字段存不下 JSON；改用长文本字段 | 决策讨论（2026-07-19）|
| E6 | 字段名"6维详情" | TS TS1351 "An identifier cannot immediately follow a numeric literal" | 编译验证（2026-07-19），改"六维详情" |
| E7 | 拆分成新模块 `scoring-6d/` | 重复维护成本（要同步老路径）；现有 `scoring/index.ts` 已经是 LLM 评分的唯一入口 | 决策讨论（2026-07-19）|

---

## 5. 备选方案（取舍 / 必填）

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **A. 6 维 + 本方案（已选）** | 完整、可重试、可降级、本地重算、向后兼容（老 threshold 0.85 不变）| 实现略复杂（6 维类型 + 部分降级 + 重试包装）| ✓ |
| B. 5 维（去潜力）| 少一维 prompt 短、token 省 | 漏掉成长性评估；用户权重表含潜力 | ✗ |
| C. 7 维（拆项目/稳定性为多维）| 更细 | 维度过多评估噪声大；prompt 长度爆炸 | ✗ |
| D. 百分比制 0-100 | 老 user 习惯 | LLM 评估 87 vs 88 难区分；与 Sprint 1A 老 score 范围 0-1 不兼容 | ✗ |
| E. 多次调 LLM（每维 1 次）| 错误隔离 | 慢 6 倍 + 贵 6 倍 | ✗ |
| F. 信任 LLM totalScore | 实现简单 | LLM 算错无法纠正（验证 E2）| ✗ |
| G. 拆独立模块 `scoring-6d/` | 与老路径解耦 | 重复维护；要同步老路径 | ✗ |

---

## 6. 行为契约（可证伪 / 必填）

### 6.1 功能性（业务核心）

- ✓ **[已实测通过]**：`computeWeightedTotal(dimensions, DEFAULT_WEIGHTS)` 6 维都 0.81 → total = 0.81 —— TEST D1
- ✓ **[已实测通过]**：自定义权重 `skill: 1.0` 其他 0 → total = skill.score —— TEST D2
- ✓ **[已实测通过]**：缺 1 维 → 降级 0.5 + 总分按降级后算（0.785）—— TEST 3
- ✓ **[已实测通过]**：LLM 返 totalScore=0.1（错的）→ 本地重算覆盖为 0.81 —— TEST 5
- ✓ **[已实测通过]**：6 维全 0 → total = 0；全 1 → total = 1 —— TEST D5
- ✓ **[已实测通过]**：DEFAULT_WEIGHTS 总和精确 = 1 —— TEST D6
- ✓ **[已实测通过]**：buildScorePrompt 输出含 6 维关键词（学历/经验/技能/项目/稳定/潜力）+ JSON —— TEST 7

### 6.2 异常处理（参数校验 + 业务错误）

- ✓ **[已实测通过]**：LLM 返非 JSON → 抛 ScoreParseError —— TEST 2
- ✓ **[已实测通过]**：LLM 返 markdown ` ```json ``` ` 代码块 → 正确剥离 —— TEST 8
- ✓ **[已实测通过]**：LLM 返前后空白 → 正确 trim —— TEST 9
- ✓ **[已实测通过]**：单维 score 字符串类型 → 抛 ScoreParseError —— TEST 10
- ✓ **[已实测通过]**：单维 score 负数越界 → 抛 ScoreParseError —— TEST 11
- ✓ **[已实测通过]**：单维 score > 1 越界 → 抛 ScoreParseError —— TEST 4
- ✓ **[已实测通过]**：权重和不归一化 → 抛 Error —— TEST D3
- ✓ **[静态防御]**：JSON 非 object（数组/字符串）→ 抛 ScoreParseError（`Array.isArray(parsed)` 检查）
- ✓ **[静态防御]**：单维是 null → 降级为 0.5（与 undefined 同分支）

### 6.3 重试逻辑（智能分类）

- ✓ **[已实测通过]**：LLM 第一次抛网络错 → 重试 1 次 + 第二次成功 → 返 ScoreResult —— TEST 12
- ✓ **[已实测通过]**：LLM 两次都抛错 → 抛最后一次错误 —— TEST 13
- ✓ **[设计意图]**：ScoreParseError 不重试（重试也是同样脏数据）

### 6.4 字段映射（handler 写飞书）

- ✓ **[已实测通过]**：`FeishuJobFields.分数 = result.totalScore`
- ✓ **[已实测通过]**：`FeishuJobFields.匹配原因 = ` `score=${result.totalScore.toFixed(2)}` ``
- ✓ **[已实测通过]**：`FeishuJobFields.六维详情 = formatDimensionsForFeishu(result)`（JSON 字符串）
- ✓ **[向后兼容]**：老 threshold 0.85 兼容（`result.totalScore >= deps.threshold` 直接工作）

### 6.5 持久化（formatDimensionsForFeishu）

- ✓ **[已实测通过]**：ScoreResult → JSON 字符串（pretty print）
- ✓ **[已实测通过]**：JSON 字符串 parse 回去能拿回 6 维 + totalReason —— TEST P1/P2
- ✓ **[已实测通过]**：JSON 含 6 维字段名（防 schema 漂移）—— TEST P3
- ✓ **[设计意图]**：不含 totalScore（飞书「分数」字段已存，避免重复）

---

## 7. 4 类图（必填 / ASCII）

### 7.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│  src/cli/index.ts (bapply search --write)                   │
│  └─ runSearchAndWrite(opts, deps)                           │
│  └─ deps.scoreJob(jd, summary, llm, weights?)                │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  src/scoring/index.ts                                       │
│  ├─ buildScorePrompt(jd, summary, weights)                  │
│  │    → 6 维 rubric + JSON 输出模板                          │
│  ├─ callLLMWithRetry(prompt, llm)                           │
│  │    → llm.generate 抛错 → 重试 1 次，仍失败透传            │
│  └─ parseScoreResponse(raw, weights)                        │
│       ├─ markdown 容错剥离 + trim                            │
│       ├─ JSON.parse → ScoreParseError                       │
│       ├─ JSON 非 object → ScoreParseError                   │
│       ├─ 6 维遍历（缺失/null → 0.5；类型错/越界 → 抛）       │
│       └─ computeWeightedTotal(dimensions, weights) ─┐       │
└──────────────────┬──────────────────────────────────┼───────┘
                   │                                  │
                   ▼                                  │
┌──────────────────────────────────────────────────┐  │
│  src/scoring/dimensions.ts                       │  │
│  ├─ DEFAULT_WEIGHTS (0.1/0.3/0.1/0.3/0.1/0.1)   │  │
│  └─ computeWeightedTotal(dims, weights)          ◀──┘
│       └─ 保留 3 位小数 + 权重和校验               │
└──────────────────┬─────────────────────────────────┘
                   │ ScoreResult { totalScore, totalReason, dimensions }
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  src/cli/handlers/search-and-write.ts                       │
│  ├─ 阈值过滤: totalScore >= threshold * 10 (向后兼容 0.85)  │
│  ├─ 写飞书 4 字段:                                           │
│  │    分数 = result.totalScore                              │
│  │    匹配原因 = `score=${totalScore.toFixed(2)}`           │
│  │    六维详情 = formatDimensionsForFeishu(result)          │
│  │    + 原有字段 (职位/公司/BOSS_ID/JD摘要/HR_UID/LID/SECURITY_ID)│
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  src/scoring/persistence.ts                                 │
│  └─ formatDimensionsForFeishu(scoreResult) → JSON 字符串     │
└─────────────────────────────────────────────────────────────┘

依赖：
  src/types/index.ts (新类型)
    ├─ ScoreDimension (单维)
    ├─ ScoreDimensions (6 维)
    ├─ ScoreWeights (6 权重)
    └─ ScoreResult (含 dimensions)
  src/config/index.ts (加 SCORE_WEIGHTS env 解析)
```

### 7.2 时序图

```
CLI          handler        scoreJob       buildScore    llm.generate    parseScore    dimensions    persistence
 │              │               │              │              │              │              │              │
 │--scoreJob(jd, summary, llm, weights)──>  │              │              │              │              │
 │              │               │--buildScorePrompt──────> │              │              │              │
 │              │               │<─prompt────────────────  │              │              │              │
 │              │               │--callLLMWithRetry(prompt, llm)──>│              │              │              │
 │              │               │  ├ llm.generate #1 ──────────────────>│              │              │
 │              │               │  │   ├ ok ─→ 返 raw                    │              │              │
 │              │               │  │   └ throw ─→ 重试 #2 ──────────────>│              │              │
 │              │               │<─raw (or throw after 2 attempts)───────│              │              │
 │              │               │--parseScoreResponse(raw, weights)─────────────>│              │              │
 │              │               │  1. trim + markdown 剥离                                   │              │
 │              │               │  2. JSON.parse → 抛/ok                                     │              │
 │              │               │  3. 6 维遍历（缺/null → 0.5；类型错/越界 → 抛）            │              │
 │              │               │  4. computeWeightedTotal──────────────────────────────>│              │
 │              │               │<─ScoreResult────────────────────────────────────────────│              │
 │<─result─────────────────────  │              │              │              │              │
 │              │--formatDimensionsForFeishu(result)──────────────────────────────────────────────────>│
 │              │<─JSON 字符串────────────────────────────────────────────────────────────────────────────│
 │              │--createRecord({ 分数, 匹配原因, 六维详情, ... }) → 飞书                              │
```

### 7.3 关系图

```
┌──────────────────────┐
│  ScoreResult         │
│  - totalScore (0-1)  │
│  - totalReason       │
│  - dimensions        │
└──────────┬───────────┘
           │ contains
           ▼
┌──────────────────────┐         ┌──────────────────────┐
│  ScoreDimensions     │         │  ScoreWeights        │
│  - education         │         │  - education: 0.1    │
│  - experience        │  ×      │  - experience: 0.3   │
│  - skill             │ ──────> │  - skill: 0.1        │
│  - project           │         │  - project: 0.3      │
│  - stability         │         │  - stability: 0.1    │
│  - potential         │         │  - potential: 0.1    │
└──────────────────────┘         └──────────────────────┘
         │                                │
         │ 字段数据来源（依赖 ResumeSummary 1B 15 字段）：
         │  - education  ← degree + school + isElite
         │  - experience ← yearsOfExperience + recentProjects
         │  - skill      ← skills[]
         │  - project    ← recentProjects[].描述
         │  - stability  ← recentProjects[].时间段（推跳槽频率）
         │  - potential  ← LLM 主观（成长性/学习/管理潜力）
         ▼
┌──────────────────────┐
│  ResumeSummary       │  ← src/types/index.ts (Sprint 1B 扩展)
│  (15 字段)           │
└──────────────────────┘
```

### 7.4 流程图（parseScoreResponse 6 维处理）

```
parseScoreResponse(raw, weights)
  │
  ▼
raw.trim() + markdown 容错剥离
  │
  ▼
JSON.parse(raw)
  │
  ├─ 失败 ──→ throw ScoreParseError
  │
  ├─ 不是 object / 是 array ──→ throw ScoreParseError
  │
  ▼
6 维遍历：
  │
  ├─ dim === undefined || null ──→ { score: 0.5, reason: '维度解析失败' }
  │
  ├─ typeof dim !== 'object' ──→ throw ScoreParseError
  │
  ├─ score 不是 number || NaN/Infinity ──→ throw ScoreParseError
  │
  ├─ score < 0 || > 1 ──→ throw ScoreParseError
  │
  └─ 否则 ──→ { score, reason }
  │
  ▼
totalReason = typeof obj.totalReason === 'string' ? obj.totalReason : ''
  │
  ▼
totalScore = computeWeightedTotal(dimensions, weights)   ← 本地重算（忽略 LLM 返的 totalScore）
  │
  ▼
return { totalScore, totalReason, dimensions }
```

### 7.5 错误传播图（§3.9）

```
[op1: buildScorePrompt]
   └─ 返 prompt string（无 throw）

[op2: callLLMWithRetry (2 次)]
   │
   ├─ attempt 1 ok ─→ [op3: parseScoreResponse]
   │
   ├─ attempt 1 throw ─→ attempt 2
   │   │
   │   ├─ attempt 2 ok ─→ [op3]
   │   │
   │   └─ attempt 2 throw ─→ 透传最后一次错误 ─→ handler catch ─→ failed
   │
   └─ ScoreParseError 不进入此函数（由 parseScoreResponse 抛）

[op3: parseScoreResponse]
   │
   ├─ JSON.parse throw ──→ ScoreParseError ─→ 透传（不重试）──→ handler catch ─→ failed
   │
   ├─ JSON 非 object ──→ ScoreParseError ─→ 透传
   │
   ├─ 单维类型错 ──→ ScoreParseError ─→ 透传
   │
   ├─ 单维越界 ──→ ScoreParseError ─→ 透传
   │
   ├─ 单维缺/null ──→ 降级 0.5（不抛错）
   │
   └─ 6 维都 ok ─→ [op4: computeWeightedTotal]
                        │
                        ├─ 权重和 ≠ 1 ──→ Error ─→ 透传 ─→ handler catch
                        │
                        └─ 权重和 = 1 ──→ 算术和 ─→ return ScoreResult ─→ handler
```

**每个 throw 显式对应 catch**，无逃逸。

---

## 8. TDD 流程（必填）

| Step | 状态 | 证据 |
|------|------|------|
| RED | ✓ | `src/scoring/dimensions.test.ts` (6 个) + `src/scoring/index.test.ts` (13 个) + `src/scoring/persistence.test.ts` (3 个) = **22 个 RED 测试**；最初 `vitest run src/scoring/` 输出 `2 suites failed, 0 passed` + tsc 18 个新错（TS2554 / TS2307 / TS2339）|
| GREEN | ✓ | 4 文件实现：`dimensions.ts` + `scoring/index.ts`（重写含 `callLLMWithRetry`）+ `scoring/persistence.ts` + `types/index.ts` 扩类型 + `config/index.ts` 加 `SCORE_WEIGHTS` 解析 + handler 改 + handler test mock 改 |
| REFACTOR | ✓ | `scoring/dimensions.ts` 拆出 `DEFAULT_WEIGHTS` + `computeWeightedTotal`（纯函数），便于测试和老 supplier 复用 |
| 自验证 | ✓ | 全套 vitest 443/443 PASS（仅 1 skip 预存在）+ tsc 仅 1 预存在错 |

---

## 9. 后续（不在本 ADR 范围 / 必填）

- [ ] **Sprint 1D：飞书表加"六维详情"长文本字段**（用 `scripts/add-sprint-1c-fields.mjs`，仿 `add-sprint-1a-fields.mjs` 流程）
- [ ] **[已确定不做]**：BOSS API 补充简历字段（ADR-0009 §9 已定）
- [ ] **[已确定不做]**：拆 ADR-0011（6 维在 1 个 ADR 内已能讲清楚）
- [ ] **[未证明]**：live e2e（BOSS 风控阻塞，沿用 1B 的 [未证明: live 待验]）
- [ ] **[预存在]**：`puppeteer-extra-plugin-stealth` 类型缺失（与 1C 无关）
- [ ] **[Sprint 1D 待办]**：LLM 供应商扩展（MiniMax + 火山方舟）—— 详见 task #25+ 待开 ADR-0011

---

## 10. 真相变了怎么办（强制重写）

如果 §3-6 中任何一段被推翻（例如：用户改权重表、改 6 维为 7 维、改重试策略为指数退避），必须重写整个 ADR，不打补丁。

重写步骤：
1. 在 frontmatter 加 `superseded-by: ADR-NNNN`
2. 新建 ADR-NNNN 写新真相
3. 本文档保留作为历史归档
4. commit message 明确写 "重写 ADR-0010：旧归因 [X] → 新归因 [Y]"

---

## Debug Gate 5 项

**N/A**（本 ADR 是新功能 / 重构，不是 bug 修复）

---

## 自检 Checklist

- [x] §3 证据：每个假设都有独立证据（vitest 输出 / tsc 输出 / 静态代码检查）
- [x] §4 反例：每个被排除的假设都有证伪过程
- [x] §5 备选：评估 7 个备选方案 + 明确选择理由
- [x] §6 行为契约：每条都可观测 / 可测试
- [x] §7 4 类图：触发 §3.5 的改动必画（架构/时序/关系/流程/错误传播）
- [x] §8 TDD：流程完整（RED → GREEN → REFACTOR → 自验证）
- [x] §9 后续：列出本 ADR 不解决的待办（1D LLM 扩展 / 飞书字段添加 / live e2e / 类型缺失）
- [x] 未引用未验证的归因（不出现"估计" / "应该" / "可能是" 等未验证用词）
- [N/A] Debug Gate 5 项（非 bug 修复）
- [N/A] 真相已变重写流程（首次写）

---

**纪律引用**：
- `~/.claude/CLAUDE.md` §3.5 4 类图前置
- `~/.claude/CLAUDE.md` §3.8 调试纪律（修 bug 归因 — 本 ADR 借 H3 LLM 算术不稳教训）
- `~/.claude/CLAUDE.md` §3.9 错误传播图
- `~/.claude/CLAUDE.md` §3.10 refactor 改动前盘点
- `~/.claude/CLAUDE.md` §3.11 不能只信 hook（scoring 路径有专门 22 个测试覆盖）
- `~/.claude/CLAUDE.md` §4 TDD 6 步流程
- `~/.claude/CLAUDE.md` §5.2 决策溯源标注
- memory `feedback_zero_tolerance_fake_green.md`（假绿零容忍）
- memory `feedback_debug_root_cause_discipline.md`（H3 LLM 算术不稳 → 本地重算）
- ADR-0009（前置：简历 YAML 化 15 字段）
