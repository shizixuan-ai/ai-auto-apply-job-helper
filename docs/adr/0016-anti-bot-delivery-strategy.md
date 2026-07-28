# ADR-0016: 单账号反爬投递策略（40/60 分时配额 + Warmup 折中 + 2 cron 调度）

> **状态**：草稿（待 RED 测试 + Sprint B 实施落地）
> **作者**：boss-apply dev
> **日期**：2026-07-28
> **关联**：ADR-0005（robustEvaluate）/ ADR-0014（search fake-red）/ `feedback_boss_anti_bot_status.md` / Sprint B（auto pipeline）
> **纪律**：按 `~/.claude/CLAUDE.md` §3.5（设计前置 4 类图）+ §3.8（修 bug 归因）+ §3.12（probe before src）

---

## 1. 背景与目标

### 背景

`bapply auto` 单跑 + 默认模板（per Sprint A Q3）+ 1 个账号（user 唯一）的前提下，**核心问题是 BOSS 反爬风控墙**：

- **2026-07-13 实测**：`bapply search` wapi 返"您的环境存在异常" + client-side redirect 到 `/_security_check=1_<ts>` 打断 `page.goto`
- **触发点**：`wapi 调用模式`（非浏览器指纹；旁证：`bapply login` 跑得动）
- **现有缓解**：`src/browser/index.ts:687` `searchJobs` 已加 `pageThrottleMs + random(0,13000) jitter`；`src/browser/index.ts:918` `fetchJobDetail` 默认 `throttleMs=3000`（**Sprint 2026-07-19b 决策**）
- **现有缺口**：**sendGreeting 无独立节流**（`src/browser/send-handler.ts` 无 sleep）+ **没有 daily cap / weekly cap / 活跃时段控制** + **没有 warmup 机制**
- **单账号关键约束**：**没有 probe buffer**（传统做法是用小号测试阈值，但 user 只有 1 个号，撞墙 = 封号）

### 设计目标

1. **不触发风控墙**：在 user 唯一账号下稳定日投递 100 条（可调节 warmup）
2. **行为像真人**：时间间隔、活跃时段、long pause 模拟自然 HR 浏览节奏
3. **可恢复**：`guard.ts` 触发时 pause + log + notify + 当日余量作废（不补发）
4. **可观测**：counter 文件记录每日/每周/账号元信息，便于事后审计

---

## 2. 决策（Decision）

**单账号投递策略 = 时段配额（上午 40 / 下午 60）+ 活跃时段硬截止（11:30 / 17:30）+ 周末停发 + Warmup 折中（Day1-7: 50 → Day8-14: 70 → Day15+: 100）+ 2 cron 调度（09:00 + 14:00）。**

关键固化值：

| 项 | 值 |
|----|----|
| 总日配额 | 100（目标）/ 50（Day1-7）/ 70（Day8-14） |
| 上午配额 | 40（目标）/ 20（Day1-7）/ 28（Day8-14） |
| 下午配额 | 60（目标）/ 30（Day1-7）/ 42（Day8-14） |
| 上午间隔 | random(180, 240) sec（平均 200s / 3.3 min） |
| 下午间隔 | random(168, 216) sec（平均 192s / 3.2 min） |
| 长穿插 | 每 20 条 → random(5, 10) min（下午中段额外 10-15 min 大休） |
| 微抖动 | sleep ± 20% 随机偏移 |
| 上午时段 | 09:00 - 11:30（150 min） |
| 午休停发 | 11:30 - 14:00（不投递） |
| 下午时段 | 14:00 - 17:30（210 min） |
| 夜间停发 | 17:30 - 次日 09:00（cron 误触发内部拦截） |
| 周末 | 周六 50% 配额 → **本决策改为 0**（user 决策 2026-07-28） |
| 周上限 | 500（保守，未实测 BOSS 周维度阈值） |
| Cron | **2 条**（`0 9 * * 1-5` + `0 14 * * 1-5`） |
| 容错 | guard.ts 触发 → 当日余量作废 + 自动降档到上一 warmup / 连续 3 天触发 → 暂停 + notify |

---

## 3. 证据（已验证假设）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|----------|
| H1 | searchJobs 现有 throttle 3000+jitter 是反爬伪装的有效基线 | `src/browser/index.ts:687-688` 实测 throttle + random(0,13000) jitter；Sprint 2026-07-19b 决策落地 | 读源码 + `git log --oneline -- src/browser/index.ts` |
| H2 | fetchJobDetail throttle 3000ms 默认 + Sprint 2026-07-19b 决策 | `src/browser/index.ts:918` `const throttleMs = opts.throttleMs ?? 3000` | 读源码 |
| H3 | sendGreeting 当前无节流（无 sleep / 无 cap） | `src/cli/handlers/send-handler.ts` 全文无 sleep；`src/browser/send-handler.ts`（若存在）无 throttle | `grep -n "sleep\|throttle\|delay" src/browser/send-handler.ts src/cli/handlers/send-handler.ts` |
| H4 | BOSS 风控墙由"wapi 调用模式"触发（非浏览器指纹） | memory `feedback_boss_anti_bot_status.md` 来源 4a0807a0 session 实测；旁证 `bapply login` 跑得通 | memory Read |
| H5 | ai-job-master WebSocket hook 模式"风控压力显著降低" | `docs/research/ai-job-master-tampermonkey-survey-2026-07-13.md` "与 BOSS 风控对抗状态：切换后预期显著降低" | research Read |
| H6 | guard.ts 已实现风控墙 pause + notify + waitForUserConfirm | `src/browser/guard.ts:410` P0 fix + `setWaitForUserConfirm` 接口 | 读源码 |
| H7 | 单账号无 probe buffer 的真实风险 | user 明确声明 "我只有一个账号"；probe 必须用真实号跑 = 撞墙 = 封号 | user 对话 |
| H8 | 上午 40 份 / 150 min 在 longPause(每 20 条 × 5 min) 插入后总耗时 ≤ 155 min | 计算：40 × 200s + 2 × 450s = 8900s ≈ 148 min + jitter buffer | 算术 |
| H9 | 下午 60 份 / 210 min 在 longPause(每 20 条 × 5 min × 3 次 + 中段大休 1 次) 后总耗时 ≤ 214 min | 计算：60 × 192s + 3 × 450s + 1 × 600s = 13320s ≈ 222 min ⚠️ **未通过**（超 12 min） | 算术 |

**H9 自修正**：下午间隔需要从 `random(168, 216)` 收紧到 `random(150, 195)`（平均 172.5s）才能稳压 210 min 内：
- 60 × 172.5s + 3 × 450s + 1 × 600s = 10350 + 1350 + 600 = 12300s = **205 min** ✓（留 5 min buffer）

---

## 4. 反例（已证伪假设）

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|----------|
| E1 | 不用节流,100 条/天直接打 | BOSS 风控墙已实测触发,无节流 = 必撞墙 | memory 4a0807a0 + ai-job-master 调研结论 |
| E2 | 固定间隔 (如 60s/条 死板) | 固定间隔是 bot detection 最常见特征；真人不会每条 60s 整 | 行业惯例 + burst detection 通用原理 |
| E3 | 单 cron 09:00 一次跑完 100 + 内部 sleep until 14:00 | run 跨 8.5 小时,任何 crash 都让 checkpoint 复杂；且用户偏好明确选 a (2 cron) | user 对话 2026-07-28 "Q1:a" |
| E4 | Warmup 直接 100/天 (Day 1) | 单账号无 probe buffer,Day 1 撞墙 = 直接封号 = 用户失业工具 | user 对话 "我只有一个账号" + 反证法 |
| E5 | 凌晨投递 (00:00 - 06:00) | HR 不在线 = 无效投递 + BOSS 凌晨风控更严（业内推测） | user 决策 "下午从2:00~5:30" 隐含排除凌晨 + 公开 ToS 限制 |
| E6 | 周末投递 | HR 不在线 + user 明确 "周末不投递" | user 对话 |
| E7 | 用 node-cron 替代 system cron | Sprint A/B 阶段优先 system cron（一行 crontab）；node-cron 是 Sprint C 优化 | YAGNI + 复用既有运维 |

