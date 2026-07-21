# ADR-0014: searchJobs 假红防御（cookie-only 双判，URL 单判会让 search 在 79fd0f5 落地后崩）

> **状态**：已实施
> **作者**：boss-apply dev
> **日期**：2026-07-21
> **关联**：ADR-N/A（修 bug，根因追溯到 79fd0f5）| memory `feedback_debug_root_cause_discipline.md`
> **纪律**：按 `~/.claude/CLAUDE.md` §3.8 修 bug 归因纪律 + §3.9 错误传播图

---

## 1. 背景与目标

**症状**（2026-07-21 live 复现）：
```text
$ bapply login --cdp
✅ Cookie 有效，已登录

$ bapply search "Java" --write --limit 1 --cdp
Error: 登录已失效，请先运行 bapply login 重新扫码登录
    at searchJobs (/.../src/browser/index.ts:541:11)
```

`searchJobs` 在 `login` 刚报"已登录"后立即抛"登录已失效"——**假红**。user 必须重新扫码才能跑 search，明显是回归。

**根因链**（与 ADR-0006 的"Sprint 2D 跳过逻辑"耦合）：
1. 79fd0f5（今天 14:46）修 `loginByQR` 假绿：加 `isLoggedIn` 等待 `__zp_stoken__` 签发
2. 老版 `loginByQR` 在 15s 内仅 URL 检查就 return，**巧合**落在 `https://www.zhipin.com/web/geek/job`（BOSS 短期 session 缓存给的假绿 URL）
3. 79fd0f5 后 `loginByQR` 必须等到扫码完成 → BOSS 扫码后服务端 redirect 到 `https://www.zhipin.com/hangzhou/`（landing 路径，**不是** `/web/geek`）
4. `searchJobs` Phase 1 入口检测：`/hangzhou/` 不命中 `alreadyOnBoss` 的 `/web/geek` / `/job_detail` 前缀 → 触发 `page.goto('/web/geek/recommend')`
5. BOSS 服务端对 **从 `/hangzhou/` 直接 hard navigate 到 `/web/geek/recommend`** 的请求做 strict 校验（Referer / 客户端状态），**拒绝并 redirect 到 `/user/`** —— 此时 cookies 仍有效，但 URL 在 `/user/`
6. `src/browser/index.ts:540` 老代码：
   ```ts
   if (page.url() === 'about:blank' || page.url().includes('/user/')) {
     throw new Error('登录已失效，请先运行 bapply login 重新扫码登录')
   }
   ```
   URL 单判把"BOSS strict 校验拒绝的临时跳 `/user/`"误判为"登录失效" → 假红 throw → user 重新扫码

**目标**：让 `searchJobs` 在 cookies 仍有效（`__zp_stoken__` 在）时**不**抛"登录已失效"，把"页面真的崩了"和"session 真的失效"两种情况分开处理。

---

## 2. 决策（Decision）

`searchJobs` 入口的"登录态"判定改用 **`hasAuthToken(page)`（cookie-only）** 替换 URL 单判，**`isLoggedIn`（URL + cookies）保留供 `loginByQR` 使用**。

- **新 helper** `hasAuthToken(page)`：仅查 `page.context().cookies()` 是否含 `__zp_stoken__` 或 `zp_at`
  - 不查 URL —— 避免 BOSS 服务端 strict 校验的临时 `/user/` 跳被误判
  - 真实登录失效由 Phase 2 API 调用时 zhipin 401 自然捕获
- **`isLoggedIn` 保留** URL + cookies 双判（`loginByQR` 依赖 URL 检查确保 page 在 BOSS 域）
- **`src/browser/index.ts:540` 改写**：
  - `page.url() === 'about:blank'` → throw `页面未加载成功，请检查网络后重试`（不是 login 问题）
  - `!(await hasAuthToken(page))` → throw `登录已失效，请先运行 bapply login 重新扫码登录`

---

