# loks666/get_jobs BOSS 模块过时度调研（2026-07-14）

> **作者**：boss-apply dev（via general-purpose survey agent）
> **来源**：https://github.com/loks666/get_jobs
> **目的**：回答用户问题"loks666/get_jobs 中的 Boss直聘 部分是否过时？"
> **结论**：**已过时（半残）**——框架不过时但实战能力自 2026 年起处于"半残"状态；不值得 fork 主体，可单点借鉴 anti-detection.js 的 toString 劫持方案。

---

## TL;DR

loks666/get_jobs（Java 21 + Spring Boot 3.5.7 + Playwright，7683 stars）是当前公开仓库里 BOSS 投递链路最完整的实现之一，但 **BOSS 路径实战能力自 2026 年起处于"半残"状态**：

- 作者本人 2026-01-30 后**再未碰 BOSS 路径**
- 最有救的两份 PR（#271 重写 anti-detection.js、#275 隐藏 webdriver 特征）截至今天**全部 open，未合并进 main**
- 4 个 open issue（#248 / #256 / #258 / #266）直指 BOSS 已不能投：滑块频繁弹、登录页跳 about:blank、登录后拿不到数据
- README 公开承认"【紧急】目前 Boss 新增了检测机制，导致网页被回退"

**对我们的结论**：

| 决策 | 判定 |
|------|------|
| 是否 fork 主体做底座 | ❌ 不推荐（Java 栈 vs 我们全栈 TS 单栈 decision lock 冲突） |
| 是否单点借鉴 anti-detection.js 的 toString 劫持 | ⏳ 可借鉴（独立可移植，无需 fork） |
| 是否需要立刻动手 patch | ❌ 不推荐（先等 PR #271/#275 是否合并） |

---

## 1. 项目元数据 [已确认]

| 维度 | 值 | 证据 |
|------|------|------|
| stars | 7683 | GitHub API |
| forks | 944 | GitHub API |
| contributors | 75（含匿名；loks666 479 次 commit，exception-coder 53 次） | GitHub API |
| 最后 push | 2026-01-30T14:54:33Z | `pushed_at` |
| 主分支最后 commit | `f809428`（2026-01-30, "🐰fix a boss home page question."） | commits API |
| 最近 release | `v1.0.0` @ 2025-11-26（仅此 1 个 release，2026 年至今无 release） | releases API |
| 默认分支 | main | GitHub API |
| 主语言 | Java（Spring Boot 3.5.7 + Gradle） | GitHub API |
| README BOSS 状态 | "承认 BOSS 有风控问题但仍标在支持列表中" 的中间态；L25 明示【紧急】Boss 检测机制 | README L25, L105 |

**反证线索**：README L128 "智联招聘 …烂掉了，不要用"——作者用脚投票，主动下架其他渠道但保留 BOSS。

---

## 2. BOSS 模块代码探查 [已确认]

### 2.1 目录结构

```
src/main/java/com/getjobs/worker/boss/
├── Boss.java           # 主链路 worker，1165 行
├── BossConfig.java     # 配置（cookie / 城市 / 关键词 / 薪资 / 过滤项），106 行
└── Locators.java       # Playwright selector 集中点，62 行
```

上游：`application/service/BossService.java` + `application/controller/BossController.java`（REST 触发）。

浏览器层：`worker/manager/PlaywrightManager.java` + `worker/utils/PlaywrightUtil.java`（共 ~2331 行，含全局 stealth 注入）。

反检测 JS：`src/main/resources/anti-detection.js`（108 行）。

### 2.2 技术栈

**Java 21 + Spring Boot 3.5.7 + Playwright (`com.microsoft.playwright.*`)**。

- ❌ 不是 Selenium
- ❌ 不是 CDP 裸调
- ✅ 有完整 Spring Boot 工程化（Controller / Service / Worker 分层）

### 2.3 登录方式

**Cookie 注入**（无扫码 / 短信 / 二维码分支）。

数据流：`boss_cookies` 表 → `context.addCookies(...)` → 打开 `https://www.zhipin.com/web/geek/jobs` → 检测「登录」按钮文字判定是否登录（`Boss.java:1145, 1159`）。

### 2.4 主链路函数（来自 Boss.java grep）

```
prepare()                           L73
  └→ execute()                      L91
       └→ postJobByCity(cityCode)   L207
            └→ processJobDetailJsonAndInsert(body)  L411
                 └→ resumeSubmission(keyword, job)  L612
                      ├→ attachJobDetailResponseListener()  L782
                      └→ sendImageResume(page)       L861
```

