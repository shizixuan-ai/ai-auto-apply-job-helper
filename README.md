# boss-apply

> AI 辅助向 BOSS 直聘（zhipin.com）自动打招呼的开源 CLI。
> 关注"个人账号、合规授权、可解释反爬"，而非"批量刷简历"。

---

## 项目定位

`boss-apply` 是一个**单账号辅助投递工具**，设计原则是：

- **合规优先**：遵守 BOSS 直聘 ToS，仅服务用户本人已登录的单账号
- **人工兜底**：检测到风控信号（验证码、滑块、限流）会暂停并等你介入
- **可解释**：核心反爬决策写进 `docs/research/`，为什么这么做有据可查
- **可恢复**：所有 Cookie / 简历 / 进度持久化到本地 + 飞书多维表格

**绝对禁止**：批量注册、多账号切换、绕过验证码自动化（OCR / 模拟轨迹点击）、账号劫持。

---

## 核心架构（CDP 接管 + 风控降级 + 人类行为模拟）

```
┌───────────────────────────────────────────────────────────────────┐
│  bapply CLI  (src/cli/)                                           │
│    init | login | search | greet | send | chrome                  │
└────────────┬──────────────────────────────────────────────────────┘
             │
             ▼
┌───────────────────────────────────────────────────────────────────┐
│  浏览器自动化层 (src/browser/)                                     │
│  ┌──────────────────────┐    ┌──────────────────────┐              │
│  │ CDP 接管 (主路径)    │    │ Stealth Launch       │              │
│  │ chromium.            │    │ (fallback)           │              │
│  │   connectOverCDP()   │    │ playwright-extra     │              │
│  └──────────┬───────────┘    └──────────────────────┘              │
│             ▼                                                      │
│  ┌──────────────────────────────────────────────────┐              │
│  │  withGuard() 风控降级中间件 (src/browser/guard.ts) │             │
│  │   探针 → 暂停 → 通知 → 等用户 → 恢复             │              │
│  └──────────────────────────────────────────────────┘              │
│             ▼                                                      │
│  ┌──────────────────────────────────────────────────┐              │
│  │ human.ts 人类行为模拟                              │              │
│  │   贝塞尔曲线鼠标 + 逐字符键入 + typo 注入          │              │
│  └──────────────────────────────────────────────────┘              │
└───────────────────────────────────────────────────────────────────┘
             │
             ▼
┌───────────────────────────────────────────────────────────────────┐
│  LLM 层 (src/llm/)  →  DeepSeek / OpenAI / Anthropic / Ollama     │
│  飞书层 (src/feishu/) → 多维表格持久化（简历 / 进度 / 话术）         │
└───────────────────────────────────────────────────────────────────┘
```

**为什么主路径是 CDP 接管，而不是启新 Chromium？**

启新 Chromium 永远带着 `--enable-automation` 与合成 Canvas 指纹，BOSS 直聘风控一抓一个准。**接管用户本地已登录的真 Chrome** 才是伪装度最高的路径（用户自己的 Canvas / Cookies / TLS JA3 / 登录态），这是项目 2026-06 调研的核心结论（见 [docs/research/boss-auto-apply-2026-06-research.md §5.2](docs/research/boss-auto-apply-2026-06-research.md)）。

---

## 安装

```bash
git clone https://github.com/boss-apply-dev/boss-apply.git
cd boss-apply
npm install
cp .env.example .env
# 编辑 .env 填入飞书 / LLM 凭证
```

**前置要求：**
- Node.js ≥ 22（用 `nvm install 22`）
- 本机已安装 Chrome（macOS `/Applications/Google Chrome.app` 默认可用；其他平台需要先 `brew install --cask google-chrome` / `choco install googlechrome` / `apt install google-chrome-stable`，详见 [docs/research/boss-auto-apply-2026-06-research.md §4.1](docs/research/boss-auto-apply-2026-06-research.md)）

---

## 快速开始

### 1) 初始化验证

```bash
bapply init        # 校验 .env 与飞书连通性
```

输出应类似：
```
✅ 环境变量加载成功
✅ 飞书 API 连通正常
```