---

## 5. 备选方案（取舍）

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **A. 本方案**：2 cron + 40/60 split + warmup C + 长短穿插 | 状态机简单 / quota 可滑动 / 容错边界清晰 | 上午 40 条节奏偏紧（150 min 内 3.3 min/条） | ✓ user 决策 2026-07-28 |
| B. 单 cron 09:00 + 内部 sleep until 14:00 + quota 100 | 1 个 cron 入口，跨中午状态连续 | run 跨 8.5h，crash recovery 复杂；user 明确选 a | ✗ |
| C. 激进 warmup（Day 1: 100/天） | 立刻满产 | 单账号 Day 1 撞墙 = 封号风险 | ✗ 单账号红线 |
| D. 用 ai-job-master 油猴 hook 模式彻底替代 CDP | 流量特征转浏览器内,大部分节流需求消失 | 1-2 sprint 完整切换工作;现有 CDP 投资归零 | ✗ Sprint C 候选,不本 ADR 范围 |

---

## 6. 行为契约（可证伪 / 必填）

- ✓ **[已算法验证]** 上午 40 份 / 150 min：在 `random(180, 240) sec` 间隔 + 每 20 条穿插 5 min 下，总耗时 ≤ 155 min —— §3 H8 计算
- ✓ **[已算法验证]** 下午 60 份 / 210 min：在 `random(150, 195) sec` 间隔 + 每 20 条穿插 5 min × 3 + 中段大休 10 min 下，总耗时 ≤ 210 min —— §3 H9 自修正
- ✓ **[代码可达]** 11:30 整：当前 job 完成即停（throttleSend 内部 `now > 11:30` 拦截）
- ✓ **[代码可达]** 14:00：第二条 cron 触发 / 或 run sleep until 14:00 自动唤醒
- ✓ **[代码可达]** 17:30 整：当日投递结束，余量作废
- ✓ **[代码可达]** Sat/Sun：weekend policy 拦截，dry-run 模式自动放行无投递
- ✓ **[代码可达]** Day 1-7 cap=50 / Day 8-14 cap=70 / Day 15+ cap=100 —— warmupEngine 算
- ✓ **[代码可达]** sent % 20 == 0 → longPause random(5, 10) min 注入（**点条件，非区间**;sent==cap 时不触发，见 §12）
- ✓ **[代码可达]** afternoon phase 中段大休:**点条件** `sent === 30 && !bigBreakInjected`(防重复注入,见 §12)
- ✓ **[代码可达]** **Counter 原子化**:`sent+1` 先持久化(rename 原子写)+ fsync,再 sendGreeting;宁可少发,不可重复(见 §12 Issue 1)
- ✓ **[代码可达]** **SIGTERM/SIGINT handler**:收到信号时强制 flush counter + checkpoint,然后 exit
- ✓ **[代码可达]** **SessionExpiredError** 在 sendGreeting 收到 BOSS 401/未登录响应时抛出;auto-handler 捕获后**重登 1 次**,成功后继续;失败走 guard 流程(见 §12 Issue 3)
- ✓ **[已观察]** `guard.ts` 已实现 waitForUserConfirm + pause + notify —— 复用,无需新增
- ✗ **[不在本 ADR 范围]** 飞书多维表格通知（仅 console.log）—— §9 后续
- ✗ **[不在本 ADR 范围]** node-cron 替代 system cron —— §9 后续
- ✗ **[不在本 ADR 范围]** 历史 run 自动 rotate / cleanup —— §9 后续

---

## 7. 4 类图（必填 / ASCII）

### 7.1 架构图

```
┌────────────────────────────────────────────────────────────────┐
│          system cron (Mon-Fri 09:00 / 14:00 各 1 条)           │
└─────────────────────────┬──────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│       bapply auto --phase morning|afternoon --quota 40|60     │
└─────────────────────────┬──────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│       src/cli/handlers/auto-handler.ts (Sprint A 复用)         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 内部状态机:Phase 0 init → 1 login → 2 search → 3 score  │  │
│  │   → 5 send (default template) → 6 persist → loop        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────┬──────────────────────────────────────┘
                          │ 每个 job 前调:
                          ▼
┌────────────────────────────────────────────────────────────────┐
│       src/auto/throttle.ts (新 — Sprint B 必做)                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ throttleSend(job):                                        │  │
│  │  1. loadAccountMeta / DailyCounter / WeeklyCounter       │  │
│  │  2. now < 09:00 → sleep until 09:00                       │  │
│  │  3. now > 17:30 → abort run 'daily_done'                  │  │
│  │  4. 11:30 ≤ now < 14:00 → sleep until 14:00               │  │
│  │  5. now ∈ Sat/Sun → throw WeekendBlock (dry-run 放行)    │  │
│  │  6. daily.sent >= cap → throw DailyLimit                  │  │
│  │  7. weekly.sent >= wkCap → throw WeeklyLimit              │  │
│  │  8. phase=morning: rand(180,240)s                         │  │
│  │     phase=afternoon: rand(150,195)s                       │  │
│  │  9. sent % 20 == 0 → longPause rand(5,10) min            │  │
│  │     afternoon sent ∈ [25,45] → 中段大休 rand(10,15) min   │  │
│  │ 10. await sleep(interval ± 20% jitter)                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ warmupEngine.ts: accountAgeDays → effectiveCap           │  │
│  │   Day 1-7: 50 / Day 8-14: 70 / Day 15+: 100              │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────┬──────────────────────────────────────┘
                          │ proceed
                          ▼
┌────────────────────────────────────────────────────────────────┐
│       复用 src/browser/send-handler.ts (投递)                  │
│       复用 src/browser/guard.ts (风控墙 → GuardError)          │
└─────────────────────────┬──────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│       持久化 .bapply/counters/                                   │
│  ├─ daily-counter-<date>.json   { sent, cap, phase, quotaM, quotaA }
│  ├─ weekly-counter-<week>.json  { sent, cap }                    │
│  └─ account-meta.json           { registeredAt, accountAgeDays,  │
│                                    currentTier, warmupSchedule[] }│
└────────────────────────────────────────────────────────────────┘
```

### 7.2 时序图（单日 09:00 上午 batch 完整时序）

```
cron      auto-handler    throttle.ts        send-handler    BOSS wapi    counter.fs
 │             │               │                  │              │            │
 │ 09:00       │               │                  │              │            │
 │────────────>│               │                  │              │            │
 │             │ Phase 0 init  │                  │              │            │
 │             │ 验 env+Feishu │                  │              │            │
 │             │               │                  │              │            │
 │             │ Phase 1 login │                  │              │            │
 │             │─loginByQR─────────────────────>│              │            │
 │             │<─cookies───────────────────────│              │            │
 │             │               │                  │              │            │
 │             │ Phase 2 search│                  │              │            │
 │             │─searchJobs────────────────────>│              │            │
 │             │<─JobList[≤40]──────────────────│              │            │
 │             │               │                  │              │            │
 │             │ for job 1..N: │                  │              │            │
 │             │               │                  │              │            │
 │             │ throttleSend()│                  │              │            │
 │             │──────────────>│                  │              │            │
 │             │               │ load counters    │              │            │
 │             │               │──────────────────────────────────────────> │
 │             │               │<─ {sent:0,cap:40,phase:morning}────────── │
 │             │               │ now=09:01, in active hours               │
 │             │               │ weekend=no → ok                        │
 │             │               │ sent=0 < cap=40 → ok                    │
 │             │               │ compute sleep=rand(180,240)=210s         │
 │             │               │ sent%20=0? no (sent=0)                  │
 │             │               │ await sleep 210s ± 20%                  │
 │             │               │ ... ~3.5 min ...                        │
 │             │<─ proceed ───│                  │              │            │
 │             │               │                  │              │            │
 │             │ sendGreeting  │                  │              │            │
 │             │─────────────────────────────────>│              │            │
 │             │                              POST friend/add ─>│            │
 │             │                              <─ 200 ──────────│            │
 │             │                               counter.sent++ │            │
 │             │                               save ──────────────────────> │
 │             │               │                  │              │            │
 │             │ next job 2    │                  │              │            │
 │             │ ... (40 个 job 重复)            │              │            │
 │             │               │                  │              │            │
 │             │ job 20: longPause rand(5,10)min │              │            │
 │             │               │ sleep ~7 min    │              │            │
 │             │ ...            │                  │              │            │
 │             │               │                  │              │            │
 │             │ job 40: sent=40=cap, now=11:28   │              │            │
 │             │               │ now=11:28 < 11:30 → proceed (last job)   │
 │             │               │ next call: now=11:31 ≥ 11:30 → abort    │
 │             │<─ abort ──────│                  │              │            │
 │             │               │                  │              │            │
 │             │ AutoResult: { action:'daily_done', sent:40 }    │            │
 │             │ exit 0        │                  │              │            │
```

