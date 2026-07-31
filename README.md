# boss-apply

> AI 辅助向 BOSS 直聘（zhipin.com）自动打招呼的开源 CLI。
> 关注"个人账号、合规授权、可解释反爬"，而非"批量刷简历"。

---

## 项目定位

`boss-apply` 是一个**单账号辅助投递工具**，设计原则：

- **合规优先**：遵守 BOSS 直聘 ToS，仅服务用户本人已登录的单账号
- **人工兜底**：检测到风控信号（验证码、滑块、限流、登录失效）会**暂停并等你介入**
- **可解释**：核心反爬决策写进 `docs/research/` + `docs/adr/`，为什么这么做有据可查
- **可恢复**：所有 Cookie / 简历 / 进度持久化到本地 (`./.bapply-state/`) + 飞书多维表格
- **可观测**：每条命令执行后写 baseline 记录，便于回顾反爬命中 + 评分漏斗

**绝对禁止**：批量注册、多账号切换、绕过验证码自动化（OCR / 模拟轨迹点击）、账号劫持。

> ⚠️ **风控现状备注（2026-07）**
>
> **本项目仍存在 BOSS 直聘风控风险**，工具不保证长期可用：
>
> - BOSS 风控持续升级（Canvas / WebGL / 行为指纹 / 设备指纹 / IP 信誉 / 登录态关联 等多维度），本项目目前**未完全攻克**
> - **CDP 接管是真 Chrome 伪装度最高的路径**，但仍可能被风控命中（验证码 / 滑块 / 限流 / 登录态失效 / 静默降权）
> - 防爬决策写在 `docs/research/` + `docs/adr/`，但**实战变量随时会变**（BOSS 改版 / 风控升级）—— 探针脚本 `scripts/probe-boss-*.mjs` 实测有效，**遇到新症状请先跑 probe 验证假设再改代码**
> - 当前策略：风控触发 → 暂停 + 飞书/控制台告警 + 等用户手动介入 + 持久化进度，**不试图自动化绕过风控**
>
> **请自行调试使用**：
> - 不保证所有人 100% 跑通（依赖账号年龄 / IP 信誉 / 历史行为 等不可控因素）
> - 不保证长期可用（BOSS 任何改版都可能让本工具失效）
> - 你的账号安全由你负责，被风控限制 / 标记 / 封禁 = 你的风险
> - 欢迎提 issue / 跑 probe 上传实测样本，共同维护调研基线（参考 `docs/agents/issue-tracker.md`）

---

## 当前能力（基于实测命令清单）

| 能力 | 命令 | 说明 |
|------|------|------|
| 环境校验 | `bapply init` | 校验 .env 与飞书连通（区分认证/权限/限流/表格不存在 4 类错） |
| 扫码登录 | `bapply login` | 复用本地 Chrome cookies (49h TTL) |
| 搜索岗位 | `bapply search` | 纯展示 / `--write` 评分写飞书 / `--dry-run` 演练 |
| 生成招呼语 | `bapply greet` | 抓 JD (wapi 优先 + DOM fallback) + LLM 生成 |
| 发送招呼 | `bapply send` | 4 参数签名 `[jobId, lid, securityId, --record-id]` |
| 看飞书表 | `bapply list` | 列已评分岗位 |
| 同步飞书 | `bapply sync` | 按状态筛 / 单条更新 / 批量招呼 |
| 投递统计 | `bapply stats` | 总数 / 状态分布 / Top 公司 |
| 接管 Chrome | `bapply chrome` | 打印远程调试启动命令 |
| 自动化投递 | `bapply auto` | 单账号反爬投递策略（带 `init-config` 子命令） |
| 全局接管 | `--cdp` | 走 CDP 接管用户本地 Chrome（反爬等级最高） |

---

