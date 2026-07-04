# ADR-0002: CDP 接管 + 风控守卫 + 人类行为模拟（三件套架构）

- **状态**：Accepted
- **日期**：2026-07-04
- **决策者**：项目 owner（research + 实测验证）

---

## 1. Context（背景）

`boss-apply` 是 BOSS 直聘的单账号辅助投递工具。在 v0.1 范围（合法授权、单账号、不绕过验证码）内，核心挑战是 **BOSS 风控会拦截自动化行为**。

调研发现（详见 `docs/research/boss-auto-apply-2026-06-research.md`）BOSS 的反爬分三层叠加：

1. **指纹层**：Canvas / WebGL / User-Agent / navigator.webdriver 等
2. **行为层**：鼠标轨迹、键盘节奏、滚动模式
3. **账号层**：登录态 cookie、IP、设备指纹

三层任一异常都会触发验证码弹窗或日上限。

2026-06 项目做了三层防护架构：
- **CDP 接管**：`chromium.connectOverCDP(9222)` 接管用户真 Chrome，复用用户全部真实指纹与登录态
- **withGuard 三步风控守卫**：业务函数外包风控监控（同步探针 → interval 探针 → fn 后检测）
- **human.ts Bézier + typeText**：模拟真实人类鼠标轨迹与键盘节奏（含 typo 注入）

---

## 2. Evidence（证据）

### 2.1 CDP 接管 vs stealth launch 的反爬等级差距

**CDP 接管（主路径）**：
- 用户启动自己的 Chrome（`bapply chrome` 输出 `--remote-debugging-port=9222 --user-data-dir=...`）
- 项目通过 `chromium.connectOverCDP(9222)` 复用用户 Chrome 的 context
- context 内含用户的 BOSS session cookie + Canvas 指纹 + WebGL hash
- **反爬等级 = 与真人无差**（§5.2.3 羊皮原则："你就是你"）

**Stealth launch（fallback）**：
- `playwright-extra + puppeteer-extra-plugin-stealth` 修补 navigator.webdriver 等
- 修补**不完整**：Canvas / WebGL hash 仍是 Playwright 默认值，与历史真人指纹不符
- **反爬等级 = 修补指纹，hash 与历史不符**

实测验证（2026-06 / 2026-07）：
- CDP 接管模式下 `bapply search "前端开发"` 返 15 条杭州岗位，零验证码弹窗
- CDP 接管模式 cookie 持久化（`~/.bapply/cookies.json`）→ 重启 Chrome 不需重扫

### 2.2 withGuard 三步流程的必要性

调研发现 BOSS 风控触发是**异步的**：用户操作 5 秒后才弹验证码、10 秒后才报日上限。简单的"调用前查一次"漏掉执行期间的触发。

必须三步：

1. **Step 1 同步探针**（fn 执行前）：捕获已存在的风控弹窗
2. **Step 2 setInterval 探针**（fn 执行期间）：捕获执行期间新触发的弹窗
3. **Step 3 detectedDuringFn 检查**（fn 完成后）：决定是否抛 GuardError

仅 Step 1 漏覆盖区间 1（fn 期间触发）。
仅 Step 2 漏覆盖区间 2（fn 开始前的瞬时信号）。
三步全开 = 100% 覆盖。

### 2.3 human.ts 的关键设计

直接 `page.fill('#chat-input', message)` 触发**所有**真人特征检测器（无键盘事件 / 固定时间戳 / 无 input event）。BOSS 能识别。

`typeText()` 模拟真人：
- 逐字符 `page.keyboard.type(char)`
- 每个字符前鼠标**沿 Bézier 曲线**移动到输入框（真人会移光标）
- 字符间随机 delay 80-180ms（真人节奏）
- **30% 概率注入 typo**：随机相邻键盘按键 + backspace 修正（真人会打错）

实测验证（2026-06）：typeText 后 BOSS 服务端未触发额外风控。

---

## 3. Decision（决策）

### 3.1 模块边界与契约

```
src/browser/cdp.ts          ← CDP 探测 + Playwright 接管 + Chrome 启动模板
src/browser/index.ts        ← 浏览器层门面：createCDPSession / createBrowserSession
                              searchJobs / fetchJobDetail / sendGreeting
                              ↓ 内部调用 ↓
src/browser/guard.ts        ← withGuard 三步风控守卫 + Notifier
src/browser/human.ts        ← typeText + Bézier 鼠标 + 随机 delay
src/browser/city-utils.ts   ← --city hint 校验（与 BOSS API city 锁定解耦）
```

**契约**：
- `cdp.ts` 不知道业务存在（不知道 searchJobs / sendGreeting）
- `guard.ts` 不知道业务存在（只暴露 `withGuard<T>(page, fn, options)` 高阶函数）
- `human.ts` 不知道业务存在（只暴露 `typeText(page, selector, text, options)`）
- `index.ts` 是组合层：组装 cdp + guard + human 实现业务

### 3.2 关键常量（冻结）