AI 招呼语：`generateAiMessage / buildDefaultPrompt`（L1075-1096）。

### 2.5 已知功能性限制（非 TODO 注释）

`Boss.java` L609 自承：

> "目前Boss无法通过新标签页打开立即沟通按钮，所以只能点击更多详情…"

——这说明作者也承认在绕过 BOSS 新版限制，属于"知其不可而为之"的活路 hack。

### 2.6 TODO / FIXME / "已失效" / "暂时无法使用" 标记

`Boss.java` / `BossConfig.java` / `Locators.java` 内 grep `TODO|FIXME|XXX|HACK|已失效|暂时无法` → **0 命中**。

但这**不等于代码健康**，因为 #248 / #256 / #258 / #266 多用户报告 BOSS 已不可用——失败信号全在 issue 区而非代码注释里。

---

## 3. 风控 / 接口变化证据（近 6 个月） [已确认]

| 类型 | 编号 | 日期 | 状态 | 关键信息 |
|---|---|---|---|---|
| Issue | #248 | 2026-05-15 | open | "boss直聘投递初始化时频繁刷新触发滑块验证" |
| Issue | #256 | 2026-03-15 | open | "Boss直聘登录页面自动跳转 about:blank，无法完成登录" |
| Issue | #258 | 2026-03-28 | open | "无法投递任何简历" — 登录后无法获取 boss 信息 |
| Issue | #266 | 2026-04-11 | open | "所有招聘网站都无法使用了，猎聘投递出现 network error；频繁弹出验证" |
| PR | #271 | 2026-05-06 | open (PR) | "feat: Boss直聘反检测与简历优化升级" — 重写 anti-detection.js，移除固定 CDP 端口，**新增滑块等待** |
| PR | #275 | 2026-06-06 | open (PR) | "🛡️ fix(boss): 隐藏自动化特征 (navigator.webdriver 等)，修复登录页一打开就被回退" |
| Discussion | #250 | 2026-01 | active | README 引用的"投递过程中不断刷新"讨论链 |

**关键判断**：
- 是否有人报告"已经不能用" → **是**（#258 直接说"无法投递任何简历"，#266 说"完全没法使用了"）
- 2026 年是否有 BOSS 接口变动修复 commit → **有，但 PR 仍是 open**（#271、#275 都没合并进 main）

---

## 4. 维护活跃度 [已确认]

### 4.1 BOSS 路径 commit 分布

**近 6 个月（2026-01-14 起）`worker/boss` 路径 commit：3 条**，全部在 2026-01-30。

最后一条之前的 13 条都是 2025-10 / 11 月的 UI / 51job / Liepin 修复。

### 4.2 最近 BOSS 相关 PR / Issue

| 类型 | 编号 | 日期 | 状态 |
|---|---|---|---|
| PR | #275 | 2026-06-06 | open |
| PR | #271 | 2026-05-06 | open |
| Issue | #283 | 2026-07-12 | open（"这个项目除了 boss，其它的 3 个招聘软件还能投吗"） |
| 历史 merged 修复 | PR #240 / #241 | 2025-11-18 | merged（"Fix boss interface"） |

### 4.3 Fork 社区救火

100 个 fork，最近 fork 仍在 2026-07-13 持续更新（`kkkxxx9/get_jobs`, `findsun-vn/get_jobs`, `kingroad5299/get_jobs` 等），说明用户社区在积极 fork 救火。

---

## 5. 对比我们的 robustEvaluate [已确认]