## 核心架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  bapply CLI  (src/cli/index.ts, commander)                            │
│  init | login | search | greet | send                                 │
│  list  | sync   | stats | chrome | auto [--phase morning|afternoon]  │
└───────────┬──────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  浏览器自动化层 (src/browser/)                                          │
│  ┌──────────────────────┐    ┌──────────────────────┐                  │
│  │ CDP 接管 (主路径)    │    │ Stealth Launch       │                  │
│  │ chromium.            │    │ (fallback)           │                  │
│  │   connectOverCDP()   │    │ playwright-extra     │                  │
│  └──────────┬───────────┘    └──────────────────────┘                  │
│             ▼                                                          │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │  withGuard() 风控降级中间件 (src/browser/guard.ts)         │          │
│  │   探针 (3s/次) → continue / pause / abort_today / abort │          │
│  │   pause: race(waitForSelector(hidden), sleep(10min))     │          │
│  │   abort 时抛 GuardError(decision) 携带 origin 给 send    │          │
│  └──────────────────────────────────────────────────────────┘          │
│             ▼                                                          │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │ human.ts 人类行为模拟                                      │          │
│  │   贝塞尔曲线鼠标 + 逐字符键入 + typo 注入                  │          │
│  └──────────────────────────────────────────────────────────┘          │
│             │                                                          │
│             ▼                                                          │
│  BOSS API 直调 (page.evaluate 内 fetch, 带 cookies + Referer)         │
│   - /wapi/zpgeek/search/joblist.json  (分页, 跨页去重, throttle 3-16s) │
│   - /wapi/zpgeek/job/card.json       (JD, lid + securityId)          │
│   - /wapi/zpgeek/friend/add.json     (打招呼, 5 状态 action 映射)      │
└──────────────────────────────────────────────────────────────────────┘
            │                                              │
            ▼                                              ▼
┌─────────────────────────────┐    ┌─────────────────────────────────────┐
│  LLM 适配器 (src/llm/)      │    │  飞书层 (src/feishu/)                │
│  ─ adapter='openai'        │    │   tenant_access_token (TTL 缓存)     │
│    (DeepSeek/OpenAI/Ollama)│    │   Bitable CRUD: list/create/update  │
│  ─ adapter='anthropic'     │    │   多维表格持久化(简历/进度/话术/状态)│
│    (Anthropic官方+minimax+ │    │                                     │
│     huoshan+anthropic-     │    │  ── 自动化 notifier (auto 模式) ────│
│     compat)                │    │   飞书 webhook (4 字段可配)         │
│  默认 thinking=disabled    │    │   fallback → console                │
│       response_format=json │    │                                     │
└─────────────────────────────┘    └─────────────────────────────────────┘
                                                  │
                                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  auto 模式 (src/auto/) — Sprint D-1c / ADR-0016                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐    │
│  │ throttle.ts     │  │ guard.ts        │  │ feishu-notifier.ts  │    │
│  │ 7.4 决策树      │  │ auto 风控        │  │ 飞书 webhook 重试    │    │
│  │ - 17:30 daily    │  │ - recordBlock    │  │                     │    │
│  │   done          │  │ - regressWarmup  │  │                     │    │
│  │ - 11:30-14:00   │  │                  │  │                     │    │
│  │   lunch sleep   │  │                  │  │                     │    │
│  │ - weekend block │  │                  │  │                     │    │
│  └────────┬────────┘  └────────┬─────────┘  └──────────┬──────────┘    │
│           │           │             │                              │
│           ▼           ▼             ▼                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  runDailyLoop(deps, date) — Sprint C-2a + D-2a            │    │
│  │   1) loginByQR (cookies 兜底)                               │    │
│  │   2) bossSearch (复用 search-and-write 评分 + 飞书写入)    │    │
│  │   3) per-job: throttleSend → sendGreeting → counter+1     │    │
│  │   4) R2 GuardError (风控) / R3 失败率超阈 → blocked        │    │
│  │   5) exitCode: 0 success / 1 partial / 2 fatal / 3 blocked │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 为什么主路径是 CDP 接管？

启新 Chromium 永远带着 `--enable-automation` 与合成 Canvas 指纹，BOSS 直聘风控一抓一个准。
**接管用户本地已登录的真 Chrome** 才是伪装度最高的路径 — 用户自己的 Canvas / Cookies / TLS JA3 / 登录态，
这是项目 2026-06 调研的核心结论（见 [docs/research/boss-auto-apply-2026-06-research.md §5.2](docs/research/boss-auto-apply-2026-06-research.md)）。

---

## 安装

```bash
git clone https://github.com/boss-apply-dev/boss-apply.git
cd boss-apply
npm install
cp .env.example .env
cp 简历.yml.example 简历.yml       # 你的简历（YAML 格式）
# 编辑 .env + 简历.yml
```

**前置要求：**