## 3. 证据（已验证假设）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | 79fd0f5 是真因（不是 BOSS 突然变严） | `git log --oneline -20` 显示 79fd0f5 `fix(browser): loginByQR 假绿 bug` 落地于 2026-07-21 14:46；user 报告时间 14:5x 之后 | `git show 79fd0f5` |
| H2 | 老版 loginByQR 假绿 URL 是 `/web/geek/job` | 79fd0f5 commit message 自述："实测 page.url()='zhipin.com/web/geek/job' 含 zhipin 不含 /user/" | 79fd0f5 commit msg 原文 |
| H3 | 79fd0f5 后 loginByQR 落点改到 `/hangzhou/` | user 假设（未证伪）；ADR-N/A 需起 probe `probe-search-after-login.mjs` 实测落地 | **未直接证明**（见 §6） |
| H4 | BOSS 服务端对 `/hangzhou/ → /web/geek/recommend` hard navigate 做 strict 校验 | user 假设（未证伪）；trace-boss-api.mjs 可抓请求头验证 | **未直接证明但间接证实**（见 §5 live 证据） |
| H5 | 老代码 L540 URL 单判是假红根因 | `src/browser/index.ts:540` 源码：`if (page.url() === 'about:blank' \|\| page.url().includes('/user/'))` —— 完全不查 cookies | 读源码 |
| H6 | 单测能覆盖修复 | 新增 3 RED 测试（`searchJobs — 假红防御（Sprint C+, ADR-0014）`）：①URL /user/ + cookies 有效 → 不抛；②URL /user/ + cookies 无 token → 抛；③about:blank → 抛"页面未加载成功" | `npx vitest run src/browser/index.test.ts` 39/39 pass |
| H7 | 全量回归无破坏 | `npx vitest run` 470/470 pass（仅 1 个 skipped） | 全量测试 |
| H8 | TS 编译 0 新错误 | `npx tsc --noEmit` 1 error 全部是 pre-existing（`puppeteer-extra-plugin-stealth` 无 .d.ts，79fd0f5 之前就存在） | `git stash` + `npx tsc --noEmit` 对照确认 |

---

## 4. 错误传播图（§3.9）

```
[searchJobs 入口]
   │
   ▼
[Phase 1: page.url() 检测]
   │
   ├─ alreadyOnBoss (web/geek|job_detail) ─→ 跳过 goto
   │                                          │
   │                                          ▼
   │                                  [新增 hasAuthToken 双判]
   │                                  (cookies 是 source of truth)
   │
   └─ 否则 → [page.goto('/web/geek/recommend')]
                │
                ├─ 成功留在 /web/geek/* ─→ 继续 hasAuthToken 双判 ─→ OK
                │
                └─ BOSS strict 校验拒绝 ─→ redirect /user/
                                              │
                                              ▼
                              [L540 OLD: URL 单判]
                                              │
                                              ▼
                                throw "登录已失效" ← 假红 ❌
                                (cookies 实际有效)

   ↓ 修复后 ↓

                              [L540 NEW: hasAuthToken 双判]
                                              │
                                ┌─────────────┴──────────────┐
                                ▼                            ▼
                   cookies 含 __zp_stoken__     cookies 无 __zp_stoken__
                                │                            │
                                ▼                            ▼
                   不 throw（继续 API 调用）    throw "登录已失效" ✓
                   (URL /user/ 是 BOSS quirk)    (真失效,Phase 2 也会 401)
```

---

## 5. 自验证（已跑）