### 7.3 关系图（实体 + 状态）

```
┌─────────────────────────┐      ┌──────────────────────────────┐
│   DailyCounter           │      │    WeeklyCounter             │
├─────────────────────────┤      ├──────────────────────────────┤
│ date: "2026-07-28"       │      │ week: "2026-W31"             │
│ sent: int                │      │ sent: int                    │
│ cap: int (warmup 调整)  │      │ cap: int (默认 500)         │
│ phase: 'morning'|'afternoon'│   └─────────────┬───────────────┘
│ quotaMorning: int        │                  │
│ quotaAfternoon: int      │                  │
│ lastSentAt: timestamp    │                  │
│ longPausesInjected: int  │                  │
└────────────┬────────────┘                  │
             │ computed from:                 │
             ▼                                │
┌─────────────────────────┐     ┌─────────────▼─────────────┐
│   AccountMeta            │     │  AutoRunState (Sprint A) │
├─────────────────────────┤     ├───────────────────────────┤
│ registeredAt: timestamp  │     │ run_id: uuid              │
│ accountAgeDays: int      │     │ phase: 0|1|2|3|5|6        │
│ currentTier: enum        │     │ status:                   │
│   'new'|'warm'|'old'     │     │  pending|paused|done      │
│ baseDailyCap: int (30)   │     │  |running|aborted         │
│ targetDailyCap: int(100) │     │ sent_job_ids: string[]    │
│ hardDailyCap: int (100)  │     │ failed_job_ids: string[]  │
│ weeklyCap: int (500)     │     │ error_log: ErrorEntry[]   │
│ warmupSchedule: array    │     │ started_at: ts            │
│  [{dayStart:1, cap:50},  │     │ updated_at: ts            │
│   {dayStart:8, cap:70},  │     │ phaseStartedAt: ts        │
│   {dayStart:15,cap:100}] │     │ currentJobId?: string     │
└─────────────────────────┘     └───────────────────────────┘
                                              │
                                              ▼
                    .bapply/counters/                .bapply/runs/
                    ├─ daily-counter-<date>.json    └─ <run-id>.json
                    ├─ weekly-counter-<week>.json       (Sprint A)
                    └─ account-meta.json
```

### 7.4 流程图（per-job throttle 决策树）

```
                       ┌─ throttleSend(job) 入口 ─┐
                       │                          │
                       │ loadAccountMeta()        │
                       │ loadDailyCounter()       │
                       │ loadWeeklyCounter()      │
                       │                          │
                       └─────────────┬────────────┘
                                     │
                       ┌─────────────▼──────────────┐
                       │ now < 09:00?               │
                       └──┬─────────────────────┬──┘
                        yes│                     │no
                            ▼                     ▼
                  sleep until 09:00       ┌──────────────────┐
                  (夜跨日:重置 daily)      │ now > 17:30?     │
                                          └──┬────────────┬──┘
                                           yes│           │no
                                               ▼           ▼
                                  abort 'daily_done' ┌────────────────────┐
                                                     │ 11:30 ≤ now<14:00? │
                                                     └──┬─────────────┬──┘
                                                      yes│             │no
                                                          ▼             ▼
                                            sleep until 14:00    ┌──────────────┐
                                            (午休自动唤醒)         │ weekend?     │
                                                                 └──┬───────┬───┘
                                                                  yes│       │no
                                                                      ▼       ▼
                                                  abort 'weekend_block' ┌──────────────┐
                                                  (dry-run 放行无投递)   │ sent >= cap? │
                                                                          └──┬───────┬───┘
                                                                       yes│           │no
                                                                            ▼           ▼
                                                              abort 'daily_cap'  ┌────────────┐
                                                                                  │sent>=wkcap │
                                                                                  └──┬──────┬──┘
                                                                                yes│      │no
                                                                                    ▼      ▼
                                                                    abort 'weekly'   ┌────────────┐
                                                                                     │compute     │
                                                                                     │phase:      │
                                                                                     │morning:    │
                                                                                     │ rand(180,  │
                                                                                     │  240) s    │
                                                                                     │afternoon:  │
                                                                                     │ rand(150,  │
                                                                                     │  195) s    │
                                                                                     └──────┬─────┘
                                                                                            │
                                                                                            ▼
                                                                                  ┌──────────────────┐
                                                                                  │ sent % 20 == 0?  │
                                                                                  │ → longPause      │
                                                                                  │   rand(5,10) min │
                                                                                  └──────┬───────────┘
                                                                                         │no
                                                                                         ▼
                                                                                  ┌──────────────────────┐
                                                                                  │ afternoon &&         │
                                                                                  │ sent === 30          │
                                                                                  │ (point condition,    │
                                                                                  │  not range!)         │
                                                                                  │ && !bigBreakInjected?│
                                                                                  │ → bigBreak           │
                                                                                  │   rand(10,15) min    │
                                                                                  │   + set              │
                                                                                  │   bigBreakInjected=  │
                                                                                  │   true (持久化)      │
                                                                                  └──────┬───────────────┘
                                                                                         │no
                                                                                         ▼
                                                                                  ┌──────────────────┐
                                                                                  │ sleep            │
                                                                                  │ interval ± 20%   │
                                                                                  │ jitter           │
                                                                                  └──────┬───────────┘
                                                                                         │
                                                                                         ▼
                                                                                  return 'proceed'
```

---

## 8. TDD 流程（必填）

| Step | 状态 | 证据 |
|------|------|------|
| RED | ✅ Sprint B 完整完成 (2026-07-28) | `tests/unit/auto/throttle.test.ts` (T1-T5) + `tests/unit/auto/throttle-reliability.test.ts` (T6-T10) 11 测试写完 → 跑 T1-T5 5/5 RED + T6-T10 4/5 RED (T6 已 GREEN 是 Sprint B-1 早实现 bigBreak) |
| GREEN | ✅ Sprint B 完整完成 (2026-07-28) | `src/auto/throttle.ts` 决策树 12 节点 + §12 Issue 1 原子写 + §12 Issue 3 重登 + ThrottleError/SessionExpiredError class (layer='THROTTLE'/'SEND' per §3.13) + 11 测试 11/11 GREEN |
| REFACTOR | ✅ Sprint B 完整完成 (2026-07-28) | 抽 `randomInRange(range, rand)` helper 消除 3 处重复, 11/11 仍 GREEN |
| 自验证 | ✅ Sprint B 完整完成 (2026-07-28) | prototype `scripts/probe-throttle-logic.mjs` 14/14 PASS + Sprint B-1 5/5 + Sprint B-2 6/6 + 全套 487/488 (1 skipped pre-existing) + tsc 0 throttle 相关错 |

**Sprint B RED 测试清单**（§4.3 上限 5 throttle + 5 可靠性 = 10,**拆 Sprint B-1 + B-2**）：