- Node.js ≥ 22（用 `nvm install 22`）
- 本机已安装 Chrome（macOS `/Applications/Google Chrome.app` 默认可用；其他平台参考 `docs/ENVIRONMENT.md §4.2`）
- 飞书自建企业应用 + 多维表格（[飞书开放平台](https://open.feishu.cn/)）
- 至少一个 LLM Provider 的 API Key（推荐 DeepSeek，国内直连快）

---

## 快速开始

### 手动模式（适合初次调试）

#### 1) 初始化验证

```bash
bapply init        # 校验 .env 与飞书连通
```

输出应类似：
```
✅ 环境变量加载成功
   飞书 App ID: cli_xxxxx...
   LLM 供应商: deepseek
✅ 飞书 API 连通正常
```

错误码细分（init 会自动判断）：

| 错误特征 | 含义 | 修复方向 |
|---------|------|---------|
| `code=99991` / "invalid" / "unauthorized" | 飞书认证失败 | 检查 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| `code=91402` / "not found" | 飞书表格不存在 | 检查 `FEISHU_APP_TOKEN` / `FEISHU_TABLE_ID` |
| `429` / "rate limit" | 飞书 API 限流 | 稍后重试或检查应用权限 |
| "permission" / "forbidden" | 权限不足 | 给应用加「多维表格」读写权限 |

#### 2) 启动 Chrome 远程调试（CDP 接管）

另开一个终端运行：

```bash
bapply chrome
```

输出会给出一条可复制的 Chrome 启动命令，例如（macOS）：

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=~/.boss-chrome
```

直接复制运行（粘贴回车后 Chrome 会打开，保持开着）。
自定义端口用 `bapply chrome -p 9333`（覆盖 `BOSS_CDP_PORT`）。

#### 3) 端到端流程

```bash
# 登录（首次手动扫一次，后续 Cookie 自动持久化 49h）
bapply login --cdp

# 搜索岗位（不加 flag = 纯展示；加 --write = 评分写飞书；加 --dry-run = 演练）
bapply search "前端开发" --cdp --city "北京"
bapply search "前端开发" --cdp --write --limit 15    # 评分 + 真写飞书
bapply search "前端开发" --cdp --dry-run             # 走全流程但不真写

# 抓 JD + LLM 单独生成招呼语（不发）
bapply greet <jobId> --cdp --lid <lid> --security-id <securityId>

# 真发（必须传 lid + securityId，来自 search 输出）
bapply send <jobId> -l <lid> -s <securityId> --cdp
bapply send <jobId> -l <lid> -s <securityId> --cdp --record-id <飞书记录ID>   # 发完自动回写飞书
```

> 所有业务命令都支持 `--cdp`。**强烈推荐全程 `--cdp`**，反爬伪装度最高。

### 自动模式（auto — 推荐生产部署）

```bash
# 1) 生成配置模板
bapply auto init-config

# 2) 编辑 ./.bapply-state/auto.yaml (搜索词 / 配额 / 节流 / notifier)

# 3) 演练验证
bapply auto --dry-run --phase morning

# 4) 真发 (cron 通常配成 morning + afternoon 双跑)
bapply auto --phase morning
bapply auto --phase afternoon

# 5) 全 reject 但 counter 走完 → exit 2 (致命软错误，方便 CI/CD 报警)
bapply auto --phase morning --strict-exit-code
```

**自动模式关键行为：**

| 行为 | 说明 |
|------|------|
| **节流时段** | 11:30-14:00 午休 sleep 到 14:00；17:30 后今日 done |
| **周末保护** | 默认 weekend block（dry-run 跳过） |
| **warmup 阶梯** | Day1-7 cap=50 → Day8-14 cap=70 → Day15+ cap=100（auto.yaml 可改） |
| **风控触发** | R2: GuardError → 触发即停余量；R3: 失败率 > 30% → 同 |
| **连续风控** | 连续 ≥3 天触发 → 自动降档 warmup tier |
| **退出码** | 0=成功 / 1=部分失败 / 2=fatal / 3=blocked（风控可恢复） |

### cron 安装

```bash
npm run cron:install    # 装 plist (mac) / cron (linux)
npm run cron:uninstall  # 卸
```

工作日 09:00 morning + 14:00 afternoon 各跑一次。

---

## 命令清单

| 命令 | 作用 | 关键参数 | 退出码 |
|------|------|---------|--------|
| `bapply init` | 校验环境变量 + 飞书连通 | — | 0 / 1 |
| `bapply login` | 扫码登录 BOSS，持久化 Cookie（49h） | `--cdp` | 0 / 1 |
| `bapply search <kw>` | 搜索岗位（默认纯展示） | `-c <city>` `--job-type` `--salary` `--experience` `--degree` `--write` `--dry-run` `--no-threshold` `-l <n>` `--cdp` | 0 |
| `bapply greet <jobId>` | 抓 JD + LLM 生成话术（不发） | `--lid` `--security-id` `--cdp` | 0 |
| `bapply send <jobId>` | 发送打招呼消息 | **必填** `-l <lid>` `-s <securityId>`；可选 `--record-id` `--cdp` | 0/1/2/3/4 |
| `bapply list` | 拉飞书多维表格记录 | `-n <limit>` | 0/1/2 |
| `bapply sync` | 飞书状态同步 | `--status` / `--update rec:状态` / `--auto-greet --limit N --dry-run` | 0/1/2 |
| `bapply stats` | 投递统计（Top 公司） | `--top <n>` | 0/1/2 |
| `bapply chrome` | 打印本地 Chrome 远程调试启动命令 | `-p <port>` | 0 |
| `bapply auto` | 单账号反爬投递策略 | `--phase morning\|afternoon` `--dry-run` `--quota <n>` `--config <path>` `--strict-exit-code` `--date <YYYY-MM-DD>` | 0/1/2/3 |
| `bapply auto init-config` | 在 `./.bapply-state/` 生成 `auto.yaml` + `account-meta.json` 模板 | `--config-dir <path>` `--force` | 0/1 |
| 全局 `--cdp` | 接管模式（覆盖各命令） | — | — |

### `send` 退出码细分（最丰富）

| 退出码 | 含义 | 触发条件 |
|--------|------|----------|
| 0 | 成功 | BOSS `code=0` 或 `chatRemindDialog.content` 含"120 位" |
| 1 | 业务失败 | 非风控类错误（fetch 失败 / JSON parse 失败 / BOSS 业务 code） |
| 2 | 参数错 | 缺 `-l` 或 `-s` |
| 3 | 风控今日上限 | `rate_limit` / `login_expired` 信号 → 自动明日恢复 |
| 4 | 风控阻断 | `abort` 决策（不可恢复） |

### `send` 状态映射（飞书"打招呼状态"单选）

| BOSS 响应 | 状态 label |
|----------|-----------|
| `code=0` / "120 位" 提醒 | 已发送 |
| BOSS `code=99991604` | 触发限额 |
| BOSS `code=99991603` | 风控拦截 |
| BOSS `code=1011`（登录失效） | 登录已失效 |
| 其它 | 失败 |

---

## 配置说明（权威：`docs/ENVIRONMENT.md`）

### 核心凭证

| 环境变量 | 必填？ | 默认 | 用途 |
|---------|--------|------|------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | ✓ | — | 飞书企业自建应用凭证 |
| `FEISHU_APP_TOKEN` / `FEISHU_TABLE_ID` | ⨁ | — | 飞书多维表格 appToken / tableId（`list`/`sync`/`stats`/`--write`/`auto` 必填） |
| `FEISHU_WEBHOOK_URL` | ⨁ | — | 飞书自定义机器人 webhook（`auto` 模式告警用；env 优先于 yaml） |

### LLM 供应商（Sprint 1D / ADR-0011 + 2026-07-23 决策）

| 环境变量 | 必填？ | 默认 | 用途 |
|---------|--------|------|------|
| `LLM_PROVIDER` | ⨁ | `deepseek` | `deepseek` / `openai` / `anthropic` / `ollama` / `minimax` / `huoshan` / `anthropic-compat` |
| `LLM_ADAPTER` | ⨁ | `anthropic` | **协议层**解耦：`openai` \| `anthropic`（adapter 显式优先于 provider 推断） |
| `LLM_AUTH_STYLE` | ⨁ | `bearer` | `anthropic` 协议鉴权：`x-api-key` \| `bearer`（国产几乎都是 bearer） |
| `LLM_API_KEY` | ✓ | — | 通用 API Key（已迁移；旧 `DEEPSEEK_API_KEY` 等会报迁移错） |
| `LLM_BASE_URL` | ⨁ | 按 provider | 自定义 endpoint（`anthropic-compat` 必填） |
| `LLM_MODEL` | ⨁ | 按 provider | 自定义模型（`anthropic-compat` 必填） |

**老 env 迁移**：`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_BASE_URL` / `OLLAMA_MODEL` 若存在但新 env 未设，启动会一次列全失败并指引迁移到 `LLM_*` 4 字段。

**provider 默认 endpoint（adapter 推断路径）：**

| provider | adapter | baseURL | model |
|----------|---------|---------|-------|
| `deepseek` | openai | `https://api.deepseek.com` | `deepseek-chat` |
| `openai` | openai | `https://api.openai.com/v1` | `gpt-4o` |
| `anthropic` | anthropic | `https://api.anthropic.com` | `claude-sonnet-4-20250514` |
| `ollama` | openai | `http://localhost:11434/v1` | `llama3` |
| `minimax` | anthropic | `https://api.minimaxi.com/anthropic` | `MiniMax-M2.7-highspeed` |
| `huoshan` | anthropic | `https://ark.cn-beijing.volces.com/api/coding` | `glm-5.2` |
| `anthropic-compat` | anthropic | **必填** | **必填** |

### 浏览器

| 环境变量 | 必填？ | 默认 | 用途 |
|---------|--------|------|------|
| `BOSS_CDP_PORT` | ⨁ | `9222` | Chrome `--remote-debugging-port`，CLI `-p` 可覆盖 |
| `BOSS_CHROME_PATH` | ⨁ | 平台推断 | Chrome 可执行绝对路径（多版本并存时锁定） |
| `CHROMIUM_PATH` | ⨁ | Playwright 内置 | **fallback** 启动模式（不用 CDP 时） |
| `BOSS_NOTIFIER_TIMEOUT_MS` | ⨁ | `5000` | `withGuard` OS notifier spawn 子进程超时 |

### 评分

| 环境变量 | 必填？ | 默认 | 用途 |
|---------|--------|------|------|
| `SCORE_THRESHOLD` | ⨁ | `0.85` | 评分阈值（0-1），`--write` / `auto` 用 |
| `SCORE_WEIGHTS` | ⨁ | 6 维等比 | `education:0.1,experience:0.3,skill:0.1,project:0.3,stability:0.1,potential:0.1` |
| `MIN_JD_LENGTH_THRESHOLD` | ⨁ | `500` | `fetchJobDetail` 判定懒加载完成的 JD 最短字符数 |

### 简历

| 环境变量 | 必填？ | 默认 | 用途 |
|---------|--------|------|------|
| `BOSS_RESUME_UID` | ⨁ | — | ⚠️ **已弃用**（2026-07-21）：当前 `src/` 无消费者。可安全从 `.env` 删除 |

---

## auto.yaml 配置（auto 模式专属）

**权威 schema：`src/auto/config-schema.ts`（zod）** · **示例：`auto.yaml.example`**

```yaml
version: 1

searches:                       # 至少 1 项；逐项顺序执行，跨轮 encryptJobId 去重
  - keyword: "Java 后端"
    city: "杭州"
    limit: 15
  # jobType/salary/experience/degree 是 BOSS 过滤码 (数字)
  # DEEP probe 实测：见 src/cli/search-filters.ts

quota:
  morning: 40                   # morning + afternoon = 日配额
  afternoon: 60
  weekly_cap: 500

warmup:                         # 单账号 Day1-7 cap 阶梯
  enabled: true
  schedule:
    - { day_start: 1,  cap: 50 }
    - { day_start: 8,  cap: 70 }
    - { day_start: 15, cap: 100 }

throttle:
  morning_interval_ms:   [180000, 240000]   # 3-4 min
  afternoon_interval_ms: [150000, 195000]   # 2.5-3.25 min
  jitter_pct: 20
  long_pause:           { every_n_jobs: 20, duration_ms: [300000, 600000] }     # 每 20 条 5-10 min
  afternoon_mid_break:  { after_job:    30, duration_ms: [600000, 900000] }     # 第 30 条 10-15 min

safety:
  guard_trigger_policy: 'abort_day'           # abort_day | abort_run | continue
  max_failure_rate: 0.3
  consecutive_guard_threshold: 3              # 连续 N 天触发 → 自动降档
  auto_regress_warmup: true

notifier:                                     # 可选；推荐走 FEISHU_WEBHOOK_URL env
  webhookUrl: "https://open.feishu.cn/hook/XXX"
  maxRetries: 3
  initialBackoffMs: 1000
  timeoutMs: 5000
```

启动顺序（`bapply auto init-config`）：在 `./.bapply-state/` 生成 `auto.yaml` + `account-meta.json` 两个模板（atomic write，缺则生成；存在则跳过除非 `--force`）。

---

## 简历（`简历.yml`）

**字段 schema（强切 to YAML，Sprint 1B+）：**

```yaml
basic:
  name: "张三"
  yearsOfExperience: 3
  degree: "本科"
  school: "某某大学"
  isElite: true              # 是否 985/211
  isBigTech: true            # 是否大厂背景
skills:
  - "TypeScript"
  - "React"
  - "Node.js"
recentProjects:
  - "2024 Q1: 主导 XX 系统重构，QPS 提升 2 倍"
  - "2023 Q3: 重构 YY 模块，bug 率下降 40%"
```

**校验错误细分**（`bapply search --write` / `auto` 触发）：

| 错误类 | 触发条件 |
|--------|---------|
| `ResumeNotFoundError` | `简历.yml` 不存在 |
| `IncompleteResumeError` | 缺必填字段（`basic.name` / `basic.yearsOfExperience` / `skills`） |
| `ResumeParseError` | YAML 语法错或 schema 不符 |

---

## 6 维评分（`src/scoring/dimensions.ts`）

按用户权重 `SCORE_WEIGHTS` 求加权总分 `totalScore ∈ [0,1]`：

| 维度 | 默认权重 | 解释 |
|------|---------|------|
| education | 10% | 学校层次 + 专业相关性 + 985/211 |
| experience | 30% | 工作年限 + 行业相关性 + 职位层级 |
| skill | 10% | JD 技能 vs 候选人技能覆盖度 |
| project | 30% | 近期项目复杂度 / 规模 / 影响力 |
| stability | 10% | 跳槽频率 + 在职时长 |
| potential | 10% | 成长性 + 学习能力 + 管理潜力 |

**容错 / 智能重试：**
- LLM 错误（网络 / API）→ 重试 1 次后透传
- 评分 JSON 解析失败（`ScoreParseError`）→ **不重试**（重试也是脏数据）
- 单维度缺失 → 默认 0.5 + "维度解析失败"
- `totalScore` 本地重算，**忽略 LLM 的 totalScore 字段**（trust local arithmetic）

---

## BOSS API 协议（实测基准）

| 端点 | 用途 | 关键参数 |
|------|------|---------|
| `/wapi/zpgeek/search/joblist.json` | 搜索岗位列表（分页，跨页去重） | `query / scene / page / pageSize / city / jobType / salary / experience / degree` |
| `/wapi/zpgeek/job/card.json` | 抓 JD（**`lid` + `securityId` 必传**） | `?lid=&securityId=&sessionId=` |
| `/wapi/zpgeek/friend/add.json` | 发打招呼（`Zp_token` + 全量 Cookie） | `POST ?securityId=&jobId=&lid=` body=null |

**契约基线**：`tests/fixtures/boss-schema.json`（由 `npm run probe:boss` 重新生成）。

---

## 风控信号 + 决策

**信号类型（`src/browser/guard.ts`）：**

| signal | selector | 动作 |
|--------|----------|------|
| `verify_captcha` | `.geetest_panel` 等 | pause → 等用户扫 → 回车继续 |
| `verify_slider`  | `.slider-verify` 等 | pause → 同上 |
| `rate_limit`     | `.daily-limit-tip` | abort_today（exit 3，明日自动恢复） |
| `login_expired`  | `.session-timeout-modal` | abort_today |
| `session_expired` (send 探测) | BOSS `code=1011` | 标记飞书状态"登录已失效" |
| fallback         | `[role="dialog"]` | 仅 confidence 0.3 提示，不阻塞 |

**退出码 → 飞书/监控决策映射：** 见 `send` / `sync --auto-greet` / `auto` 退出码表。

---

## 开发规范

```bash
npm test             # vitest run（单测）
npm run typecheck    # tsc --noEmit
npm run smoke        # pre-commit hook
npm run smoke:cli    # CLI 端到端冒烟（不动 BOSS）
npm run smoke:commands
npm run probe:boss   # 抓 BOSS API 最新 schema (生成 boss-schema.json)
npm run verify:feishu # 飞书表 schema 校验
```

**项目纪律**（详见 [CLAUDE.md](CLAUDE.md)）：

- 新功能必须先写 RED 测试（§3.2 TDD 铁律）
- 改 ≥1 文件 / 算法 / 接口 / schema / 部署前必须先画 4 类 ASCII 图（架构 / 时序 / 关系 / 流程）
- 涉及外部依赖改动**必须先 probe** 验证假设（mock ≠ 真实）
- 错误日志带 `[layer.op]` 前缀；throw 加 `cause`；class 带 `this.layer`

---

## 合规声明（Compliance）

> ⚠️ **本项目当前仍存在 BOSS 风控风险，请自行调试使用，账号安全自负。**
> 详见顶部「风控现状备注」。

> ⚠️ **本工具仅供个人已授权的单账号使用，不得用于任何违反 BOSS 直聘 ToS 的批量 / 商业化场景。**

- ✅ 个人求职、辅助筛选、提升投递效率
- ❌ 商业 SaaS 化、多账号切换、自动绕验证码（OCR / 模拟轨迹）
- ❌ 任何违反《网络安全法》《个人信息保护法》的使用

**作者按"最大善意原则"提供工具，不对滥用造成的法律 / 账号风险负责。**

---

## 进一步阅读

### 调研（项目级）

- [docs/research/boss-auto-apply-2026-06-research.md](docs/research/boss-auto-apply-2026-06-research.md) — Buy vs Build 决策 + §5.2 主路径论证
- [docs/research/ai-job-master-tampermonkey-survey-2026-07-13.md](docs/research/ai-job-master-tampermonkey-survey-2026-07-13.md) — 油猴参照系调研
- [docs/research/get_jobs-boss-survey-2026-07-14.md](docs/research/get_jobs-boss-survey-2026-07-14.md) — get_jobs 项目调研

### 决策记录（ADR）

- [0002-cdp-guard-human-architecture.md](docs/adr/0002-cdp-guard-human-architecture.md) — 主架构 (CDP+Guard+Human)
- [0003-boss-api-city-locking.md](docs/adr/0003-boss-api-city-locking.md) — 城市警告机制
- [0004-fetchjobdetail-lazy-defense.md](docs/adr/0004-fetchjobdetail-lazy-defense.md) — JD 懒加载防御
- [0005-robust-evaluate.md](docs/adr/0005-robust-evaluate.md) — `robustEvaluate` 反 SPA race
- [0007-friend-add-证据溯源-p3-协议.md](docs/adr/0007-friend-add-证据溯源-p3-协议.md) — `send` P3 协议
- [0008-feishu-schema-sprint-c.md](docs/adr/0008-feishu-schema-sprint-c.md) — 飞书表 schema
- [0009-resume-yaml-format.md](docs/adr/0009-resume-yaml-format.md) — YAML 简历格式
- [0010-scoring-6-dimensions.md](docs/adr/0010-scoring-6-dimensions.md) — 6 维评分
- [0011-llm-multi-provider.md](docs/adr/0011-llm-multi-provider.md) — 多 LLM 供应商
- [0012-huoshan-anthropic-bearer.md](docs/adr/0012-huoshan-anthropic-bearer.md) — 火山 / bearer 鉴权
- [0013-anthropic-compat-generic.md](docs/adr/0013-anthropic-compat-generic.md) — 通用 anthropic-compat
- [0014-search-fake-red-after-login-by-qr-fix.md](docs/adr/0014-search-fake-red-after-login-by-qr-fix.md) — search 假红修复
- [0016-anti-bot-delivery-strategy.md](docs/adr/0016-anti-bot-delivery-strategy.md) — auto 模式反爬投递策略

### 项目规范

- [CLAUDE.md](CLAUDE.md) — Claude Code 工作规约（TDD + 4 类图 + 错误分层）
- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — 环境变量权威文档
- [docs/prd.md](docs/prd.md) — PRD
- [docs/adr/_template.md](docs/adr/_template.md) — 新 ADR 模板

---

## License

MIT（仅限合规授权场景，详见上方"合规声明"）。
