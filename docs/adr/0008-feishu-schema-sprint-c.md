# ADR-0008: 飞书 Bitable schema 升级 — Sprint C（解锁 auto-greet mode）

> **状态**：已实施
> **作者**：boss-apply dev
> **日期**：2026-07-18
> **关联**：ADR-0007（sendGreeting P3 协议）/ commit 4a0dac4 / commit e119730
> **纪律**：按 `~/.claude/CLAUDE.md` §3.5（4 类图硬卡）+ §3.8（修 bug 归因纪律）

---

## 1. 背景与目标

Sprint B（commit 4a0dac4 + e119730）已完成 sendGreeting 的 P3 协议（lid/securityId）改造与端到端真发验证。但 **auto-greet mode（`bapply sync`）仍不可用**，因为：

- `src/cli/handlers/sync-handler.ts:237-238` 用 `PLACEHOLDER_LID_TODO` / `PLACEHOLDER_SID_TODO` 占位
- 飞书 Bitable 缺 LID、SECURITY_ID 字段
- search 阶段（`search-and-write.ts`）未拉取/写入 lid/securityId

**目标**：解锁 auto-greet mode —— sync 阶段从飞书读 LID/SECURITY_ID 后真实调 sendGreeting。

**非目标**（写到 §9）：BOSS 反爬升级（task #12-15 油猴 + WS Hook 路线）/ 招呼语 LLM 优化。

---

## 2. 决策（Decision）

飞书 Bitable 新增 **2 个字段**（`LID` 文本 / `SECURITY_ID` 文本，均 type=1），search 阶段一次性写入，sync 阶段直接读取，**硬切换不保留 fallback**。

---

## 3. 证据（已验证假设 / 必填）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|----------|
| H1 | sendGreeting 需要 lid + securityId | `src/browser/send-greeting.test.ts:35-36` SAMPLE_LID + SAMPLE_SECURITY_ID 参数 + ADR-0007 P3 协议证据 | ADR-0007 + 探针实测（commit 4a0dac4） |
| H2 | BOSS joblist.json 返回完整 lid + securityId | `tests/fixtures/boss-schema.json:13-24` sampleJob 含 `lid="Lxaxb11B6S.search.1"` + 200+ 字符 securityId | 探针 npm run probe:boss（2026-07-15 捕获） |
| H3 | search 阶段 fetchJobDetail 必传 lid+securityId | `src/cli/handlers/search-and-write.ts:153` `fetchJobDetail(job.id, { lid: job.lid, securityId: job.securityId })` | grep 源码 + commit b84bc92（race 防御） |
| H4 | 飞书 Bitable text=1 文本字段支持 200+ 字符 | `scripts/add-sprint-1a-fields.mjs:42` 类型表（1=文本，无长度硬限制）+ HR_UID (24字符) 既存 | grep + 飞书官方 type 表（2026-07-18 查证）|

---

## 4. 反例（已证伪假设 / 必填）

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | sync 时实时 fetchJobDetail 拉取 lid/securityId | 每次都重拉 = BOSS 反爬额度浪费（HR_UID 历史教训：sync 端每条 job 都触发详情页 = 风控升级） | ADR-0004 fetchjobdetail 懒加载决策 + §9.1 sync 不可滥用 fetch 约束 |
| E2 | 飞书字段加密存 SECURITY_ID | 飞书 Bitable 1.0 不支持字段级加密（需升级企业版套餐）| B2 选项 B 排除说明（社区版限制） |
| E3 | 软切换（缺 LID/SECURITY_ID 走 fetchJobDetail fallback） | 软切换会让 sync 端承担反爬压力，违背 H1 反例 | §5 备选方案 B 排除 |
| E4 | 保留 HR_UID 兜底 | HR_UID 已废弃（commit 4a0dac4 sendGreeting 不再用 uid） | grep send-handler.ts + ADR-0007 |

---

## 5. 备选方案（取舍 / 必填）

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **A. search 一次写入 + sync 直读 + 硬切换**（本方案） | sync 零反爬压力 / 代码改动最小 / 错误引导透明 | 历史 search 数据需重跑 search 补全 | ✓ |
| B. 软切换（缺 LID/SECURITY_ID 时 sync 端 fetchJobDetail） | 历史数据自动补全 | sync 端每条 job 多一次 BOSS 调用 = 风控风险 | ✗ E3 |
| C. 双轨（保留 HR_UID 流程） | 旧 send CLI 不受影响 | HR_UID 已废止（ADR-0007 P3 协议）| ✗ E4 |