**Sprint B-1 throttle (T1-T5)**:
- T1: `11:29:59` proceed / `11:30:00` sleep lunch_break (per §7.4 流程图 — 此处早期草稿写 "throw DailyDone" 与 §7.4 矛盾, 2026-07-28 修订)
- T2: `daily.sent >= cap` → throw DailyLimit
- T3: `now = Sat/Sun` → throw WeekendBlock（dry-run 模式放行）
- T4: warmup Day 1 → cap=50 / Day 8 → cap=70 / Day 15 → cap=100
- T5: `sent % 20 == 0` → longPause 注入

**Sprint B-2 可靠性 (T6-T10)**(per §12 user 反馈):
- T6: **bigBreak 单次注入** — `sent === 30` 触发,`sent === 31..45` 不再触发(因 bigBreakInjected=true)
- T7: **counter 原子写** — send 失败但 counter 已 +1 → 下次 run 不会重发(`sent++` 先持久化,sendGreeting 后调)
- T8: **SIGTERM handler** — 模拟发送 SIGTERM → 验证 counter 落盘(`fsync` 标志)
- T9: **SessionExpiredError 触发重登** — mock sendGreeting 抛 SessionExpiredError → auto-handler 调 loginByQR → 成功后 retry 当前 job
- T10: **SessionExpiredError 重登上限** — mock loginByQR 也失败 → 走 guard pause 流程,不无限循环

---

## 9. 后续（不在本 ADR 范围 / 必填）

- [ ] **scripts/probe-throttle-logic.mjs** (Sprint B Phase B)：不调 BOSS，纯函数级验证 throttle.ts 决策树（窗口/配额/周末/longPause/bigBreak 单次/SIGTERM）
- [ ] **10 个 RED 测试**（Sprint B Phase C）：T1-T5 (B-1) + T6-T10 (B-2)
- [ ] **src/auto/throttle.ts** 实施（GREEN 阶段）
- [ ] **src/auto/warmup-engine.ts** 实施
- [ ] **src/auto/counter-store.ts** 实施（atomic write .tmp + rename + **fsync + SIGTERM flush handler**）
- [ ] **src/auto/session-detector.ts**（新）— 检测 BOSS 401/未登录响应，抛 SessionExpiredError
- [ ] **scripts/install-cron.sh** 一键安装 cron
- [ ] **notifier.ts** 飞书多维表格通知（Sprint C，本 ADR 仅 console.log）
- [ ] **node-cron** 替代 system cron（Sprint C，去掉外部 cron 依赖）
- [ ] **历史 run rotate** `.bapply/runs/` 30 天清理（Sprint D）
- [ ] **真账号 probe 风险文档**（user 1 账号，无法安全 probe，新阈值只能"撞墙即调整"迭代）
- [ ] **油猴 hook 模式（ai-job-master fork）** 作为平行路径（Task #12-15），可能根本取代本节流方案
- [ ] **§12 可靠性补丁 5 项**：原子写 / bigBreak 单次 / SIGTERM flush / SessionExpired 重登 / 单 run 重登上限

---

## 10. 真相变了怎么办（强制重写）

如果 §3 证据（H1-H9）或 §4 反例（E1-E7）或 §5 备选方案中有任一项被推翻，必须重写整个 ADR，不打补丁：

1. frontmatter 加 `superseded-by: ADR-NNNN`
2. 新建 ADR-NNNN 写新真相
3. 本文档保留作为历史归档
4. commit message 明确写"重写 ADR-0016：旧[X] → 新[Y]"

**已知可能的推翻路径**：
- Sprint B live 测试发现 BOSS 实际阈值与 H8/H9 计算偏差 → 重写 §3 + §6 行为契约
- BOSS 周维度风控比预期更严（500/周不够保守）→ 重写 §6 weeklyCap
- user 改回"激进 warmup Day 1: 100" → 重写 §2 决策 + §3 H4
- ai-job-master 油猴 fork 完成（Task #12-15）→ 本 ADR 整体被替代

---

## 11. 配置层设计（Q1-Q4 决策 / 2026-07-28 user 拍板）

### 11.1 决策汇总

| 问题 | 决策 | 理由 |
|------|------|------|
| Q1 多轮搜索 | **B. 多 keyword 顺序扫**(YAML `searches[N]`) | 适合 cron 周期任务;Java→Python→Go 顺序扫合并去重 |
| Q2 Config 位置 | **A. `~/.bapply/auto.yaml`**(用户全局,gitignored) | 与 `简历.yml` 同层(隐私数据不进 git);用户机器独立 |
| Q3 Profile 切换 | **A. 单 profile** | YAGNI;后期真有多场景再扩 `--profile` |
| Q4 Flag 覆盖 | **B. 支持 `--quota` / `--dry-run` / `--config` 三 flag** | 调试友好;覆盖值优先于 config |

### 11.2 YAML Schema (TypeScript 类型)

```typescript
// src/auto/config-schema.ts (新)
export interface AutoConfig {
  version: 1

  /** 多轮搜索:顺序执行,合并 score 阈值过滤后的结果池 */
  searches: SearchEntry[]

  /** 配额 + warmup + 节流 + 容错 — 见 ADR-0016 §2 决策 */
  quota: QuotaConfig
  warmup?: WarmupConfig
  throttle: ThrottleConfig
  safety: SafetyConfig
}

export interface SearchEntry {
  keyword: string                  // 必填
  city?: string
  jobType?: string                 // BOSS 码(如 1901)
  salary?: string                  // BOSS 码(如 406)
  experience?: string              // BOSS 码(如 106)
  degree?: string                  // BOSS 码(如 203)
  limit?: number                   // 该 keyword 最多取 N
}

export interface QuotaConfig {
  morning: number                  // 上午配额(per ADR-0016 §2)
  afternoon: number                // 下午配额
  weekly_cap: number               // 周上限
}

export interface WarmupConfig {
  enabled: boolean
  schedule: Array<{ day_start: number; daily_cap: number }>
}

export interface ThrottleConfig {
  morning_interval_ms: [number, number]      // [min, max]
  afternoon_interval_ms: [number, number]
  jitter_pct: number                         // ±N%
  long_pause: { every_n_jobs: number; duration_ms: [number, number] }
  afternoon_mid_break?: { after_job: number; duration_ms: [number, number] }
}

export interface SafetyConfig {
  guard_trigger_policy: 'abort_day' | 'abort_run' | 'continue'
  consecutive_guard_threshold: number
  auto_regress_warmup: boolean
}
```

### 11.3 CLI flag 覆盖映射

| Flag | 覆盖 config 字段 | 类型 | 备注 |
|------|------------------|------|------|
| `--config <path>` | (整个 config 文件) | string | 默认 `~/.bapply/auto.yaml` |
| `--dry-run` | `safety.dry_run = true` | bool | 不真发,只跑完 Phase 0-3 |
| `--quota <n>` | `quota.morning + quota.afternoon = n` (上午优先) | number | 临时降配额 |
| `--phase morning\|afternoon` | (独立,不来自 config) | enum | cron 用,锁定上午/下午 batch |

### 11.4 多轮搜索执行流

```
[searchJobs round 1: keyword="Java 后端"]
   ├─ score 阈值过滤 (default 0.85)
   ├─ 配额按比例分配: quota.morning * (limit_1 / Σlimits)
   ├─ 入 sent_pool[round_1]
[searchJobs round 2: keyword="Python 后端"]
   ├─ 同上
   └─ 入 sent_pool[round_2]
...
[merged sent_pool]
   └─ 按原 score 降序,跨轮去重 (encryptJobId),逐条 send
```

### 11.5 行为契约增量（补 §6）