### 2) 启动 Chrome 远程调试

另开一个终端运行：

```bash
bapply chrome
```

输出会给出一条可复制的 Chrome 启动命令，例如（macOS）：
```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=~/.boss-chrome
```

直接复制运行即可（粘贴回车后**Chrome 会打开**，保持开着）。

自定义端口用 `-p 9333`（覆盖 `.env` 中的 `BOSS_CDP_PORT`）。

### 3) 端到端流程

```bash
bapply login  --cdp        # 接管模式扫码（首次手动扫一次，后续 Cookie 持久化）
bapply search "前端开发" --cdp --city "北京"
bapply greet <jobId> --cdp # 生成打招呼话术
bapply send  <jobId> -m "..." --cdp
```

> 所有业务命令都支持 `--cdp` 切换"接管模式 / fallback 启动模式"。
> 强烈推荐全程 `--cdp`，反爬伪装度最高。

---

## 命令清单

| 命令 | 作用 | 关键参数 |
|------|------|---------|
| `bapply init` | 校验环境变量 + 飞书连通 | — |
| `bapply login` | 扫码登录 BOSS，持久化 Cookie | `--cdp` 接管模式 |
| `bapply search <kw>` | 搜索岗位列表 | `-c <city>`、`--cdp` |
| `bapply greet <jobId>` | 抓 JD + LLM 生成话术 | `--cdp` |
| `bapply send <jobId>` | 发送打招呼消息 | `-m <message>`、`--cdp` |
| `bapply chrome` | 打印本地 Chrome 远程调试启动命令 | `-p <port>` |

所有命令都接受全局 `--cdp` 标志（接管模式）以适配用户的反爬强度偏好。

---

## 配置说明

| 环境变量 | 必填？ | 默认 | 用途 |
|---------|--------|------|------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | ✓ | — | 飞书多维表格凭证（简历 / 进度持久化） |
| `LLM_PROVIDER` | ⨁ | `deepseek` | LLM 供应商：`deepseek` / `openai` / `anthropic` / `ollama` |
| `DEEPSEEK_API_KEY` 等 | 视 provider | — | 对应供应商的 API Key |
| `BOSS_RESUME_UID` | ⨁ | — | 在线简历 UID（部分简历抓取场景需要） |
| `BOSS_CDP_PORT` | ⨁ | `9222` | Chrome `--remote-debugging-port` 端口 |
| `BOSS_CHROME_PATH` | ⨁ | 平台推断 | Chrome 可执行路径覆盖（多版本并存时用） |
| `CHROMIUM_PATH` | ⨁ | Playwright 内置 | **fallback** 启动模式时的浏览器路径 |

**所有环境变量的权威文档（含语义 / 默认值 / 优先级链）见 [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)**。本表只是概览指针。

---

## 开发规范

本项目严格遵循 TDD + 配置冻结：

- 单元测试：`npm test`
- 类型检查：`npm run typecheck`
- 新功能必须先写 RED 测试（参见 [CLAUDE.md](CLAUDE.md) §3.2）
- 修改 ≥1 文件的代码 / 接口 / 算法前必须先画 4 类 ASCII 图（架构 / 时序 / 关系 / 流程）

---

## 合规声明（Compliance）

> ⚠️ **本工具仅供个人已授权的单账号使用，不得用于任何违反 BOSS 直聘 ToS 的批量 / 商业化场景。**

- ✅ 个人求职、辅助筛选、提升投递效率
- ❌ 商业 SaaS 化、多账号切换、自动绕验证码
- ❌ 任何违反《网络安全法》《个人信息保护法》的使用

**作者按"最大善意原则"提供工具，不对滥用造成的法律 / 账号风险负责。**

---

## 进一步阅读

- [docs/research/boss-auto-apply-2026-06-research.md](docs/research/boss-auto-apply-2026-06-research.md) — 调研报告（Buy vs Build 决策、§5.2 主路径论证、风险评估）
- [CLAUDE.md](CLAUDE.md) — 项目内 Claude Code 操作规约（TDD、4 类图、文档冻结）

---

## License

MIT（仅限合规授权场景，详见上方"合规声明"）。