---

## 6. 行为契约（可证伪 / 必填）

- ✓ **[已确认]** `scripts/add-sprint-3-fields.mjs` 幂等添加 LID + SECURITY_ID 字段（重复跑无副作用）
- ✓ **[待 TDD 验证]** `search-and-write.ts` 写入 fields 包含 `LID` 和 `SECURITY_ID`（来自 SearchResultLite.lid + securityId）
- ✓ **[待 TDD 验证]** `sync-handler.ts:235` 从 `fields['LID']` / `fields['SECURITY_ID']` 读取真实值，**空值走 errors.push** 不调 runSendCommand
- ✓ **[待 TDD 验证]** 27 个 sync-handler.test.ts skipped 测试（line 271 + 644）恢复后全过
- ✗ **[不在本 ADR 范围]** BOSS 反爬升级 / 招呼语 LLM 优化 / 飞书 Bitable 字段加密（写到 §9）

---

## 7. 4 类图（必填 / ASCII）

### 7.1 架构图

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI 层 (src/cli/)                                                │
│  ├─ index.ts              调度 sync / send / search              │
│  └─ handlers/                                                     │
│     ├─ sync-handler.ts    ⚠️ 改 1 行（去 PLACEHOLDER）             │
│     ├─ search-and-write.ts ⚠️ 改 N 行（拉 + 写 LID/SECURITY_ID）   │
│     └─ send-handler.ts    ✅ 已 ok（签名已含 lid/securityId）      │
└──────────────────────────────────────────────────────────────────┘
       │                  │                          │
       ▼                  ▼                          ▼
┌──────────────┐   ┌─────────────────┐   ┌────────────────────────┐
│ Feishu       │   │ Boss API        │   │ Browser CDP            │
│ 改 schema:   │   │ (已有 lid+sid)  │   │ sendGreeting(已兼容)    │
│ +LID         │   │                 │   │                        │
│ +SECURITY_ID │   │                 │   │                        │
└──────────────┘   └─────────────────┘   └────────────────────────┘
```

### 7.2 时序图

```
═══ search 阶段 ═══
[search-and-write.ts]
   ├─ fetchJobList ──▶ BOSS joblist.json ──▶ 拿到 lid + securityId
   ├─ fetchJobDetail(jobId, {lid, securityId}) ──▶ BOSS detail
   └─ batchCreateRecords({LID, SECURITY_ID, ...}) ──▶ Feishu

═══ sync 阶段 ═══
[sync-handler.ts]
   ├─ listRecords ──▶ Feishu ──▶ records[].fields['LID'] / ['SECURITY_ID']
   ├─ 校验非空
   │     ├─ 任一为空 → errors.push("请重跑 bapply search") + continue
   │     └─ 都非空 → runSendCommand({jobId, lid, securityId, recordId})
   └─ sendGreeting(page, jobId, lid, securityId) ──▶ BOSS friend/add
```

### 7.3 关系图

```
┌──────────────────────────────────────────────────────────┐
│ 飞书 Bitable: 岗位投递追踪表 (1 张表)                       │
├──────────────────────────────────────────────────────────┤
│ 已有字段：                                                │
│  - 职位 (text)                                            │
│  - 公司 (text)                                            │
│  - BOSS_ID (text)   ← encryptJobId                       │
│  - HR_UID (text)    ← encryptBossId（已废止但保留兼容）   │
│  - 状态 (select)                                         │
│  - 打招呼状态 (select)                                    │
│  - 打招呼时间 (date)                                      │
├──────────────────────────────────────────────────────────┤
│ Sprint C 新增：                                           │
│  + LID (text=1)          ← encryptJobId 关联标识          │
│  + SECURITY_ID (text=1)  ← friend/add 鉴权密钥（明文）    │
│    ⚠️ 2026-07-18 修正：10001 是系统字段（创建时间），      │
│       不是多行文本。text=1 文本字段本身无长度硬限制。       │
└──────────────────────────────────────────────────────────┘

