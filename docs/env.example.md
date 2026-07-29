# bapply 环境变量模板

> **用途**: 复制本模板 → 仓库根 `.env` (已在 `.gitignore` 中), 填入真实值后跑 `bapply`.
> 真实 `.env` 文件不进 git, 只有本 `docs/env.example.md` 进 git 作为 source of truth.

## 加载机制

`src/config/index.ts:1` 已经 `import 'dotenv/config'`.

- 任何 `bapply` 子命令启动时, dotenv 自动读仓库根 `.env` 文件并注入 `process.env`
- 优先级: `process.env` 已存在的 env var > `.env` 文件里的值 (dotenv 默认**不覆盖**已存在的 env var)
- 不设值 → 走代码内 default(例如 `FEISHU_WEBHOOK_URL` 不设 → `consoleNotifier` fallback, 终端打印)

## 模板 (复制下面到 `.env`)

```bash
# ─── 飞书自定义机器人 webhook (E-1b 探测, 实时推 critical/warn 事件) ─
# 推荐生产设置: 在你的飞书群里 "添加机器人" → "自定义机器人" → 复制 webhook URL
# 不设 → consoleNotifier fallback (终端打印)
FEISHU_WEBHOOK_URL=https://open.feishu.cn/hook/XXXXXXXX

# ─── 飞书开放平台 (多维表格写回 / 命令鉴权) ─────────────────
FEISHU_APP_ID=cli_XXXXXXXX
FEISHU_APP_SECRET=XXXXXXXX
FEISHU_APP_TOKEN=bascnXXXXXXXX
FEISHU_TABLE_ID=tblXXXXXXXX

# ─── LLM provider API key (greeting 文案生成 + 评分) ─────────────
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-XXXXXXXX
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
OPENAI_API_KEY=sk-XXXXXXXX
OPENAI_MODEL=gpt-4o-mini

# ─── BOSS 直聘 (单账号, 通常由 `bapply login` 写 cookies.json) ──────
# BOSS_RESUME_UID=YYYYYYY
```

## 相关 ADR

- §17.9 飞书 notifier 集成规划
- §17.14 E-1b 落地 (mergeWebhookFromEnv + cli env merge)