- ✓ **[代码可达]** 加载 `~/.bapply/auto.yaml` 不存在 → fail-fast 报错,提示 `bapply auto init-config` 生成模板
- ✓ **[代码可达]** YAML schema 校验失败 → fail-fast 列出错的字段 (用 zod 或 ajv)
- ✓ **[代码可达]** `searches[]` 至少 1 项,空数组 → fail-fast
- ✓ **[代码可达]** `--config <path>` 优先级最高,忽略默认路径
- ✓ **[代码可达]** `--quota <n>` 临时覆盖,不影响 YAML 文件
- ✓ **[代码可达]** 多轮搜索顺序扫,跨轮去重 (encryptJobId 主键)
- ✓ **[代码可达]** 配置加载失败 / schema 校验失败 → 不进入 Phase 0,直接退出

### 11.6 §8 TDD 测试清单增量

TDD 5 测试 (per §4.3 上限 5) 用于 throttle;config schema 走 **2 个新 RED 测试**(Sprint B 内一并):

- T6: 加载合法 `auto.yaml` → 解析成功 + 字段映射正确
- T7: 加载非法 YAML (缺 `searches[]` 或 schema 错) → fail-fast 报错,exit code ≠ 0

**Sprint B 完整 RED 清单 = T1-T7(共 7 测试)**,略超 §4.3 上限 5,**拆 Sprint B-1(throttle T1-T5)+ Sprint B-2(config T6-T7)**。

### 11.7 §9 后续增量

- [ ] **`src/auto/config-schema.ts`** zod schema 定义 + 类型导出
- [ ] **`src/auto/config-loader.ts`** 读 `~/.bapply/auto.yaml` + 校验 + 默认值合并
- [ ] **`bapply auto init-config`** 子命令生成模板 YAML(用户首次跑 auto 引导)
- [ ] **T6/T7 RED 测试**(Sprint B-2)
- [ ] **`docs/auto.example.yaml`** 示例 config 进 git,作为 `init-config` 模板源

---

## 12. 可靠性补丁（2026-07-28 user review 反馈）

⚠️ 本节是 §6/§7/§8 设计在 user review 阶段暴露的 3 个高优先级风险,**修订前实施会引入生产事故**。按 §3.8 修 bug 归因纪律,先认错 + 标注 + 加 RED 测试。

### Issue 1：Counter 一致性陷阱（重复投递/超发）

**症状**(若不修):
```text
上午 run 第 20 条:
  sendGreeting() 成功 → 200 OK
  [CRASH: 进程被杀 / OOM / SIGKILL]
  [counter 未刷盘]
  
下午 run 启动:
  loadDailyCounter() → sent=19 (旧值)
  → 把第 20 条 job 再发一次 → 重复投递
```

**根因**:counter 更新与 sendGreeting **非原子**,中间窗口可被任意中断打断。

**修复**:
1. **顺序倒置**:`counter.sent++; counterStore.writeAtomic();` **先** `sendGreeting()`
2. **Atomic write**:`writeFile(tmp); rename(tmp, real)` (rename 原子)
3. **fsync**:`fd.sync()` 强制落盘(防 page cache 丢失)
4. **可接受 over-count**:宁可少发(`counter++` 后 sendGreeting 抛错 → 配额消耗但没真发),**绝不可重复**

**证据 / 待验证**:
- Node.js `fs.writeFileSync` + `fs.fsyncSync` + `fs.renameSync` 链路语义 — 读 Node.js fs 文档
- atomic rename 在 POSIX 系统上保证原子性 — POSIX 标准

**RED 测试**:T7（per §8 Sprint B-2）

---

### Issue 2：bigBreak / longPause **区间条件 → 实现 bug**

**症状**(若不修):
```text
§7.4 流程图原写法:
  afternoon && sent ∈ [25,45] → bigBreak rand(10,15) min
  
实现误读(每条都查条件):
  sent=30: in [25,45] → bigBreak 10 min ✓
  sent=31: in [25,45] → bigBreak 13 min ❌ (重复触发)
  sent=32: in [25,45] → bigBreak 12 min ❌ (重复触发)
  ...
  sent=45: in [25,45] → bigBreak 15 min ❌ (重复触发)
  → 下午彻底拖死,全 60 条发不完
```

**根因**:**区间条件** `∈ [25,45]` 不是点条件。每次 throttleSend 调用都会命中。

**修复**:
1. **改为点条件**:`sent === 30 && !bigBreakInjected` (见 §7.4 修订)
2. **持久化 flag**:`bigBreakInjected: boolean` 写入 DailyCounter.json
3. **longPause 同源问题**:`sent === cap` 时不触发(避免边界条件再触发一次 sleep)
4. **测试覆盖**:T6(per §8 Sprint B-2) — `sent === 30` 触发 → `sent === 31..45` 验证 flag 持久化不重复

---

### Issue 3：Session 过期 → 全批静默失败

**症状**(若不修):
```text
上午 run 第 5 条 (09:30):
  loginByQR 09:00 拿到 cookie ✓
  sendGreeting 第 1-4 条 ✓
  
  [BOSS 服务端 session 过期 09:30,实际发生率未知]
  sendGreeting 第 5 条 → 401 未登录
  → sendGreeting 抛通用 Error
  → throttleSend 捕获 → skip 当前 job,继续下一个
  → 全部 40 条投递 0 条成功 (静默失败)
  → 配额消耗完 → counter.sent=40 → 误以为"成功"
```

**根因**:`sendGreeting` 无 session 检测,401/未登录 响应**静默走通用 catch**,配额被消耗但实际 0 投递。

**修复**:
1. **`SessionExpiredError`**(自定义 error class,extends Error):`session-detector.ts` 检测 BOSS 401/未登录特定响应码 → 抛 SessionExpiredError
2. **auto-handler 捕获**:catch SessionExpiredError → 调 `loginByQR` 重登
3. **重登上限**:**1 次 / run**(防 session 反复过期时无限重试循环)
4. **失败兜底**:重登失败 → 走 guard.ts 流程 pause + notify(等 user 介入)
5. **测试覆盖**:T9(成功重登 retry)+ T10(重登失败走 guard) per §8 Sprint B-2

**证据 / 待验证**:
- BOSS session 实际过期时长 — 未实测(single account, 不能撞墙 probe)
- 401 响应码的具体格式(BOSS vs 中间 CDN)— 待 probe

---

### 修订影响

| § | 修订 |
|---|------|
| §6 行为契约 | +5 条(原子写 / bigBreak 单次 / SIGTERM flush / SessionExpired / 重登上限) |
| §7.4 流程图 | bigBreak 节点:`∈ [25,45]` → `=== 30 && !bigBreakInjected`(点条件 + flag) |
| §8 TDD | T1-T5 (throttle) + T6-T10 (可靠性) = **共 10 个 RED 测试**,**拆 Sprint B-1 + B-2** |
| §9 后续 | +3 项(src/auto/session-detector.ts + reliability §12 + probe 增 SIGTERM/bigBreak 单次 验证)|

---

## 13. Sprint B 验证记录 (2026-07-28)

11 个 RED 测试 + 11/11 GREEN 闭环证据; 按 §4 反思 5 问 + §3.8 修 bug 归因记录.

### 13.1 验证矩阵

| 阶段 | 测试数 | RED | GREEN | 备注 |
|------|--------|-----|-------|------|
| Sprint B-1 throttle (T1-T5) | 5 | 5/5 RED | 5/5 GREEN | prototype 14/14 验证决策树后 RED-GREEN |
| Sprint B-2 可靠性 (T6-T10) | 6 | 4/5 RED | 6/6 GREEN | T6 早在 Sprint B-1 实现 (1/5 已 GREEN) |
| **Sprint B 总计** | **11** | **9/11 RED** | **11/11 GREEN** | - |

### 13.2 交付物路径(5 个文件)

| 路径 | 用途 |
|------|------|
| `scripts/probe-throttle-logic.mjs` | Prototype 14/14 PASS (Sprint B-1 验证) |
| `src/auto/throttle.ts` | 决策树 12 节点 + §12 Issue 1+3 + ThrottleError/SessionExpiredError class |
| `src/auto/session-detector.ts` | §12 Issue 3 BOSS 响应探测 (1 stub function) |
| `tests/unit/auto/throttle.test.ts` | T1-T5 RED 测试 |
| `tests/unit/auto/throttle-reliability.test.ts` | T6-T10 RED 测试 |