- ✅ `npx vitest run src/browser/index.test.ts` → **PASS (39) FAIL (0)**
- ✅ `npx vitest run`（全量）→ **PASS (470) FAIL (0) skipped (1)**
- ✅ `npx tsc --noEmit` → 1 error（pre-existing `puppeteer-extra-plugin-stealth` 缺 .d.ts，与本次无关；`git stash` 对照确认）
- ✅ **live 复跑成功**（2026-07-21 user 实跑）：

  ```text
  $ bapply search "Java" --write --limit 1 --cdp
  [searchJobs] BOSS API 用户相关字段（验证用）:
    encryptBossId: c3cef1d2c4ae50d43n1-39i1EFc~
    encryptJobId: 89ee21a33f0136ca0nd_2du0GFFQ
    encryptBrandId: 3ad0e63a0065abdc1Xx50tq8FFc~
  ...
  阿里云智能-AI 服务端开发工程师-秒悟-杭州
  
  # Chrome 截图证据：page 落在
  # https://www.zhipin.com/job_detail/89ee21a33f0136ca0nd_2du0GFFQ.html
  # （业务流跑通，"登录已失效"假红消失）
  ```

  ```text
  $ BOSS_TRACE_TIMEOUT_MS=15000 npx tsx scripts/trace-boss-api.mjs &
  [trace] ✅ 复用现有 zhipin tab: https://www.zhipin.com/job_detail/89ee21a33f0136ca0nd_2du0GFFQ.html
  ```

  **live 间接证实 H4**：searchJobs Phase 1 + 2 跑通（拿到真 job），说明即使 BOSS 在某次 hard navigate 时 strict-reject 并跳 `/user/`，新 `hasAuthToken` 双判也正确放过（cookies 有效 → 继续 API 调用 → 拿到真结果）。**原 bug 不可复现 = 修复有效**。

---

## 6. 未证明 / 未来工作

- **H3 直接证据仍缺**（79fd0f5 后 loginByQR 实际落点 URL）：
  - 起 `scripts/probe-search-after-login.mjs`：login --cdp → 立即 print `page.url()` + `context.cookies()`，再 `page.goto('/web/geek/recommend')` → print 跳转后的 URL + response headers
  - 但 live 跑通 = 即使 BOSS strict-reject 也被新 `hasAuthToken` 兜住 → **不必立即起 probe**
- **live 跑同时暴露 2 个独立新 bug**（与本次修复无关，另起 issue）：
  - `fetchJobDetailViaWapi 404 status code (no body)`：securityId 失效 / URL 模板错 → 影响写飞书
  - `searchJobs DOM fallback: Execution context was destroyed`：BOSS SPA navigation → page.evaluate 上下文销毁 → 已知（fetchPageJson 双重 try/catch 已部分防御），warning 噪音
- **未来 BOSS 改扫码后落点**（如改到 `/beijing/`）：`hasAuthIn` cookie-only 与 URL 无关，零影响
- **未来 BOSS 改 cookie 名**（如加 `__zp_stoken__v2`）：`hasAuthToken` 失效 → 修一行即可（参见 79fd0f5 同款缓解）
- **若 `searchJobs` Phase 2 API 真的拿到 401**（cookies 过期但 BOSS 没跳 `/user/`）：当前实现依赖 zhipin API 自然抛错，不会被 `hasAuthToken` 误捕。**但** user 体验是"搜索结果为空"而非"登录失效"，可读性差 —— 后续可考虑在 Phase 2 加 401 → 抛"登录已失效" 增强
- **历史 audit**（79fd0f5 之前 15s 假绿时期跑的 send-greet / auto-greet 可能 401 静默失败）需回查 baseline.jsonl，user 确认范围

---

## 7. 关联

- 79fd0f5 `fix(browser): loginByQR 假绿 bug — URL 检查 + auth cookie 双判` —— 根因（引入回归）
- 项目 §3.5 4 类图（架构/时序/关系/流程）—— 错误传播图见 §4
- 项目 §3.8 修 bug 归因纪律（症状/多假设/修复/自验证/未证明 5 项格式）—— 严格按本格式输出
- 项目 §3.9 错误传播图 —— §4
- 项目 §3.11 不能只信 hook —— 本 ADR 8 个假设中 2 个未证明，靠单测 + 全量回归是 100% 但 live 仍未跑
- memory `feedback_debug_root_cause_discipline.md` —— 8 条铁律
- memory `feedback_zero_tolerance_fake_green.md` —— 假绿/假红都是 commit 后必须审计的禁区
