# ADR-0012: 火山方舟 huoshan 接入 + minimax/huoshan 鉴权 header 修正（x-api-key → Bearer）

> **状态**：已实施
> **作者**：AI + user（2026-07-21）
> **日期**：2026-07-21
> **关联**：ADR-0011（LLM 多供应商）§10 后续 + §11 重写协议（huoshan 协议确认 → 立本 ADR，不打 0011 补丁）
> **纪律**：§3.5 4 类图（复用 0011 §7，仅 auth header 增量）+ §3.6 A/B 分类 + §3.8 调试纪律（minimax bug）+ §3.9 错误传播图 + §4 TDD + §5.2 溯源
>
> **前置真相变更**：ADR-0011 E6 / §10 把 huoshan 协议标 `[AI 假设] 待定`。本 ADR 用外部文档 + user 确认**证实** huoshan = Anthropic 协议 + Bearer 鉴权，同时**证伪** ADR-0011 对 minimax 的 `x-api-key` 假设。

---

## 1. 背景与目标

ADR-0011 Phase 4 留坑：huoshan（火山方舟 coding plan）协议未确认，createLLM 抛 "尚未配置"。user 2026-07-21 提供：
- `ANTHROPIC_BASE_URL = https://ark.cn-beijing.volces.com/api/coding`
- `ANTHROPIC_AUTH_TOKEN = <ARK_API_KEY>`（Bearer 鉴权）
- `ANTHROPIC_MODEL = glm-5.2`

调研 + user 确认后发现两件事：
1. **huoshan = Anthropic 协议兼容**（官方以 Claude Code `ANTHROPIC_BASE_URL` 方式接入，走 Anthropic Messages API 格式）→ 可复用 `AnthropicCompatAdapter`。
2. **鉴权是 `Authorization: Bearer`（ANTHROPIC_AUTH_TOKEN），不是 `x-api-key`**。顺带核对 minimax（minimaxi）官方文档，**minimax 也是 `ANTHROPIC_AUTH_TOKEN` = Bearer** → ADR-0011 里 minimax 用 `x-api-key` 的实现**是 bug**（当时 §3.11 已标"live 待验"，从未真跑）。

**目标**：
- `AnthropicCompatAdapter` 支持按供应商切换鉴权 header（`x-api-key` vs `Authorization: Bearer`）
- 修 minimax 鉴权 bug（x-api-key → Bearer）
- 接入 huoshan（→ AnthropicCompatAdapter + Bearer + ark coding baseURL + glm-5.2）
- anthropic 官方保持 `x-api-key`（Anthropic 原生 API 正确姿势）
- 安全：真实 KEY 仅经 `.env`，不入 ADR / commit / .env.example

---

## 2. 决策（Decision）

### 2.1 `AnthropicCompatAdapter` 加 `authStyle`

| 项 | 老 | 新 |
|---|---|---|
| 鉴权 header | 硬编码 `x-api-key` | 构造参数 `authStyle: 'x-api-key' \| 'bearer'`（默认 `'x-api-key'`） |
| `x-api-key` 分支 | 唯一 | `authStyle='x-api-key'` → `{ 'x-api-key': apiKey }` |
| `bearer` 分支 | 无 | `authStyle='bearer'` → `{ 'Authorization': 'Bearer ' + apiKey }` |
| `anthropic-version` | 恒发 | 恒发（两分支都发，Claude Code 行为一致） |

### 2.2 createLLM 供应商 → authStyle 映射

| provider | adapter | baseURL 默认 | model 默认 | authStyle |
|---|---|---|---|---|
| anthropic | AnthropicCompatAdapter | `https://api.anthropic.com` | `claude-sonnet-4-20250514` | `x-api-key`（原生 API 正确） |
| **minimax** | AnthropicCompatAdapter | `https://api.minimaxi.com/anthropic` | `MiniMax-M2.7-highspeed`（不动，见 §10） | **`bearer`**（bug fix） |
| **huoshan** | AnthropicCompatAdapter | `https://ark.cn-beijing.volces.com/api/coding` | `glm-5.2` | **`bearer`**（新增） |

### 2.3 env（沿用 ADR-0011 统一 4 个）

huoshan 无新增 env，走通用：
```
LLM_PROVIDER=huoshan
LLM_API_KEY=<ARK_API_KEY>          # 走 Authorization: Bearer
# LLM_BASE_URL=                     # 默认 https://ark.cn-beijing.volces.com/api/coding
# LLM_MODEL=                        # 默认 glm-5.2
```

---

