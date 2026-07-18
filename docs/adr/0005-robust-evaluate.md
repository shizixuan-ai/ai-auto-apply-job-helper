# ADR-0005: `robustEvaluate` 防御 BOSS SPA navigation race

> **状态**：已实施（2026-07-13）
> **作者**：boss-apply dev
> **关联**：ADR-0004（懒加载防御）— 两者正交，本 ADR 在 evaluate 出口处拦截 race，ADR-0004 在 fetchJobDetail 内部防懒加载
> **Sprint**：2026-07-13

---

## 背景

`bapply search "Java后端" --cdp --dry-run --limit 1` 在 `src/browser/index.ts:502` 的 `page.evaluate` 抛错：

```
page.evaluate: Execution context was destroyed, most likely because of a navigation
```

### 触发条件（已实测确认）

1. **Phase 1**：`page.goto('https://www.zhipin.com/web/geek/recommend', { waitUntil: 'domcontentloaded' })`
   - `domcontentloaded` 只保证 HTML parse 完成，不保证 SPA hydrate 完成
   - BOSS 是 Vue Router SPA：hydrate 期间还会做 client-side redirect / prefetch
2. **Phase 2**（race）：紧接着的 `page.evaluate(fetch ...joblist.json)` 时 SPA 还在 hydrate 或路由切换
   - Playwright 抛 `Execution context was destroyed`
3. **CDP 模式放大**：用户当前 Chrome tab 可能在你敲命令时被切走 / 主动浏览 → SPA 路由再次切换

### 事故路径

```
bapply 启动 → CDP 接管用户 Chrome → searchJobs
  ↓
Phase 1: domcontentloaded resolve（SPA 还没 hydrate）
  ↓
Phase 2: page.evaluate(fetch joblist.json)
  ↓ ← 此时 SPA 路由跳转 / hydrate 未完成
Execution context was destroyed
  ↓
用户看到 Node.js stack trace，整体失败，无 retry
```

---

## 决策

### 决策 1：抽出 `robustEvaluate(page, fn, arg)` 作为 page.evaluate 的唯一出口

新建 `src/browser/robust-evaluate.ts`，**所有 page.evaluate 调用点都应该改用它**。
本 Sprint 只迁移 `searchJobs`（事故现场），其他调用点后续 Sprint 收编。

### 决策 2：仅对 navigation race 类错误重试

```typescript
const NAV_KEYWORDS = [
  'context was destroyed',
  'navigating away',
  'target page, context or browser has been closed',
  'navigation interrupted',
]
```

非 navigation 错误（业务错 / 编码错 / `Too many arguments` / `GuardError`）**立刻抛** — 不掩盖，让 bug 暴露。

### 决策 3：重试上限 + 退避策略

| 参数 | 值 | 理由 |
|------|----|------|
| `DEFAULT_RETRIES` | 2 | 首次 + 2 次 = 3 次总尝试，足以覆盖 SPA hydrate 时长 |
| `RETRY_DELAY_MS` | 500 | 等 Vue Router hydrate 结束；vi.useFakeTimers() 可控 |
| 重试前动作 | `waitForLoadState('domcontentloaded')` | 部分 race 不会触发任何 load 事件，兜底 |

### 决策 4：公开 `isNavigationError` 让其他测试可复用

```typescript
export function isNavigationError(err: unknown): boolean
```

独立导出，不耦合 robustEvaluate 内部。让其他模块（错误日志聚合、可视化分类）能直接调用。

---

## 取舍

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| **A. 仅 `waitForLoadState('networkidle')`** | 不写新模块 | 用户 tab 持续请求时永不 idle；block 整个 bapply | ✗ |
| **B. retry 包装器（本决策）** | 与网络/SPA 解耦；代价可控 | 增加 1 模块、1 错误分类函数 | ✓ |
| **C. ignore 错误 / 用 selector 重抓** | 复杂场景兜底 | race 期间页面可能根本没有 selector | ✗ |
| **D. 直接交给用户重跑** | 0 代码 | 每个用户都得重跑 3 次才能稳定 | ✗ |

---

## 4 类图（见对话存档 / 简版）

### 架构图

```
src/browser/index.ts (searchJobs)
       └─→ robustEvaluate(page, fn, arg)
              ├─ try page.evaluate(fn, arg)
              ├─ catch err:
              │   if isNavigationError(err):
              │     waitForLoadState('domcontentloaded')
              │     sleep(500ms)
              │     retry
              └─ else: rethrow (不重试)
```

### 时序图（成功 vs race）

```
searchJobs ─→ robustEvaluate ─→ page.evaluate
                                     │
                         ┌───────────┴───────────┐
                         ▼                       ▼
                       成功                  抛 nav 错
                         │                       │
                      返回值                  等 DOM 稳定
                                                 │
                                                 ▼
                                          sleep 500ms
                                                 │
                                                 ▼
                                          重试 evaluate
                                                 │
                                       ┌─────────┴─────────┐
                                       ▼                   ▼
                                     成功               用尽 N 次
                                       │                   │
                                    返回值              throw lastErr
```

### 关系图（与 ADR-0004）

```
       ADR-0004: 懒加载防御
       (fetchJobDetail 内部: waitForFunction + MIN_JD_LENGTH)
                  │
                  │  正交
                  │
本 ADR-0005: robustEvaluate 防御
(page.evaluate 出口处: navigation race retry)
                  │
                  │  未来收敛
                  ▼
       fetchJobDetailViaWapi 也改用 robustEvaluate →
       部分 ADR-0004 逻辑可去除（无需再担心 evaluate 被 race 打断）
```

### 流程图（重试决策树）

```
       page.evaluate(fn, arg)
                │
                ▼
        ┌──── try ─────┐
        │              │
   ok ──┤              ├── failed
        │              │
        ▼              ▼
     return     ┌── isNavigationError?
                │         │
               yes        no
                │         │
                ▼         ▼
      waitForLoadState +   rethrow (立即，不掩盖业务错)
      sleep 500ms
                │
                ▼
         attempts < N?
            │       │
           yes      no
            │       │
            ▼       ▼
       重试 evaluate   rethrow lastErr
```

---

## 验收

### TDD 流程

| Step | 状态 | 证据 |
|------|------|------|
| RED | ✓ | 11 个测试在 `src/browser/robust-evaluate.test.ts`，实现前全部红 |
| GREEN | ✓ | 实现后 PASS (11) FAIL (0) |
| REFACTOR | ✓ | searchJobs line 505 改用 `robustEvaluate(page, async fn, apiBody)` |
| 全套验证 | ✓ | vitest **PASS (368) FAIL (0)**；tsc **0 errors** |

### 行为契约

1. ✓ `page.evaluate` 一次成功 → 直返，不重试（`page.evaluate` 调用 1 次）
2. ✓ nav 错 + 第二次成功 → 返回第二次结果（`page.evaluate` 调用 2 次，`waitForLoadState('domcontentloaded')` 被调）
3. ✓ 连续 N+1 次全失败 → throw lastErr
4. ✓ 非 nav 错（`postDescription 字段缺失或为空`）→ 立刻抛（不重试、不掩盖）
5. ✓ `isNavigationError('Too many arguments')` → `false`（明确不重试，让 origin bug 暴露）

---

## 后续（不在本 Sprint 范围）

- [ ] 把 `fetchJobDetailViaWapi` 的 `page.evaluate` 也改用 `robustEvaluate`
- [ ] 把 `sendGreeting` 的 `page.evaluate` 也改用 `robustEvaluate`
- [ ] 累计 retry 指标，监控是否需要调高 retries
- [ ] 评估 ADR-0004 的部分懒加载防御是否可收敛