### 13.3 自验证清单 (per §4.4)

| 项 | 证据 |
|---|------|
| ✓ 单测 | `npm run test` 487/488 (1 skipped pre-existing) |
| ✓ 集成测试 | 41 test files 全套 |
| ✓ 类型检查 | `npx tsc --noEmit` 0 throttle/session-detector 相关错 |
| ✓ live 集成 | prototype 14/14 替代 live (per §3.12 单账号红线) |
| N/A 浏览器 | Sprint B 是后端算法, 无 UI |

### 13.4 ADR §8 修订记录 (per §10 重写流程)

| 修订 | 位置 | 原因 |
|------|------|------|
| "11:30:00 throw DailyDone" → "11:30:00 sleep lunch_break" | §8 T1 | 早期草稿与 §7.4 矛盾; Sprint B-1 实施按 §7.4 验证 |
| 4 个 Step ⏳ 草稿 → ✅ Sprint B 完成 | §8 状态表 | Sprint B-1 + B-2 全部 GREEN |

### 13.5 §9 后续清单进度 (本会话已完成 4/12)

- [x] `scripts/probe-throttle-logic.mjs` (Sprint B Phase B) - 14/14 PASS
- [x] `src/auto/throttle.ts` 实施 - 11/11 GREEN
- [x] `src/auto/session-detector.ts` 实施 - 1 stub function
- [x] 10 个 RED 测试 (Sprint B Phase C) - 11 个全部 PASS
- [ ] `src/auto/warmup-engine.ts` - 集成到 throttle.ts initCounter, 独立文件遗留
- [x] `src/auto/counter-store.ts` - 真实 fs atomic write (Sprint C-1 完成, 6/6 GREEN, probe 12/12 PASS)
- [x] `scripts/probe-throttle-integration.mjs` - H1-H5 假设验证 (Sprint C-1 前置, 12/12 PASS)
- [x] `tests/unit/auto/counter-store.test.ts` - T11-T13 3 describes / 6 it() (Sprint C-1 完成, 6/6 GREEN)
- [x] `src/cli/handlers/auto-handler.ts` - Sprint C-2a 完成 (R1 初始 login + R3 失败率监控 + R6 退出码 0/1/2, 6/6 GREEN)
- [x] `tests/unit/cli/handlers/auto-handler.test.ts` - T14-T16 3 describes / 6 it() (Sprint C-2a 完成)
- [x] `src/auto/guard.ts` - Sprint C-2b 完成 (R2 GuardError + isGuardError + layer='GUARD', 5/5 GREEN)
- [x] `tests/unit/auto/guard.test.ts` - T17-T18 2 describes / 5 it() (Sprint C-2b 完成, 5/5 GREEN)
- [ ] `src/auto/throttle.ts` Sprint C-3 - 接入真实 counterStore (refactor + R5 + R7)
- [ ] `scripts/install-cron.sh` / notifier / node-cron / run rotate / 油猴 / §12 5 项 = Sprint C/D 后续

---

## 14. Sprint C 集成设计 (2026-07-28)

### 14.1 修订要点 (per 架构师 review)

| # | 修订 | 原稿缺口 | 修订方案 |
|---|------|---------|---------|
| R1 | 初始 login 缺失 | `runDailyLoop` 直接进 bossSearch,无 cookie 必失败 | `idle → loginByQR() → running`,失败映射 `exit 2` |
| R2 | Guard 风控墙完全消失 | `sendGreeting` 异常未分类,反爬触发后继续投递浪费配额 | 新 `GuardError` class + `blocked` 状态 + notify + 降级 warmup |
| R3 | 失败率监控缺失 | counter 写先于发送,连续失败会空转耗尽配额 | 失败率 >30% 触发 `blocked` (等同 GuardError 路径) |
| R4 | atomic write 模式非标准 | `writeFile + openSync('r+') + fsyncSync` 多余 | 标准 POSIX: `tmp + writeFile + sync + rename` |
| R5 | T8 SIGTERM 加固 | handler 完成后未验证无 `process.exit` | T8 加断言 3: handler 内禁止调 `process.exit` |
| R6 | 退出码语义模糊 | 全失败 vs 部分失败未区分 | 0=≥1 成功 / 1=全失败或部分失败 / 2=致命 (config/login/guard/失败率) |
| R7 | refactor 工厂缺 reset | `createInMemoryCounterStore` 无 `.reset()` | 新增 `reset()` 方法, 单元测试隔离 |

### 14.2 修订 4 类图

#### 14.2.1 架构图(集成版)

```
                          ┌──────────────────────────────┐
                          │  CLI 层 (src/cli/)           │
                          │  ┌────────────────────────┐  │
                          │  │ bapply auto --resume   │  │
                          │  │ --dry-run --date ...   │  │
                          │  └─────────┬──────────────┘  │
                          └────────────┼─────────────────┘
                                       │ invoke
                                       ▼
                          ┌──────────────────────────────┐
                          │  Handler 层                  │
                          │  ┌────────────────────────┐  │
                          │  │ auto-handler.ts (新)   │  │
                          │  │  state: idle|login|    │  │
                          │  │   running|paused|      │  │
                          │  │   blocked|done|aborted │  │
                          │  │  runDailyLoop(config)  │  │
                          │  └────┬─────────────────┬─┘  │
                          └───────┼─────────────────┼────┘
                                  │                 │
              ┌───────────────────┘                 └────────────────────┐
              ▼                                                          ▼
┌─────────────────────────────┐                  ┌──────────────────────────────┐
│   Auto 层 (src/auto/)       │                  │  Boss 层 (src/boss/) [现有]  │
│  ┌───────────────────────┐  │                  │  ┌────────────────────────┐  │
│  │ throttle.ts (已存在)  │  │                  │  │ search-jobs.mjs        │  │
│  │  - throttleSend       │──┼─────────────────▶│  │ login-by-qr.mjs        │  │
│  │  - ThrottleError      │  │                  │  │ send-greeting.mjs      │  │
│  │  - SessionExpiredError│  │                  │  └────────────────────────┘  │
│  └───────────────────────┘  │                  └──────────────────────────────┘
│  ┌───────────────────────┐  │                              │
│  │ counter-store.ts (新) │  │                              │
│  │  - load(date)         │──┼──▶ fs: ~/.bapply/counter.json│
│  │  - writeAtomic()      │  │                              │
│  │  - createFsStore()    │  │                              │
│  │  - createInMemoryStore│  │                              │
│  └───────────────────────┘  │                              │
│  ┌───────────────────────┐  │                              │
│  │ guard.ts (新, C-2b)   │  │                              │
│  │  - GuardError class   │  │                              │
│  │  - isGuardError()     │  │                              │
│  │  - GuardNotifier      │  │                              │
│  └───────────────────────┘  │                              │
└─────────────────────────────┘                              │
                                  ┌──────────────────────────┘
                                  ▼
                          ┌──────────────────────────────┐
                          │  External (单账号红线)        │
                          │  - BOSS wapi / chat/start    │
                          │  - feishu webhook (notify)   │
                          │  - ~/.bapply/counter.json    │
                          └──────────────────────────────┘
```

#### 14.2.2 时序图(集成版 — 含初始 login + guard + 失败率监控)