## 3. 证据（已验证假设）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | huoshan `/api/coding` = Anthropic 协议 | 火山官方 Claude Code 接入用 `ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/coding` + Anthropic Messages API 格式 | WebSearch 多来源一致（CSDN/博客园官方教程） + user 确认 |
| H2 | huoshan 鉴权 = `Authorization: Bearer` | 官方示例 `ANTHROPIC_AUTH_TOKEN=<ARK_API_KEY>`（Claude Code 把 AUTH_TOKEN 发成 Bearer，不发 x-api-key） | user 原样贴出 `ANTHROPIC_AUTH_TOKEN` + WebSearch |
| H3 | huoshan model = glm-5.2 | user 提供 | user 输入（实测） |
| H4 | **minimax 鉴权也是 Bearer（不是 x-api-key）** | minimaxi 官方文档 `platform.minimaxi.com/docs/token-plan/claude-code`：`ANTHROPIC_AUTH_TOKEN=<MINIMAX_API_KEY>`（Bearer，not x-api-key） | WebFetch 官方文档（实测） |
| H5 | ADR-0011 minimax 实现用 x-api-key（bug） | `src/llm/index.ts:129` `'x-api-key': this.apiKey` + test R1/R5-supplement 断言 x-api-key | Read 文件 + 单测直接确认 |

---

## 4. 反例（已证伪假设）

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | huoshan 是 OpenAI 兼容（走 OpenAIAdapter / `/v1/chat/completions`） | 官方以 `ANTHROPIC_BASE_URL` + Anthropic Messages 格式接入 | H1 WebSearch |
| E2 | huoshan 用 x-api-key（复用现有 adapter 零改） | 官方明确 `ANTHROPIC_AUTH_TOKEN`（Bearer） | H2 |
| E3（ADR-0011 遗留） | minimax 用 x-api-key | minimaxi 官方文档是 `ANTHROPIC_AUTH_TOKEN`（Bearer） | H4 WebFetch 官方文档 |
| E4 | 同时发 x-api-key + Bearer 两 header 图省事 | 语义不清 + 极少数严格网关可能拒未知 header + 掩盖"到底哪个生效"（§3.11 精神）；按供应商精确 authStyle 更可证伪 | 设计取舍 |

---

## 5. 备选方案

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **本方案**（authStyle 参数，按供应商精确切换） | 语义清晰 / anthropic 官方仍 x-api-key / 可测 | adapter 加 1 参数 | ✓ |
| A. 同时发两 header | 零判断 | E4 语义不清 + 严格网关风险 | ✗ |
| B. 新写 HuoshanAdapter | 隔离 | 与 AnthropicCompatAdapter 99% 重复，违 §3.2 无效重复 | ✗ |
| C. 全改成 Bearer（含 anthropic 官方） | 统一 | Anthropic 原生 API 标准是 x-api-key，改坏官方路径 | ✗ |

---

## 6. 行为契约（可测）

- ✓ **B1**：`createLLM(provider='huoshan')` → AnthropicCompatAdapter，`generate()` 打 `https://ark.cn-beijing.volces.com/api/coding/v1/messages`，header `Authorization: Bearer <key>`，body 含 `glm-5.2`，**无** `x-api-key` — TEST R8
- ✓ **B2**：`createLLM(provider='minimax')` → header `Authorization: Bearer <key>`，**无** `x-api-key` — TEST R1/R5-supplement（改断言）
- ✓ **B3**：`createLLM(provider='anthropic')` → header `x-api-key`，**无** `Authorization` — TEST R5（不变）
- ✓ **B4**：huoshan 空内容 / HTTP 错误 / type=error → throw（沿用 0011 空内容 throw 纪律，Bearer 路径不新增错误边界） — TEST R9
- ✗ **B5（不在本 ADR）**：真实 ARK KEY live smoke — 见 §10（user 未提供 key，无法本轮 live 验）

---

## 7. 4 类图（增量）

架构/时序/关系/流程 **复用 ADR-0011 §7**（huoshan 从 "throw 未配置" 变为 AnthropicCompatAdapter 叶子，与 minimax 同形）。**唯一增量 = 鉴权 header 分叉**：

```
AnthropicCompatAdapter.generate()
        │
        ├─ authStyle='x-api-key' ─→ headers { 'x-api-key': key, 'anthropic-version' }   ← anthropic 官方
        └─ authStyle='bearer'    ─→ headers { 'Authorization': 'Bearer '+key, 'anthropic-version' }  ← minimax / huoshan
                │
                ▼
        fetch(`${baseURL}/v1/messages`, { headers, body:{ model, max_tokens, system, messages } })
```

