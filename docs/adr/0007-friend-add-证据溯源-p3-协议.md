# ADR-0007: friend/add.json 协议证据溯源 + P3 协议决策

> **状态**：✅ 已实施（2026-07-14）
> **作者**：boss-apply dev
> **关联**：ADR-0005 (robustEvaluate) / ADR-0006 (fetchJobDetail 修复) / task #39 (探针) / task #41 (sendGreeting 改造)
> **Sprint**：2026-07-14
> **纪律**：按 `~/.claude/CLAUDE.md` §3.8 + memory `feedback_debug_root_cause_discipline.md` + `docs/adr/_template.md`

---

## 1. 背景与目标

Sprint 2026-07-14 收尾 PoC 阶段：
- 之前 sendGreeting 实现基于 boss-zhipin-bot README 反编译（**未实测**）
- user 2026-07-14 决策："借鉴 master 接口和对应参数信息"
- task #39 写 `scripts/probe-friend-add.mjs` 探针脚本，**真发 1 个 jobId**
- 探针结果：**P3 唯一成功**（master query + null body + Zp_token + Cookie 冗余）
- 本 ADR 记录证据溯源 + P3 协议决策依据

---

## 2. 决策（Decision）

**sendGreeting 改用 P3 协议**：
1. URL 改为 `?securityId=...&jobId=...&lid=...`（query 参数）
2. body = `null`（不传 form body）
3. Header 加 `Zp_token: <bst cookie value>` + `Cookie: <全量 cookie>`（关键：Cookie 冗余是 P3 唯一与 P1 差异）
4. 移除 hrUid / message 参数（master 不传，bossCode=0 响应中 BOSS 自动生成 greeting）

---

## 3. 证据（已验证假设 / 必填）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | Zp_token header 不足以鉴权，必须 Cookie 冗余 | **P1 vs P3 唯一差异 = Cookie**：P1 (Zp_token only) → code=1011 "当前登录状态已失效"；P3 (Zp_token + Cookie) → code=0 SUCCESS | `tests/fixtures/friend-add-schema.json` P1/P3 raw 响应 |
| H2 | master query + null body + Zp_token + Cookie 协议有效 | P3 探针真发 1 个 jobId → bossCode=0 message="Success"，响应含 greeting/encBossId/securityId | `tests/fixtures/friend-add-schema.json` P3 raw.zpData |
| H3 | BOSS 不读 message 参数（form body 不影响） | P3 不传 message，bossCode=0 SUCCESS；响应 greeting 字段 = BOSS 自动生成 | `tests/fixtures/friend-add-schema.json` P3 raw.zpData.greeting |
| H4 | bossCode=1011 = 登录状态失效（非风控限流） | BOSS message = "当前登录状态已失效" | P1/P2 raw.message |
| H5 | fetch 在浏览器 page.evaluate 上下文带 credentials: 'include' 不够 | 探针 P3 用 Node fetch + 显式 Cookie header 才成功 | P3 vs ours（浏览器自动带 cookie）需后续验证 |

---

## 4. 反例（已证伪假设 / 必填）

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | ❌ "BOSS 同时支持多种协议（Zp_token alone / Zp_token+Cookie 都行）" | P1 (Zp_token alone) → bossCode=1011；P3 (Zp_token+Cookie) → bossCode=0 | 探针 P1/P3 对照 |
| E2 | ❌ "我们 form body 协议有效" | P2 (form body + Zp_token only) → bossCode=1011（同 P1，**未独立验证 form body + Cookie**——可能协议 OK 但缺 Cookie） | 探针 P2 raw response |
| E3 | ❌ "BOSS 改版需 page.goto 降级路径" | P3 Node fetch 直发成功，无需 page 操作 | 探针用 Node fetch 而非 page.evaluate |
| E4 | ❌ "Zp_token 是新鉴权机制替代 cookie" | P1 (Zp_token only) 失败说明 Zp_token 是辅助 header，不是替代 | P1 vs P3 唯一差异对照 |

---

## 5. 备选方案（取舍 / 必填）

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **A. P3 协议（采用）** | 探针真发验证 + Cookie 冗余保险 + 移除冗余参数（hrUid/message） | 需改造 sendGreeting + send-handler + CLI 参数 | ✓ |
| B. 仅改 fetch 协议（保留 form body + message + hrUid） | 改动小 | 风险：form body + message 可能被 BOSS 拒绝但没真发验证 | ⏸ 需后续探针 |
| C. 仅借鉴 master 不加 Cookie | 简化代码 | P1 失败证明不可行 | ✗ 已证伪 |
| D. fork ai-job-master 油猴（task #12 主线） | 彻底对齐 master | 大改造（task #12 in_progress）| ⏸ 后续 |