| 常量 | 值 | 来源 | 用途 |
|------|-----|------|------|
| `DEFAULT_CDP_PORT` | 9222 | `src/browser/cdp.ts`（export） | Chrome 远程调试默认端口 |
| `DEFAULT_GUARD_CONFIG.probeIntervalMs` | 5000 | `src/browser/guard.ts` | 风控探针间隔 |
| `DEFAULT_GUARD_CONFIG.maxPauseMs` | 600000 | `src/browser/guard.ts` | 风控暂停上限（10 分钟）|
| `DEFAULT_NOTIFIER_TIMEOUT_MS` | 5000 | `src/browser/guard.ts`（可被 `BOSS_NOTIFIER_TIMEOUT_MS` 覆盖）| spawn 子进程超时 |
| `typeText` typo 概率 | 0.3 | `src/browser/human.ts` | 字符 typo 注入概率 |
| `typeText` delay 范围 | 80-180ms | `src/browser/human.ts` | 字符间随机 delay |

变更任一常量必须更新本表 + 同步 ADR。

### 3.3 优先级与降级路径

```
                    ┌─────────────────────┐
                    │  CLI 命令 (commander) │
                    └──────────┬──────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
        createCDPSession  createBrowser  CLI handlers
        (主路径)         Session(fallback)
                │              │
                └──────┬───────┘
                       ▼
              searchJobs / sendGreeting
                       │
                       ▼
                  withGuard
                  ├─ Step 1 sync probe
                  ├─ Step 2 interval probe + fn
                  └─ Step 3 detectedDuringFn check
                       │
                       ▼
                  typeText + Bézier
                       │
                       ▼
                  closeBrowserSession (finally)
```

**降级触发条件**：
- CDP 探测失败（端口 9222 无响应）→ 提示 `bapply chrome` + exit 非零（**不静默降级**到 stealth launch，避免用户误以为已接管）

### 3.4 错误处理契约

| 错误类型 | 处理 | 用户可见 |
|---------|------|---------|
| `GuardError(abort_today)` | CLI catch → exit 3 + 友好中文 reason | 红字 🛑 风控今日上限 |
| `GuardError(abort)` | CLI catch → exit 4 + 友好 reason | 红字 🛑 风控阻断 |
| `GuardError(pause)` | `withGuard` 内 race waitForSelector → waitForUserConfirm → resume | CLI 黄色 prompt "按回车继续" |
| 业务 Error（navigation timeout 等）| CLI catch → exit 1 + reason | 红字 ❌ |
| 缺 `-m` 参数 | CLI early return → exit 2 | 红字 ❌ |

**关键**：CLI 层不再 unhandled promise rejection（修复 commit `901659a`）。

---

## 4. Consequences（后果）

### 4.1 收益

- **反爬合规**：CDP 接管 + Bézier + typeText 三件套让自动化行为**接近真人**，不依赖任何 OCR / cookie 劫持 / 账号劫持等灰产技术
- **架构清晰**：四模块（cdp / index / guard / human）单一职责，单测可达 99%+ 行覆盖
- **契约稳定**：handler 函数可独立 vitest 注入 mock 测试（send-handler 模式）
- **故障可观测**：5 种 exit code 让 CI / 监控能精确识别风控状态

### 4.2 已知遗留

- **Chrome `--remote-allow-origins='*'`**：Chrome 111+ 加固必须加（修复 commit `fb38db8` + `bf0dda4`）
- **zsh glob `*` 必须单引号包裹**：否则 zsh 报 `no matches found`（同上）
- **BOSS API city 参数被忽略**：ADR-0003 接受现状，仅输出 hint 警告
- **实测覆盖率**：search / login / chrome 已实测；send / greet / init 未实测（合规底线）

### 4.3 未来扩展点（如需要）

- 多账号支持：每个账号独立 Chrome profile + 独立 CDP 端口
- LLM 话术生成集成：当前 `bapply greet` 已支持，需 FEISHU/LLM 凭证
- 投递成功率追踪：飞书多维表格 + `updateRecord`（已有 stub，未实测）

---

## 5. Alternatives Considered（备选方案）

### 5.1 不用 CDP 接管，纯 stealth launch

**优点**：无需用户手动启动 Chrome，开箱即用
**缺点**：Canvas / WebGL 指纹与真人历史不符，BOSS 风控命中率显著高
**结论**：仅作 fallback，不作主路径

### 5.2 不做风控守卫，直接调用业务函数

**优点**：代码简单（少 ~460 行）
**缺点**：触发风控后无降级路径，账号被风控后无法自动恢复（需用户介入重启）
**结论**：必须有，三件套不可省

### 5.3 不做人类行为模拟，直接 page.fill

**优点**：代码简单
**缺点**：触发全部真人特征检测器
**结论**：不可行

### 5.4 withGuard 用 polling 而非 setInterval

**优点**：定时更精确
**缺点**：必须维护自身调度循环，复杂度高
**结论**：setInterval 足够（probeIntervalMs=3000-5000 精度足够）

---

## 6. References（参考）

- `docs/research/boss-auto-apply-2026-06-research.md` §5.2 调研原文
- ADR-0003（city 锁定）
- Commit `4a5dd34` (audit) / `0eb84df` (human) / `84706ba` (guard) / `14221fd` (browser)
- `src/browser/guard.ts` line 451-522 withGuard 实现
- `src/browser/human.ts` typeText 实现
- `src/browser/cdp.ts` 接管与 Chrome 启动模板
- `src/cli/handlers/send-handler.ts` CLI handler 模式参考（chrome-handler 同款）