## 8. 错误传播图（§3.9）

**与 ADR-0011 §8 完全一致** —— authStyle 只改请求 header 内容，**不新增/不移动任何 throw 边界**。`generate()` 的三个 throw（`!res.ok` / `body.type==='error'` / 空内容）在 x-api-key 与 bearer 两分支共用，caller catch 边界不变。

---

## 9. TDD 流程

| Step | 状态 | 证据 |
|------|------|------|
| RED | ✅ | R8/R9 新增 + R1/R5-supplement 改断言（x-api-key → Bearer）先红 |
| GREEN | ✅ | AnthropicCompatAdapter 加 authStyle + createLLM minimax/huoshan 传 bearer |
| REFACTOR | ✅ | header 构造抽 helper |
| 自验证 | ✅ | vitest src/llm + src/config 全绿 + tsc 无新增错误 |

### 9.1 测试清单

| # | 测试 | 断言 |
|---|------|------|
| R8 | huoshan → AnthropicCompatAdapter | fetch URL=ark coding `/v1/messages` + `Authorization: Bearer` + body 含 glm-5.2 + 无 x-api-key |
| R9 | huoshan 错误路径 | 空内容/HTTP 错误 → throw（复用 anthropic 同款断言） |
| R1'（改） | minimax → Bearer | 原断言 x-api-key → 改 `Authorization: Bearer`，且无 x-api-key |
| R5-supplement'（改） | minimax 显式 baseURL → Bearer | 同上 |
| R5（不变） | anthropic 官方 → x-api-key | 保持 |

---

## 10. 后续（不在本 ADR）

- [ ] **live smoke**：ADR-0011 §9.4 承诺的 `scripts/smoke-llm-*.mjs` 仍缺失。minimax(Bearer) + huoshan(Bearer) 的真实 API 调用**从未 live 验**（user 本轮未提供 ARK/MINIMAX key）→ 标 `[未证明: live 待验]`。
- [ ] **minimax model 默认值**：minimaxi 文档最新示例是 `MiniMax-M3`，现默认 `MiniMax-M2.7-highspeed`。本 ADR **不动**（避免混入无关变更），待 user 确认是否升级。
- [ ] **真实 KEY revoke**（ADR-0011 §10 遗留）：起草期 user 曾贴过 minimax KEY，建议 revoke 重发。

---

## Debug Gate 5 项（minimax x-api-key bug）

- **症状**：ADR-0011 minimax 路径用 `x-api-key` header（`src/llm/index.ts:129`），但 minimaxi 官方文档要求 `ANTHROPIC_AUTH_TOKEN`（Bearer）。若真跑会 401（未 live 验，静态归因）。
- **多假设**：(a) minimaxi 同时接受 x-api-key 与 Bearer → 现状可跑；(b) minimaxi 只认 Bearer → 现状 401；(c) 现状从未真跑（§3.11 live 待验）→ bug 潜伏。→ WebFetch 官方文档证实 (b)+(c)：文档只列 ANTHROPIC_AUTH_TOKEN。
- **修复**：AnthropicCompatAdapter 加 authStyle，minimax 传 'bearer'（commit 见 git log）。
- **自验证**：vitest R1/R5-supplement 改断言后全绿 + tsc 无新增错误。
- **未证明**：真实 minimaxi/ark 端点 live 返回（无 key，`[未证明: live 待验]`）；假设 (b) "只认 Bearer" 基于文档而非实测 401。

---

## 决策溯源（§5.2）

| # | 决策项 | 标注 | 依据 |
|---|--------|------|------|
| 1 | huoshan baseURL = `https://ark.cn-beijing.volces.com/api/coding` | **[已确认]** | user 提供 + WebSearch |
| 2 | huoshan 协议 = Anthropic 兼容 | **[已确认]** | H1 |
| 3 | huoshan 鉴权 = Bearer | **[已确认]** | H2 user + WebSearch |
| 4 | huoshan model = glm-5.2 | **[已确认]** | user 提供 |
| 5 | minimax 鉴权 = Bearer（原 x-api-key 是 bug） | **[已确认]** | H4 WebFetch 官方文档 |
| 6 | anthropic 官方保持 x-api-key | **[已确认]** | Anthropic 原生 API 标准 |
| 7 | minimax model 默认值升级到 MiniMax-M3 | **[待确认]** | §10 待 user 定 |
| 8 | minimax/huoshan live 可跑 | **[未证明]** | 无 key，§10 live 待验 |