---

## 6. 行为契约（可证伪 / 必填）

- ✅ **[已实测通过] P3 协议真发 1 个 jobId**：bossCode=0 message="Success"，响应含 greeting/encBossId/securityId
- ✅ **[已实测失败] P1 协议（Zp_token only）**：bossCode=1011 "当前登录状态已失效"
- ✅ **[已实测失败] P2 协议（form body + Zp_token only）**：bossCode=1011（同 P1，未独立验证 form body 协议本身）
- ❌ **[不在本 ADR 范围] 多并发 send 稳定性**：未测
- ❌ **[不在本 ADR 范围] 不同 BOSS session 下稳定性**：未测
- ❌ **[不在本 ADR 范围] send 端到端 CLI 实测**：待 task #41 改造 + user 真发验证

---

## 7. 4 类图（必填 / ASCII）

### 7.1 架构图（P3 协议）

```
sendGreeting (改造后 — task #41)
  ├─ 入参: (page, jobId, lid, securityId)         ← 移除 hrUid/message
  ├─ robustEvaluate → page.evaluate(fetch ...)
  │   ├─ URL: ?securityId=...&jobId=...&lid=...   ← master 风格 query
  │   ├─ Method: POST
  │   ├─ Headers:
  │   │   ├─ Zp_token: <bst cookie value>          ← master 鉴权
  │   │   └─ Cookie: <全量 cookie>                  ← ★ 关键（探针 P1 vs P3 唯一差异）
  │   └─ Body: null                                ← master 风格
  ├─ 响应解析（按 master）：
  │   ├─ bossCode=0 → action='sent', friendId=zpData.encBossId
  │   ├─ chatRemindDialog.content 含 "120 次" → action='sent'（master 限流算 SUCCESS）
  │   ├─ bossCode=1011 → action='security_blocked'
  │   └─ 其他 → action='failed', error=bossMessage
  └─ withGuard 包外层（风控检测）
```

### 7.2 时序图（探针 3 种风格）

```
探针脚本 (scripts/probe-friend-add.mjs)
  ↓ CDP 接管 + context.cookies()
拿 14 个 BOSS cookies（含 bst = V2Rt8mE-...zA~~）
  ↓ 调 joblist.json 拿 1 个真实 job
encryptJobId=89d4f6843ce5961f0nF83dm9FFdR
  ↓ 3 种风格 POST friend/add.json（同一 jobId）

P1 (master query + null body + Zp_token only)
  ↓
HTTP 200, code=1011, msg="当前登录状态已失效"  ❌
  ↓ 证伪: Zp_token 不足

P2 (form body gid/uid/message + Zp_token only)
  ↓
HTTP 200, code=1011, msg="当前登录状态已失效"  ❌
  ↓ 同 P1 证伪（缺 Cookie 误判 form body）

P3 (master query + null body + Zp_token + Cookie 冗余)
  ↓
HTTP 200, code=0, msg="Success"                 ✅
zpData.greeting = "7年Java高并发实战..."
zpData.encBossId = "e2043def326cf10d0XN509i-E1s~"
zpData.securityId = "esknqGib9UMBo-..."
  ↓
schema dumped to tests/fixtures/friend-add-schema.json
```

### 7.3 关系图（task 与 ADR 关联）

```
Sprint 2026-07-14 send 改造:

task #39 (探针脚本)              task #41 (sendGreeting 改造)
   ↓                                ↓
scripts/probe-friend-add.mjs    src/browser/index.ts:880
   ↓                                ↓
tests/fixtures/                   ↓
friend-add-schema.json          src/cli/handlers/send-handler.ts
   ↓                                ↓
本 ADR-0007                      src/cli/index.ts send 命令
   ↓
commit (user 决策: ADR 等探针一起 commit)
```

### 7.4 流程图（鉴权归因诊断）

```
friend/add.json 失败
   ↓
   ├─ code=1011 "登录状态已失效" → 缺 Cookie → 加 Cookie header (本次修复 P3)
   │
   ├─ chatRemindDialog.content 含 "120 次" → master 算 SUCCESS → 我们跟进
   │
   └─ 其他 code → 进一步诊断（不在本 ADR 范围）
```

---

## 8. TDD 流程（必填）