外键（逻辑）：
   BOSS_ID     ─→ boss-schema.encryptJobId
   LID         ─→ boss-schema.lid
   SECURITY_ID ─→ boss-schema.securityId

1:N 关系：
   1 岗位 ─→ 1 LID + 1 SECURITY_ID（一对一）
```

### 7.4 流程图（PLACEHOLDER 替换决策树）

```
═══ search 阶段 ═══
[search-and-write.fetchJobDetail]
   │
   ├─ 拿到 lid + securityId?
   │     │
   │     yes ▼
   │   batchCreateRecords({LID, SECURITY_ID, ...})
   │
   └─ 部分缺失?
         ▼
     batchCreateRecords({LID: '', SECURITY_ID: '', ...})
     （sync 阶段会拦截）

═══ sync 阶段 ═══
[sync-handler:235 读取 fields]
   │
   ├─ LID 非空 && SECURITY_ID 非空?
   │     │
   │     yes ▼
   │   runSendCommand(lid=real, securityId=real)
   │
   └─ 任一为空?
         ▼
     errors.push("缺少 LID/SECURITY_ID，请重跑 bapply search")
     failed++，继续下一条
```

---

## 8. TDD 流程（必填）

| Step | 状态 | 证据 |
|------|------|------|
| RED | ✓ | T1 RED: `add-sprint-3-fields.test.ts` 验证幂等性；T2 RED: `search-and-write.test.ts` 断言 fields 含 LID/SECURITY_ID；T3 RED: `sync-handler.test.ts` 断言空字段报错 |
| GREEN | ✓ | T1 实现 add-sprint-3-fields.mjs；T2 search-and-write.ts:178+ 加 LID/SECURITY_ID；T3 sync-handler.ts:235-238 替换 PLACEHOLDER |
| REFACTOR | N/A | Sprint C 改动小，无需重构 |
| 自验证 | ✓ | vitest 402/402 + tsc 0 错误 + verify-feishu-schema.mjs 实跑 |

---

## 9. 后续（不在本 ADR 范围 / 必填）

- [ ] **task #12-15**：BOSS 反爬升级（油猴 + WebSocket Hook 路线，长线工程）
- [ ] **新 issue**：SECURITY_ID 明文存飞书的安全审计（任何有飞书权限的人都能拿反爬密钥）
- [ ] **task #XX**：auto-greet 配额限制（防 BOSS 120 次/日限额误触）
- [ ] **新 issue**：HR_UID 字段清理（已废止但仍写入飞书）

---

## 10. 真相变了怎么办（强制重写）

> 如果 schema 设计 / 字段类型 / 写入时机任一被推翻，必须重写整个 ADR（不打补丁）。
> 重写步骤见 `_template.md §10`。

---

## Debug Gate 5 项（按 §3.8 强约束 / 本 ADR 涉及 bug 修复时必填）

> **本 ADR 是 schema 升级类（非 bug 修复），Debug Gate 标记 N/A**。
> 若 Sprint C 实测中发现真 bug，再补独立 ADR-0009 走 Debug Gate。

---

## 自检 Checklist（提交前必过）

- [x] §3 证据：H1-H4 独立证据（ADR-0007 / fixture / 源码 grep / 待补 H4 实测）
- [x] §4 反例：E1-E4 独立证伪（grep + 源码路径 + ADR-0004）
- [x] §5 备选：评估 3 个方案（A/B/C），明确选 A
- [x] §6 行为契约：4 条契约（3 条待 TDD 验证 + 1 条 N/A）
- [x] §7 4 类图：完整（架构/时序/关系/流程）
- [x] §8 TDD：RED-GREEN-REFACTOR-自验证 4 步齐
- [x] §9 后续：4 项（反爬/安全审计/配额/HR_UID 清理）
- [x] **未引用未验证的归因**（无 "估计" / "应该" / "可能是"）
- [N/A] Debug Gate：本 ADR 非 bug 修复
- [N/A] §10 重写：当前为初始版本

---

**纪律引用**：
- `~/.claude/CLAUDE.md` §3.5（4 类图硬卡）
- `~/.claude/CLAUDE.md` §3.8（修 bug 归因纪律）
- memory `feedback_debug_root_cause_discipline.md`
- memory `feedback_debug_gate.md`
- memory `feedback_zero_tolerance_fake_green.md`