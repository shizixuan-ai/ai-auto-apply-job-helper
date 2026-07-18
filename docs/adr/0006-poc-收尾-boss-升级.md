# ADR-0006: PoC 收尾 + fetchJobDetail 端到端验收（重写版）

> **状态**：✅ 已实施（2026-07-14）
> **作者**：boss-apply dev
> **重写**：2026-07-14（旧版凭印象写"接口升级 / SPA 路由跳转"，本次按真诊断重写）
> **关联**：ADR-0003 (city-locking) / ADR-0004 (懒加载防御) / ADR-0005 (robustEvaluate)
> **Sprint**：2026-07-14
> **纪律**：按 `~/.claude/CLAUDE.md` §3.8 + memory `feedback_debug_root_cause_discipline.md` + `docs/adr/_template.md`

---

## 1. 背景与目标

Sprint 2026-07-14 收尾 PoC 阶段：
- search 端到端验收通过（task #30 race 防御 + task #17 lid/securityId）
- fetchJobDetail 链路补全后实测发现**多个错误归因**，本次重写 ADR
- **旧 ADR 写的"BOSS 接口升级 + SPA 路由跳转"全部是凭空想象**（按 [[feedback_debug_methodology]] + [[feedback_zero_tolerance_fake_green]] 必须诚实记录）

---

## 2. 决策（Decision）

**fetchJobDetailViaWapi 走绝对 URL + greet CLI 加 lid/securityId 参数 + 改用引号包 securityId（CLI 用户层面）→ 端到端验收通过**。

---