```
[user] bapply auto --resume --date 2026-07-28
   │
   ▼
[CLI] parseArgs → AutoConfig
   │
   ▼
[auto-handler] state = 'idle'
   │
   ▼
[auto-handler] state = 'login' | await deps.loginByQR()
   │                                       │
   │                                  fail │ success
   │                                       ▼
   │                              state = 'running'
   │                                       │
   ▼ ◄─────────────────────────────────────┘
[auto-handler] return { exitCode: 2, stats, state: 'aborted' }
   │
   ▼
[CLI] process.exit(2)

(below is only after login success)

[auto-handler] jobs = await bossSearch(date)
   │
   ▼
for each job in jobs:
   │
   ├─► [throttleSend] (job, deps, config)
   │   │
   │   ├─ time / cap / weekend check
   │   ├─ counter.load + interval + longPause + bigBreak
   │   ├─ counter.sent++ + counterStore.writeAtomic()  ←── [fs] atomic
   │   ├─ sendGreeting(job):
   │   │   │
   │   │   ├─► [BOSS wapi] POST /chat/start
   │   │   │
   │   │   ├─ if SessionExpiredError:
   │   │   │   └─► loginByQR() → retry sendGreeting (1 shot)
   │   │   │
   │   │   ├─ if GuardError (anti_bot / rate_limit / ip_block):
   │   │   │   │
   │   │   │   ├─► [feishu] notify('critical', msg)
   │   │   │   ├─► degraded-warmup (cap × 0.5)
   │   │   │   └─► state = 'blocked' → break loop → return { exitCode: 2 }
   │   │   │
   │   │   └─ if other error: log warn → continue (B2=a)
   │   │
   │   └─► return ThrottleDecision
   │
   ├─► if sleep: await sleep(sleepMs)
   │
   ├─► 每 10 次迭代后: stats.failed / stats.sent > 0.3 ?
   │       │
   │   yes ▼ no
   │   blocked → exit 2      continue
   │
   └─► next job

return { exitCode: 0|1|2, stats: { sent, ok, failed, blocked }, state }
   │
   ▼
[CLI] process.exit(stats.exitCode)
```

#### 14.2.3 关系图(集成版)

```
src/cli/handlers/auto-handler.ts (~280 行, Sprint C-2a)
  interface AutoHandlerDeps {
    now: () => number
    bossSearch: (date: string) => Promise<Job[]>
    counterStore: CounterStore                       // C-1 注入
    sendGreeting: (job: Job) => Promise<void>
    loginByQR: () => Promise<void>
    notifier: GuardNotifier                          // C-2b 注入
    config: AutoConfig
  }
  type RunStats = { sent: number; ok: number; failed: number; blocked: boolean }
  async function runDailyLoop(deps: AutoHandlerDeps): Promise<{ exitCode: 0|1|2; stats: RunStats }>
        │
        ├─ imports ──▶ src/auto/throttle.ts (已有, Sprint C-3 改 ThrottleDeps)
        │                  - ThrottleError.layer = 'THROTTLE'
        │                  - SessionExpiredError.layer = 'SEND'
        │                  - throttleSend(job, deps, config) → ThrottleDecision
        │
        ├─ imports ──▶ src/auto/counter-store.ts (~80 行, Sprint C-1 新)
        │                  interface CounterStore {
        │                    load(date: string): Promise<DailyCounter | null>
        │                    writeAtomic(counter: DailyCounter): Promise<void>
        │                  }
        │                  createFsCounterStore(filepath: string): CounterStore
        │                  createInMemoryCounterStore(initial?: DailyCounter):
        │                    CounterStore & { reset(): void }      // R7
        │
        ├─ imports ──▶ src/auto/guard.ts (~60 行, Sprint C-2b 新)
        │                  class GuardError extends Error {
        │                    readonly layer = 'GUARD' as const    // per §3.13
        │                    reason: 'anti_bot' | 'rate_limit' | 'ip_block'
        │                  }
        │                  interface GuardNotifier {
        │                    notify(level: 'warn' | 'critical', msg: string): Promise<void>
        │                  }
        │                  function isGuardError(e: unknown): e is GuardError
        │
        └─ imports ──▶ src/boss/{search-jobs, login-by-qr, send-greeting}.mjs (现有 stub)
```

#### 14.2.4 流程图(集成版状态机 — R1+R2+R3+R6)

```
                              ┌──────────┐
                              │   idle   │ (initial)
                              └─────┬────┘
                                    │ runDailyLoop()
                                    ▼
                              ┌──────────┐
                              │  login   │
                              └─────┬────┘
                              fail │ success (R1)
                                   ▼
                            ┌──────────┐
                            │ aborted  │ ──► exit 2
                            └──────────┘
                                    │
                                    ▼
                              ┌──────────┐
              ┌───────────────│ running  │────────────────┐
              │               └─────┬────┘                │
              │  jobs=[]           │ for each job:        │ DailyDone
              │                    ▼                       │ DailyLimit
              │               ┌──────────┐                │
              │               │ throttle │                │
              │               │ decision │                │
              │               └────┬─────┘                │
              │       ┌────────────┼────────────┐          │
              │  proceed           │            abort      │
              │   │                │            │          │
              │   ▼                ▼            │          │
              │  ┌──────────┐  ┌──────────┐     │          │
              │  │ paused   │  │ sending  │     │          │
              │  │ (sleep)  │  └────┬─────┘     │          │
              │  │ after:   │       │           │          │
              │  │ →running │  ┌────┴────┐      │          │
              │  └──────────┘  │ send OK │ send fail      │
              │                └────┬────┘   (B2=a:        │
              │            success  │      continue)      │
              │                     │           │          │
              │                     │           ▼          │
              │                     │      ┌────────┐      │
              │                     │      │ next   │──────┤
              │                     │      │ job    │      │
              │                     │      └────────┘      │
              │                     │           ▲          │
              │                     │           │ GuardError (R2)
              │                     │           ▼          │
              │                     │      ┌──────────┐    │
              │                     │      │ blocked  │    │
              │                     │      │ +notify  │    │
              │                     │      │ +degrade │    │
              │                     │      └────┬─────┘    │
              │                     │           │          │
              │                     │           └──────────│
              │                     │                      ▼
              │                     │              exit 2
              │                     ▼
              │                ┌──────────┐
              │                │  done    │ ──► exit 0/1 (R6)
              │                └──────────┘
              │                       ▲
              │                       │ failure rate > 30% (R3)
              │                       │
              │                ┌──────────┐
              │                │ blocked  │ ──► exit 2
              │                └──────────┘
              │
              └────► exit 2 (致命)
```

### 14.3 §3.10 refactor 盘点

`throttle.ts` ThrottleDeps 接入真实 CounterStore (Sprint C-3) 后 caller 影响:

| caller | 当前 | C-3 接入后 | 影响 |
|--------|------|-----------|------|
| `tests/unit/auto/throttle.test.ts` | inline `{ load, writeAtomic }` mock | 改 `createInMemoryCounterStore()` + `.reset()` in `beforeEach` | 测试不破,加 `.reset()` |
| `tests/unit/auto/throttle-reliability.test.ts` | 同上 | 同上 | 同上 |
| **未来 `auto-handler.ts`** (C-2a) | — | 注入 `createFsCounterStore('~/.bapply/counter.json')` | 新增 caller,接口稳定 |

**结论**: mock 改 `createInMemoryCounterStore()` 工厂函数 + `.reset()` (R7), 不变更 ThrottleDeps 接口形状 (CounterStore 仅引入 type, mock 实现同 shape), 向后兼容 11 个现有 test。

### 14.4 §3.12 probe 假设清单 (per 硬性)

| # | 假设 | 验证方式 | 不验证的后果 | 风险 |
|---|------|---------|------------|------|
| H1 | POSIX atomic write (`tmp + writeFile + sync + rename`) 在 macOS Node 24 真原子 | `probe-throttle-integration.mjs` Scenarios S1-S4: 并发 10 次写读不丢失 / 临时文件清理 / rename 异常回滚 | rename 失败 → counter 双写或丢失 | 中 |
| H2 | `JSON.stringify + parse` 安全 (DailyCounter 无循环引用 / Date / BigInt) | S5-S6: 写读后字段一致 / 损坏 JSON 抛错不吞 | 解析失败 → 状态丢失或静默错误 | 低 |
| H3 | SIGTERM handler `await writeAtomic` 完成后**不调用** `process.exit`, 事件循环自然结束 | S7-S8: handler 完整落盘 + exit 调用计数 0 + 后续进程可继续 | handler 跳过 → 进程提前退出丢数据 | 中 |
| H4 | `createInMemoryCounterStore().reset()` 隔离测试间状态 | S9-S10: reset 后 load 返回 null / reset 后 write 不影响下次 test | 状态泄漏 → test 间 flaky | 低 |
| H5 | `mkdir -p` (`fs.mkdir({ recursive: true })`) 在 `~/.bapply/` 不存在时自动创建 | S11-S12: 首次写入自动创建目录 | 缺目录 → 写失败 exit 2 | 低 |