| 维度 | loks666/get_jobs | 我们的 robustEvaluate |
|---|---|---|
| 栈 | Playwright (Java) | CDP 裸调 (Node/TS) |
| 登录态 | 一次性 cookie 注入 → 打开页面验证 | CDP 复用浏览器实例 + cookie |
| 反检测手段 | anti-detection.js 注入：劫持 `Function.prototype.toString`、`console.*` 拦截、`navigator.webdriver` 隐藏、移除固定 CDP 端口 (#271) | WebSocket Hook + robustEvaluate：拦 `WebSocket.send / setRequestHeader / console` + JD 长度双路校验 + `waitForFunction` |
| 滑块处理 | `#271` 新增 `waitForSliderVerify(page)` — 检测到滑块**暂停等用户手工过**，然后重试搜索页 | 当前 sprint smoke 已落地假绿防御；滑块自动化未做（走用户手工 + 油猴 WebSocket Hook） |
| 失败判定 | `buttonLocator.count() > 0 && textContent().contains("登录")` 判未登录；其它用 `try { ... } catch (Throwable ignore) { return false; }` **吞错重试** | `MIN_JD_LENGTH` + `waitForFunction` 懒加载双路，verdict 显式返回 pass / fail / inconclusive |
| 重试策略 | 提交失败单点 `try/catch (Throwable ignore)`，**无显式 backoff**（grep 没看到 retry 计数） | 双路 MIN_JD_LENGTH + verdict 假绿防御（见 ADR-0004） |

**关键对照结论**：
- 我们已经踩过的 `try { ... } catch (Throwable ignore) { return false; }` 假绿反模式，他们**仍在生产代码里用**
- 我们的 ADR-0004 verdict 三态机制比他们**领先一档**
- 他们的 anti-detection.js `toString` 劫持方案**比我们领先一档**（可借鉴）

---

## 6. 是否值得 fork / patch？ [AI 假设 — 待用户定]

### 6.1 不推荐 fork 主仓库做底座

理由：Spring Boot + Java 栈与我们"全栈 TS 单栈"decision lock 冲突（参 MEMORY `feedback_stack_decision.md`）；架构上无 Java 化的新增优势。

### 6.2 可单点借鉴的具体技术点（独立可移植，无需 fork 仓库）

1. **anti-detection.js 的 `Function.prototype.toString` 劫持 + WeakMap 伪源码** —— 比单纯 hide webdriver 高一个段位；可移植到我们油猴 / WebSocket Hook 的 `stealthPatch`。
2. **"移除固定 CDP 调试端口"**（PR #271 的变更点）—— 我们走 `attach-to-existing-tab` 已经规避，但量产脚本若改 standalone 启动要避开 9222 固定端口。
3. **滑块检测 → 暂停等用户 → 自动续跑** 的状态机（`waitForSliderVerify`）—— 我们当前靠用户手工，等 verdict 假绿防御稳定后可以补这套自动恢复。
4. **`attachJobDetailResponseListener()`** —— 在投递前先 `page.on("response")` 抓 BOSS 的 `/job_detail` JSON，比 DOM 解析稳；可替换我们 `fetchJobDetail` 的部分猜测逻辑。

### 6.3 不要借鉴的反模式

- Java 重型打包：与 TS 单栈冲突
- 用 `try { ... } catch (Throwable ignore)` 吞错当"重试"：正是我们 ADR-0004 在打掉的"假绿"反模式
- 黑名单 in-memory 缓存 + 数据库双写：我们的 sprint 黑名单策略不同

---

## 7. 给用户的后续动作（建议）

1. **观察 2 周** [AI 假设]：等 PR #271 / #275 是否被合并；合并后看 issue #248 / #258 状态。
2. **短期不加 fork 工作** [已确认 — 与 MEMORY `feedback_boss_anti_bot_status.md` 决策一致]：精力继续放我们自己油猴 WebSocket Hook + robustEvaluate（task #12-15）。
3. **要做借鉴 patch 时再说** [待确认 — 是否立项等用户决定]：把 anti-detection.js 的 `toString` 劫持方案抽成独立 skill（`stealth-toString-hook`），纳入 `docs/adr/` 作为 ADR-0006 候选。

---

## 8. 关键文件路径（绝对路径，便于回查）

- GitHub 主页：https://github.com/loks666/get_jobs
- BOSS worker：https://github.com/loks666/get_jobs/tree/main/src/main/java/com/getjobs/worker/boss
- 反检测 JS：https://github.com/loks666/get_jobs/blob/main/src/main/resources/anti-detection.js
- 未合并的 BOSS 修复 PR：https://github.com/loks666/get_jobs/pull/271 , https://github.com/loks666/get_jobs/pull/275
- 关键 issue：#248 / #256 / #258 / #266 / #283
- Discussion：#250

---

## 9. 调研受阻说明

- **未受阻**。`gh api` 因 zsh glob 解析失败，全部回退到 `curl` + `https://api.github.com` 直接调用。
- Star / forks / contributors / commits / issues / PRs / releases / raw 文件全拿到。
- Boss.java / BossConfig.java / Locators.java / anti-detection.js / README.md 全部 raw 拉取并 grep 完毕。

---

## 元数据

- 调研 agent: `general-purpose` (agentId: `ac70dec352f766025`)
- 工具调用数：63
- 调研用时：1027.9 秒
- tokens（agent 维度）：38,957
- 数据采集日期：2026-07-14