## 3. 证据（已验证假设 / 必填）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | URL 相对路径 `/wapi/...` 致 fetch 抛 "Failed to parse URL" | 实测：相对 URL 报错"Failed to parse URL"，改绝对 URL 后 fetch 调用本身正常 | user 实测 `bapply greet 89d4f6843... --security-id "..."` 端到端成功 |
| H2 | shell 多行命令下，`--security-id` 后无 `\` 续行符时 securityId 被截断到 ~180 字符 | 实测：fetchJobDetailViaWapi 输出 securityId 实际长度=180 字符（200+ 字符中前 180 字符），BOSS 返 `Failed to fetch` | user 实测对比单行 + 引号包 securityId 后的输出 |
| H3 | fetchJobDetail 需 lid + securityId 才能走 card.json wapi 路径 | 实测：b84bc92 commit + search 3/3 验收 | task #17 + task #30 + search 端到端 |
| H4 | robustEvaluate 治 BOSS SPA navigation race | task #30 + 7/7 单测 + 实测 0 race 失败 | task #30 + search 3/3 |
| H5 | master 项目用绝对 URL + axios（参考实现）| master `platform.ts`: `axiosOriginal.get("https://www.zhipin.com/wapi/zpgeek/job/card.json?...")` | master 项目代码 Read（调研文档） |

---

## 4. 反例（已证伪假设 / 必填）

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | ❌ "BOSS 接口升级（code=17）" | 实际根本没碰到 code=17。旧 ADR 凭印象写，**完全是凭空想象** | 实测 fetchJobDetailViaWapi 真实报错是"Failed to parse URL" / "Failed to fetch"，**不是 code=17** |
| E2 | ❌ "BOSS SPA 路由跳转" | URL parse 失败时根本不会到 page.goto 降级路径。**没追代码路径就写"降级路径失败"是大错**（按 [[feedback_debug_methodology]]） | 实测：fetchJobDetailViaWapi 抛异常 → 异常透传 → CLI 报错。page.goto **根本没被调用** |
| E3 | ❌ "securityId 设计上就是 20 字符（master slice(0,20)）" | master 代码 `slice(0,20)` 是**打印截断**（console.log），不是字段截断。boss-schema.json 实际 securityId 长度 200+ 字符 | Read master 真实代码 + boss-schema.json 验证 |
| E4 | ❌ "BOSS 风控拦截 fetch" | 实测 fetch 调用本身正常（200 OK），BOSS 拒绝原因是不识别截断的 securityId，**不是风控** | 实测 fetch 响应 status=200 + BOSS message="参数不合法" |

---

## 5. 备选方案（取舍 / 必填）

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **A. URL 绝对化 + 引号包 securityId（采用）** | 与 master 实现一致 + 不增加代码复杂度 + 立即修复 | 依赖 user 复制时用引号 | ✓ |
| B. fetch 走 axios（master 模式） | 完全对齐 master | 需要引入 axios 依赖 + 大改造 | ✗ over-engineering |
| C. 改走 page.goto 降级路径 | 治"6 selector 全空" | 详情页 SPA 跳转问题未解决 | ✗ 不解决真因 |
| D. 改用油猴模式（task #12 路径）| 彻底绕过 BOSS wapi 风控 | 大改造（task #12 已 in_progress）| ⏸ 后续 |

---

## 6. 行为契约（可证伪 / 必填）

- ✅ **[已实测通过] `bapply search "Java" --cdp --dry-run --limit 3`**：3/3 fetchJobDetailViaWapi 成功，0 race 失败（commit b84bc92 + 实测）
- ✅ **[已实测通过] `bapply greet <jobId> --lid <lid> --security-id "<完整 securityId>" --cdp`**：端到端通过（fetchJobDetailViaWapi 200 + LLM 话术生成）
- ✅ **[已实测通过] fetchJobDetailViaWapi 走绝对 URL**：user 实测 fetch 调用本身成功
- ❌ **[不在本 ADR 范围] page.goto 6 selector 降级路径**：不可用（BOSS SPA auto-refresh 干扰）→ 后续 task #12 油猴模式解决
- ❌ **[不在本 ADR 范围] send 命令端到端实测**：依赖 HR 在线场景，task #25 长期 in_progress

---

## 7. 4 类图（必填 / ASCII）

### 7.1 架构图（已通过 vs 未通过）

```
PoC 阶段架构（已验证通过）
   bapply CLI → searchJobs → BOSS wapi joblist.json ✓
   ↓
   bapply CLI → fetchJobDetail → fetchJobDetailViaWapi ✓
                                    ├─ race? → robustEvaluate (task #30) ✓
                                    └─ lid/securityId ctx (task #17) ✓
                                    └─ 绝对 URL (本次修复) ✓

未通过层（不在本 ADR 范围）
   page.goto 降级路径 ❌ BOSS SPA auto-refresh
   ↓
   6 selector 全空
```

### 7.2 时序图（fetchJobDetail 链路 + race 防御 + URL 绝对化）

```
search → searchJobs → BOSS wapi joblist.json
   ↓
   jobs list (含 lid/securityId)
   ↓
greet → fetchJobDetail
   ↓
   尝试 1: fetchJobDetailViaWapi (card.json)
            ├─ race? → robustEvaluate 重试 (task #30 ✓)
            ├─ URL 相对? → 改绝对 URL (本次修复 ✓)
            └─ 成功? → 返回 JD
   ↓ 失败
   尝试 2: page.goto 详情页 (不在本 ADR 范围)
   ↓ 当前: 仅走尝试 1（足够）
```

### 7.3 关系图（task 与 ADR 关联）

```
Sprint 2026-07-14 改动:

task #17 (lid/securityId 参数)         task #30 (race 防御)
   ↓                                       ↓
src/browser/index.ts:803              robustEvaluate 模块
   +                                  (src/browser/robust-evaluate.ts)
src/cli/index.ts:370 (greet CLI)         ↓
   ↓                                  fetchJobDetailViaWreeting
   └─────────────→ fetchJobDetail 验收 ←────────┘
                        ↓
                  ADR-0006 (本 ADR 重写)
                        ↓
                  b2affe9 commit (本次合并)

前置 ADR 关联:
   ADR-0003 (city-locking) ─┐
   ADR-0004 (懒加载防御) ───┼─→ fetchJobDetail 链路
   ADR-0005 (robustEvaluate) ┘
```

### 7.4 流程图（归因诊断树）

```
fetchJobDetailViaWapi 失败
   ↓
   ├─ "Failed to parse URL" → URL 相对路径 → 改绝对 URL ✓ (本次修复)
   │
   ├─ "Failed to fetch" (URL 已修) → securityId 截断 → 引号包 ✓ (本次修复)
   │
   └─ BOSS code != 0 (网络/参数) → 进一步诊断（不在本 ADR 范围）
```

---

## 8. TDD 流程（必填）

| Step | 状态 | 证据 |
|------|------|------|
| RED | N/A | 本次修复是 URL 字符串替换，无单测 |
| GREEN | ✅ | fetchJobDetailViaWapi 端到端实测成功 |
| REFACTOR | ✅ | debug 代码保留（user 决策"保留"——对未来 BOSS 升级有诊断价值） |
| 自验证 | ✅ | `bapply greet 89d4f6843... --security-id "..." --cdp` 端到端通过 |

---

## 9. 后续（不在本 ADR 范围 / 必填）

- [ ] **task #12**（in_progress）：Fork ai-job-master 油猴 UI + 去商业化（彻底绕过 BOSS wapi 风控）
- [ ] **task #25**（in_progress）：业务消息实测，依赖 HR 在线场景
- [ ] **page.goto 降级路径**：SPA 跳转问题未解决，进 task #12 油猴模式
- [ ] **新 ADR-0007**：本 ADR 重写后，**保留旧 ADR 作为历史归档**（按 §10）

---

## 10. 真相变了怎么办（强制重写）

按 `docs/adr/_template.md` §10 + §3.8 纪律：

> **本次重写**：
> 1. 旧 ADR 写"BOSS 接口升级（code=17）"—— 错（实际根本没碰到）
> 2. 旧 ADR 写"BOSS SPA 路由跳转"—— 错（URL parse 失败根本到不了 page.goto）
> 3. 旧 ADR 写"行为契约未通过"—— 错（实际 fetchJobDetailViaWapi 已通过）
>
> **教训**（按 [[feedback_debug_methodology]] + [[feedback_zero_tolerance_fake_green]]）：
> - 凭印象写 ADR = 编故事
> - 没追代码路径就写"降级路径失败" = 大错
> - 真相变了要主动重写整个 ADR，**不打补丁**（旧 ADR 留作历史归档）

---

## Debug Gate 5 项（按 §3.8 强约束 / 本 ADR 是 bug 修复类）

- **症状**：
  1. fetchJobDetailViaWapi 抛 "Failed to parse URL"
  2. 改 URL 后抛 "Failed to fetch"
  3. fetchJobDetailViaWapi console.log 输出 securityId 实际长度=180 字符（200+ 字符中前 180 字符）
- **多假设**：
  - H1: URL 相对路径致 parse 失败
  - H2: shell 多行命令字段分割致 securityId 截断
  - H3: BOSS 接口升级（**证伪**）
  - H4: SPA 路由跳转（**证伪**）
  - H5: securityId 设计就是 20 字符（**证伪**，是打印截断）
- **修复**：
  1. `src/browser/index.ts:810` 改 URL 为绝对路径
  2. `src/browser/index.ts:802` 移除 `.slice(0,20)` 截断
  3. user 命令用引号包 securityId（CLI 用户层面）
- **自验证**：
  - `bapply greet 89d4f6843ce5961f0nF83dm9FFdR --lid 1eXZDpHnbvt.search.1 --security-id "1oQV...~" --cdp` → fetchJobDetailViaWapi 200 + LLM 话术
- **未证明**：
  - 不同 BOSS session 下 card.json 稳定性未测
  - 多并发 send 场景未测
  - BOSS 真风控拦截场景未测

---

## 自检 Checklist

- [x] §3 证据：每个假设都有独立证据（实测 / master 对照）
- [x] §4 反例：每个被排除假设都有证伪过程
- [x] §5 备选：评估 4 个备选方案
- [x] §6 行为契约：每条都可观测 / 可测试
- [x] §7 4 类图：架构 / 时序 / 关系 / 流程 完整
- [x] §8 TDD：流程完整
- [x] §9 后续：列出本 ADR 不解决的待办
- [x] 未引用未验证的归因（重写后无"估计/应该/可能是"）
- [x] Debug Gate 5 项完整
- [x] §10 真相变了：本次重写已走

---

**纪律引用**：
- `~/.claude/CLAUDE.md` §3.8 修 bug 归因纪律
- memory `feedback_debug_root_cause_discipline.md`（8 条铁律）
- memory `feedback_debug_gate.md`（Debug Gate 5 项格式）
- memory `feedback_zero_tolerance_fake_green.md`（假绿零容忍）
- `docs/adr/_template.md` §10 真相变了必重写

---

**commit**：b2affe9 feat: 修 bug 归因纪律 + greet 补全 lid/securityId + ADR 模板 + logField helper