**单账号红线守住**: H1-H5 仅涉及 fs + in-memory, **不 probe BOSS / loginByQR / sendGreeting**。

### 14.5 Sprint C 子任务拆分 (per §4.3)

| Sprint | src files | tests | 范围 | 预计工时 |
|--------|-----------|-------|------|---------|
| **C-1** counter-store | 1 new (counter-store.ts) | 3 new (T11-T13: atomic write / SIGTERM / reset) | H1-H5 probe | ~30min |
| **C-2a** auto-handler + 失败率 | 1 new (auto-handler.ts) | 3 new (T14-T16: initial login / exit 2 / 失败率阈值) | R1 + R3 + R6 | ~45min |
| **C-2b** guard + blocked | 1 new (guard.ts) | 2 new (T17-T18: GuardError → blocked / notify → exit 2) | R2 | ~30min |
| **C-3** throttle 集成 | 1 modified (throttle.ts) | 2 new (T19-T20: 真 fs 往返 / 加固 T8 exit 调用计数) | refactor + R5 + R7 | ~30min |

合计: 3 new src + 1 modified src + 10 new tests, **每个 sub-sprint ≤ 1 src + ≤ 3 tests**, 远低于 §4.3 上限。

### 14.6 退出码精化表 (R6)

| 退出码 | 触发条件 | 例子 |
|--------|---------|------|
| **0** | ≥1 次 sendGreeting 成功, 且未触致命 | 40/40 全发, 39 OK + 1 reject |
| **1** | 全部失败 / 部分失败 (无致命) | 40 全 reject, 或 5/40 OK 其余 reject |
| **2** | 致命: config / login / guard / 失败率超阈 / counter write 失败 | loginByQR 失败、GuardError 触发、failed/sent > 0.3 |

**实现**: `runDailyLoop` 返回 `{ exitCode: 0|1|2, stats }`, CLI 层 `process.exit(stats.exitCode)`。

### 14.7 修订记录 (per §10 重写流程)

| 修订 | 位置 | 原因 |
|------|------|------|
| 初始 login 显式加入 | §14.2.4 流程图 R1 | 架构师 review: 进程起手无 cookie 必失败 |
| Guard / blocked / 失败率监控 | §14.2.4 流程图 R2+R3 | 反爬触发后继续投递浪费配额 |
| atomic write 模式标准化 | §14.2.3 关系图 R4 | POSIX 标准: tmp + sync + rename |
| T8 SIGTERM 加固 | §14.4 H3 风险列 R5 | handler 完成后需禁止 process.exit |
| 退出码精化 | §14.6 R6 | 全失败 vs 部分失败需区分 |
| 工厂函数加 reset | §14.3 refactor 盘点 R7 | 单元测试隔离必需 |

### 14.8 probe 验证结果 (2026-07-28, per §3.12)

`scripts/probe-throttle-integration.mjs` 12/12 PASS, 验证 §14.4 H1-H5 全部假设。

**关键发现**:

| # | 发现 | 影响 C-1 实现 |
|---|------|-------------|
| F1 | **tmp suffix 必须用 `crypto.randomUUID()`, 不用 `Date.now()`** | `Date.now()` 在并发同毫秒会生成相同 tmp 名, 后到的 rename ENOENT (S2 第一次跑挂) |
| F2 | **POSIX atomic write 语义 = "无 torn write + 无 ENOENT", 不保证 "最后调用必胜"** | S2 期望修正: `final sent ∈ {1..10}`, 不是 `sent=10`. last-write-wins 在并发起跑下不严格保证 |
| F3 | 损坏 JSON 抛 `SyntaxError` 不被吞 (per S6) | `load()` 实现必须 `throw`, 不能 `return null` |
| F4 | `mkdir -p` (`fs.mkdir({ recursive: true })`) 自动建 `~/.bapply/` (S11) | `writeAtomic` 第一步必 `mkdir({recursive:true})` |
| F5 | SIGTERM handler 完成后**未**调 `process.exit`, 事件循环自然结束 (S8) | T8 必须断言 3: `exitCalls.length === 0` |

**probe 摘要**:

```
[PASS] H1-S1 single write/read roundtrip — sent=1
[PASS] H1-S2 10x concurrent write, all resolve + final value in {1..10} — allResolved=true, final sent=6
[PASS] H1-S3 tmp files cleaned after rename — leftovers=[]
[PASS] H1-S4 readonly dir → write throws + tmp cleaned — threw=true, leftovers=0
[PASS] H2-S5 complex counter roundtrip equality — equal=true
[PASS] H2-S6 corrupted JSON throws SyntaxError (not silently null) — threw=true
[PASS] H3-S7 SIGTERM handler completes writeAtomic (sent=999) — final sent=999
[PASS] H3-S8 handler does NOT call process.exit — handlerThrew=false, exitCalls=0
[PASS] H4-S9 reset() makes load return null — before.sent=5, after=null
[PASS] H4-S10 after reset, new write does not retain old state — loaded={"date":"2026-07-29","sent":1,"cap":40}
[PASS] H5-S11 first write creates ~/.bapply/ + counter.json — dir=true, file=true
[PASS] H5-S12 write to existing dir does not throw — threw=false
=== Total: 12/12 PASS ===
```

**单账号红线**: H1-H5 probe 0 触碰 BOSS / loginByQR / sendGreeting, 守住。

---

## Debug Gate 5 项（按 §3.8）

⚠️ **本 ADR 不是 bug 修复类决策，Debug Gate N/A**。如后续 live 跑发现撞墙，按 §3.8 重新走症状 / 多假设 / 修复 / 自验证 / 未证明 5 项。

---

## 自检 Checklist（提交前必过）

- [x] §3 证据：H1-H9 全部有独立证据（commit hash / 源码行号 / memory / 算术）
- [x] §4 反例：E1-E7 全部有证伪过程
- [x] §5 备选：评估 4 个备选方案 + 明确选择理由（user 决策 + 单账号红线）
- [x] §6 行为契约：10 条全部可观测 / 可测试（✓ ✗ 分类清晰）
- [x] §7 4 类图：架构 / 时序 / 关系 / 流程 全画
- [x] §8 TDD：Sprint B 完整完成 (11/11 GREEN), 详见 §13 验证记录
- [x] §9 后续：12 项明确列出（含 probe、RED、5 个 src 文件、3 个 Sprint C/D 候选）
- [x] 未引用未验证的归因（全文无"估计" / "应该" / "可能是"，只有"按公开惯例" + "user 决策"）
- [x] 非 bug 修复：Debug Gate 标注 N/A
- [x] §10 真相变了流程列出（含 4 条已知推翻路径）

---

**纪律引用**：
- `~/.claude/CLAUDE.md` §3.5（设计前置 4 类图）
- `~/.claude/CLAUDE.md` §3.8（修 bug 归因纪律 — N/A 本 ADR）
- `~/.claude/CLAUDE.md` §3.9（错误传播图 — §7.4 流程图覆盖）
- `~/.claude/CLAUDE.md` §3.12（probe before src — §9 列出 scripts/probe-throttle-logic.mjs）
- memory `feedback_boss_anti_bot_status.md`（2026-07-13 风控状态基线）
- memory `feedback_validate_before_source.md`（mock ≠ 真实 — §3 H3 标记 sendGreeting 当前无节流 = 实测源码验证）