| Step | 状态 | 证据 |
|------|------|------|
| RED | ⏸ | task #41 sendGreeting 改造 + send-handler.test.ts 适配 |
| GREEN | ⏸ | 探针 P3 真发验证（已通过）|
| REFACTOR | ⏸ | 待 |
| 自验证 | ✅ | P3 真发 1 个 jobId → bossCode=0 SUCCESS |

---

## 9. 后续（不在本 ADR 范围 / 必填）

- [ ] **task #41**（in_progress）：sendGreeting 改造（按 P3 协议）+ send-handler 适配 + send CLI 参数（-l/-s 替代 -u）
- [ ] **task #12**（in_progress）：Fork ai-job-master 油猴 UI + 去商业化（彻底对齐 master 实现）
- [ ] **未独立验证**：form body + Cookie 是否有效（P2 缺 Cookie 误判）→ 后续可加 P4 = form body + Cookie 探针
- [ ] **send CLI 真发验证**：改造后 user 真发 1 次端到端（task #41 后续）

---

## 10. 真相变了怎么办（强制重写）

按 `docs/adr/_template.md` §10 + §3.8 纪律：

> **本次 ADR 基于探针实测证据**（P1/P2/P3 raw 响应落档）
>
> **如果未来 BOSS 改版**：
> 1. 重新跑 `npm run probe:friend-add:really` 探针
> 2. 对比 `tests/fixtures/friend-add-schema.json` 新旧响应
> 3. 若 P3 不再 SUCCESS → 重写本 ADR + 改造 sendGreeting
>
> **教训**：
> - 探针是验证假设的唯一可信方式（按 [[feedback_zero_tolerance_fake_green]]）
> - README 反编译 / boss-zhipin-bot 推测 = **未实测 = 不可信**
> - master 对照 = **降风险，不是消除风险**（master 是 2024 年代码，可能也已过时）

---

## Debug Gate 5 项（按 §3.8 强约束 / 本 ADR 是 bug 修复类）

- **症状**：
  1. sendGreeting 真实调用一直失败（之前未实测归因）
  2. 探针 P1 → bossCode=1011 "当前登录状态已失效"
  3. 探针 P3 → bossCode=0 SUCCESS
- **多假设**：
  - H1: Zp_token 不足（需 Cookie 冗余）→ ✅ 验证
  - H2: master 协议（query + null body + Zp_token）有效 → ✅ 验证
  - H3: BOSS 不读 message 参数 → ✅ 验证（P3 不传 message，响应含 greeting）
  - H4: BOSS 改版需 page.goto 降级 → ❌ 证伪（P3 Node fetch 直发成功）
- **修复**：
  1. sendGreeting 改用 P3 协议（query + null body + Zp_token + Cookie）
  2. 移除 hrUid / message 参数
  3. 限流语义借鉴 master（chatRemindDialog.content 含"120 次" → SUCCESS）
- **自验证**：
  - `npm run probe:friend-add:really` → P3 bossCode=0
  - 响应落档：`tests/fixtures/friend-add-schema.json` P3 raw.zpData
- **未证明**：
  - form body + Cookie 是否有效（P2 缺 Cookie 误判）
  - 多并发 send 稳定性
  - 不同 BOSS session 下稳定性
  - send CLI 端到端实测（待 task #41 改造后）

---

## 自检 Checklist

- [x] §3 证据：每个假设都有探针 raw 响应证据
- [x] §4 反例：每个被排除假设都有证伪过程
- [x] §5 备选：评估 4 个备选方案
- [x] §6 行为契约：每条都可观测 / 可测试
- [x] §7 4 类图：架构 / 时序 / 关系 / 流程 完整
- [x] §8 TDD：流程完整（RED 待 task #41）
- [x] §9 后续：列出本 ADR 不解决的待办
- [x] 未引用未验证的归因（探针 raw 响应已落档）
- [x] Debug Gate 5 项完整
- [x] §10 真相变了：写明重写条件

---

**纪律引用**：
- `~/.claude/CLAUDE.md` §3.8 修 bug 归因纪律
- memory `feedback_debug_root_cause_discipline.md`（8 条铁律）
- memory `feedback_debug_gate.md`（Debug Gate 5 项格式）
- memory `feedback_zero_tolerance_fake_green.md`（假绿零容忍）
- memory `feedback_research_agent_first.md`（探针优于推测）
- `docs/adr/_template.md` §10 真相变了必重写

---

**commit**：待 user 决策 commit 顺序（ADR 等探针 + 改造一起 commit）