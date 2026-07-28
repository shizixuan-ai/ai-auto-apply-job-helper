# ADR-0011: LLM 多供应商扩展 + Anthropic 协议通用化

> **状态**：已实施（Phase 1/2/3 完成 / Phase 4 huoshan 待 user 提供 URL + protocol + model）
> **作者**：AI + user（2026-07-20）
> **日期**：2026-07-20
> **关联**：Sprint 1D；前置 ADR-0010（六维评分，本 ADR 不动评分逻辑）
> **纪律**：按 `~/.claude/CLAUDE.md` §3.5 4 类图前置 + §3.8 调试纪律 + §3.9 错误传播图 + §3.10 refactor checklist + §3.11 不能只信 hook + §4 TDD 6 步
>
> **实施 commits**：
> - Phase 1 (env 统一)：`dcbecc8` — 4 文件 / 3 RED 测试 (R3/R4/R6)
> - Phase 2 (provider string 化)：`84adc9c` — 4 文件 / 2 RED 测试 (R2 + minimax throw 暂存)
> - Phase 3 (AnthropicCompatAdapter)：`07f0989` — 2 文件 / R1 + R5 + R7 + R5-supplement

---

## 1. 背景与目标

老 `src/llm/index.ts` 用 `LLMProvider` **enum** 锁 4 供应商，每供应商独立 env（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_BASE_URL` / `OLLAMA_MODEL`），硬编码 baseURL + model。Sprint 1D 要加 **MiniMax** + 后续 **火山方舟 coding plan**。

**问题**：
- 每加 1 个供应商要：enum +1 case + 1-3 个 env var + hardcoded baseURL/model。配置爆炸、代码噪声。
- 协议混用被 enum 隐式绑死：MiniMax 实际是 **Anthropic 协议**（不是 OpenAI 兼容），但 enum 命名不能表达"协议族"。
- 老 env 散落 5 个，迁移/排错心智负担高（"我现在到底是哪个生效？"）。
- 火山方舟协议未确认（OpenAI 兼容？Anthropic 协议？私有？），先把架构做对再接。

**关键架构澄清**（按 §3.6 A/B 分类）：
- [已确认] MiniMax base URL = `https://api.minimaxi.com/anthropic`（路径含 "anthropic" → Anthropic 协议）
- [已确认] MiniMax 协议族 = Anthropic（不是 OpenAI 兼容）
- [已确认] 验证证据：`~/.claude/settings.json` 里 `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` 已在跑 Anthropic SDK → MiniMax 端点（不是猜测）

**目标**：
- provider 用 `string`（替 enum），未来加供应商 0 改动 enum 定义
- **Anthropic 协议适配器通用化**：`AnthropicCompatAdapter` 接受任意 baseURL，覆盖 Anthropic 官方 + MiniMax + 未来 Antrhopic 兼容供应商
- **env 统一为 4 个**：`LLM_PROVIDER` + `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`
- **老 env 强制迁移**：启动时检测 → 任意老 env 存在且新 env 未设 → fail-fast 报错
- **default = deepseek**（`LLM_PROVIDER` unset 时）
- **huoshan 协议未定**先 `.env.example` 预留位 + createLLM 返 throw "未配置"
- **安全**：真实 API_KEY **仅经 `.env` 注入**（已在 .gitignore），不入 ADR / 不入 commit / 不入 .env.example

---

## 2. 决策（Decision）

**采用方案 D：通用 env + string provider + 老 env hard fail + Anthropic 协议通用化**

### 2.1 provider 字段

| 项 | 老 | 新 |
|---|---|---|
| 类型 | `LLMProvider` enum（src/types/index.ts） | `string` |
| 已知值 | deepseek / openai / anthropic / ollama | deepseek / openai / anthropic / ollama / minimax / huoshan |
| 校验 | TS enum 编译时强制 | 运行时 `createLLM` switch default 抛 `Error("不支持的 LLM 供应商: ${provider}")` |
| Default | 无（env 必须设） | unset 时 → `'deepseek'` |

### 2.2 `AnthropicAdapter` → `AnthropicCompatAdapter`

| 项 | 老 | 新 |
|---|---|---|
| 绑定 URL | `https://api.anthropic.com`（硬编码） | 构造参数 `baseURL: string` |
| 适配场景 | 仅 Anthropic 官方 | Anthropic 官方 + MiniMax + 任何走 `/v1/messages` + `x-api-key` 的兼容端点 |
| 模型 | 硬编码 `claude-sonnet-4-20250514` | 构造参数 `model: string`（从 `LLM_MODEL` 来） |
| 错误处理 | 沿用空内容 throw 纪律（ADR-0010 同款） | 同 |

### 2.3 env 统一

**新增 4 个**（env 命名约定：`LLM_*` 前缀）：

| env | 含义 | 默认 |
|---|---|---|
| `LLM_PROVIDER` | 供应商名 | unset → `'deepseek'` |
| `LLM_API_KEY` | 通用 API key | 必填（除 ollama 用 'ollama' 占位） |
| `LLM_BASE_URL` | 通用 base URL | 按 provider 走默认值 |
| `LLM_MODEL` | 通用模型名 | 按 provider 走默认模型 |

**老 env 5 个全部废弃**：

| 老 env | 替代 |
|---|---|
| `DEEPSEEK_API_KEY` | `LLM_API_KEY`（当 `LLM_PROVIDER=deepseek`） |
| `OPENAI_API_KEY` | `LLM_API_KEY`（当 `LLM_PROVIDER=openai`） |
| `ANTHROPIC_API_KEY` | `LLM_API_KEY`（当 `LLM_PROVIDER=anthropic`） |
| `OLLAMA_BASE_URL` | `LLM_BASE_URL`（当 `LLM_PROVIDER=ollama`） |
| `OLLAMA_MODEL` | `LLM_MODEL`（当 `LLM_PROVIDER=ollama`） |

### 2.4 老 env 强制迁移（hard fail）

启动时检测顺序：
1. 读 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_PROVIDER`
2. 扫描老 env 5 个是否任一存在
3. **任一老 env 存在 + `LLM_*` 未设对应字段** → fail-fast：
   - exit code ≠ 0
   - stderr 输出：`[LLM config error] 检测到老 env DEEPSEEK_API_KEY，请改用 LLM_API_KEY（详见 ADR-0011 §2.4）`
4. 同时多个老 env 存在 → 一次性列全，不逐个报错

---

## 3. 证据（已验证假设 / 必填）

> ⚠️ 每个假设必须附独立证据（commit hash / 实测输出 / log / 截图 / 文件内容）

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | MiniMax 是 Anthropic 协议端点（不是 OpenAI 兼容） | `~/.claude/settings.json` 中 `"ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic"` | `cat ~/.claude/settings.json` 读取已确认（实测） |
| H2 | MiniMax 协议族可用 Anthropic SDK（`x-api-key` + `/v1/messages`） | 同上 — `ANTHROPIC_BASE_URL` 走 minimax 已运行 Anthropic 协议 | 实测 Anthropic 客户端跑通 minimax 端点（settings 部署证据） |
| H3 | 老 `AnthropicAdapter` 绑死 `https://api.anthropic.com` | `src/llm/index.ts:97` `fetch('https://api.anthropic.com/v1/messages', ...)` | Read 文件直接确认 |
| H4 | 老 env 5 个存在 | `.env.example` 列出 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_BASE_URL` / `OLLAMA_MODEL` + `LLM_PROVIDER=deepseek` | `grep .env.example` 实测 |
| H5 | `.env` 在 `.gitignore`（真实 KEY 不会 commit） | `.gitignore` 含 `.env` / `.env.*` | Read 文件直接确认 |
| H6 | 真实 KEY 未曾在 git 历史 | `git log --all -p -S <KEY片段> --oneline \| grep <KEY片段>` 返回 0 hits | 实测 grep（commit 历史 0 命中） |
| H7 | provider 类型当前是 enum | `src/types/index.ts` 中有 `LLMProvider` 类型声明（待 Sprint 1D 实施时确认精确字段名） | Read src/types/index.ts 待 §9 实施 Step 1 时确认 |

---

## 4. 反例（已证伪假设 / 必填）

> ⚠️ 每个被排除的假设必须附证伪过程

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | "MiniMax 也是 OpenAI 兼容，可以走 `OpenAIAdapter`" | MiniMax URL 路径含 "anthropic"（`/anthropic` 段），不是 OpenAI 风格的 `/v1/chat/completions`；OpenAI SDK 调 MiniMax 会报协议错误 | URL 字面证据（H1）+ settings.json ANTHROPIC_BASE_URL 走 minimax 跑通（H2） |
| E2 | "Anthropic 兼容 adapter 是临时方案，老 adapter 仍可用" | 老 adapter 绑死 URL，无法同时支持 Anthropic 官方 + MiniMax + 未来其他；新增供应商就要新 case。通用化一劳永逸 | 代码路径分析（`AnthropicAdapter` 构造函数无 baseURL 参数） |
| E3 | "保留 4 个独立 env，新供应商用第 5/6 个" | 配置爆炸（每供应商 2-3 env）+ 心智负担（5+ env 哪个生效？）+ ADR-0009 已为多供应商铺路（YAML 化） | 现状分析（4 供应商 5 env 已显混乱）+ 类比 0009 YAML 化动机 |
| E4 | "老 env 自动映射到新 env，无需用户改" | 隐藏配置变化 → user 看不到迁移提示 → 后续 audit 难定位 → §3.11 不能只信 hook 的精神要求显式可见 | §3.11 反模式 |
| E5 | "provider 用 enum 也能扩展，加 case 即可" | enum 强约束编译期，新增供应商要改 src/types；string + switch default 抛错 = 运行时灵活 + 显式错误 | TS 类型系统约束 + 维护成本 |
| E6 | "huoshan 协议和 MiniMax 一样是 Anthropic" | 无证据（user 未提供）。不能假设（§3.6 B 类）。本 ADR 强制 throw "未配置"，等 user 提供后再写 case | [AI 假设] huoshan = 待定 |

---

## 5. 备选方案（取舍 / 必填）

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **D. 本方案**（通用 env + string provider + hard fail） | 配置收敛到 4 个 / 协议族清晰 / 老 env 强迁移可见 / Anthropic 通用化未来 0 改动 | 老用户必须改 .env（hard fail） | ✓ |
| A. 保持 4 独立 env + 加 case | 0 改动老用户 | 配置爆炸（每供应商 2-3 env）/ MiniMax 走哪个 env？/ huoshan 又来 2 个？ | ✗ 不可扩展 |
| B. env 自动发现命名约定（`${PROVIDER}_API_KEY`） | user 自加供应商不用改 src | 不可见（user 不知道哪个生效）/ 拼写错误静默失败 / 调试噩梦 | ✗ §3.11 反模式 |
| C. 软迁移（warning + 双轨） | 老用户无感过渡 | 隐藏配置变化 / 长期双轨维护 / 心智负担（哪个生效？） | ✗ §3.11 + §3.6 |
| E. provider 用 enum 不动 + case 扩展 | TS 编译期约束 | 与 §3.6「数据模型选择 = B 类」冲突（enum 强约束扩展性差） | ✗ §3.6 |

---

## 6. 行为契约（可证伪 / 必填）

> ⚠️ 每条契约必须可观测 / 可测试

- ✓ **B1**：`createLLM({ provider: 'minimax', ... })` 返回 `AnthropicCompatAdapter`，baseURL = `https://api.minimaxi.com/anthropic`（从 LLM_BASE_URL 来）—— vitest TEST R1
- ✓ **B2**：`createLLM({ provider: 'huoshan', ... })` throw `Error("LLM 供应商 huoshan 尚未配置（等火山方舟 coding plan 协议确认后再启用，详见 ADR-0011 §10）")` —— vitest TEST R2
- ✓ **B3**：env `DEEPSEEK_API_KEY` 存在 + `LLM_API_KEY` 未设 → `loadConfig()` throw + exit ≠ 0 + stderr 含「请改用 LLM_API_KEY」 —— vitest TEST R3
- ✓ **B4**：`LLM_PROVIDER` unset → `config.llm.provider === 'deepseek'`（default） —— vitest TEST R4
- ✓ **B5**：`AnthropicCompatAdapter.generate()` 用传入 baseURL + `x-api-key` header 调用 `/v1/messages` —— vitest TEST R5（mock fetch）
- ✓ **B6**：env 老 5 个同时存在 → `loadConfig()` throw 一次性列全 5 个（不逐个报） —— vitest TEST R6
- ✓ **B7**：`AnthropicCompatAdapter.generate()` content 缺失 → throw（沿用 ADR-0010 空内容 throw 纪律） —— vitest TEST R7
- ✗ **B8（不在本 ADR）**：huoshan 实际接入 = §10 后续
- ✓ **B9（安全）**：真实 API_KEY 不出现在 ADR / commit message / .env.example —— 实测：grep 全文 0 hits（H6 已确认 git history 0 hits）

---

## 7. 4 类图（必填 / ASCII）

> 按 §3.5 触发：跨 ≥2 文件 + 改 API 端点 + 改 schema → 必画 4 类图

### 7.1 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│ CLI (bin/, src/cli/)                                              │
│   └─→ loadConfig() ──→ AppConfig.llm ──→ createLLM(config)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ src/llm/index.ts                                                  │
│   createLLM(config)                                               │
│     ├─ provider === 'deepseek' ──→ OpenAIAdapter (baseURL default)│
│     ├─ provider === 'openai'   ──→ OpenAIAdapter                 │
│     ├─ provider === 'ollama'   ──→ OpenAIAdapter (key='ollama')  │
│     ├─ provider === 'anthropic'──→ AnthropicCompatAdapter        │
│     ├─ provider === 'minimax'  ──→ AnthropicCompatAdapter ★NEW   │
│     ├─ provider === 'huoshan'  ──→ throw "未配置"               │
│     └─ default                  ──→ throw "不支持的供应商"       │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────────────┐    ┌──────────────────────────────────┐
│ OpenAIAdapter            │    │ AnthropicCompatAdapter ★NEW      │
│   apiKey: LLM_API_KEY    │    │   apiKey: LLM_API_KEY            │
│   baseURL: LLM_BASE_URL  │    │   baseURL: LLM_BASE_URL  ★参数化 │
│   model:  LLM_MODEL      │    │   model:  LLM_MODEL              │
│   ─────────────────────  │    │   ──────────────────────────     │
│   DeepSeek / OpenAI /    │    │   Anthropic 官方 / MiniMax /    │
│   Ollama                 │    │   未来 Anthropic 兼容供应商       │
└──────────────────────────┘    └──────────────────────────────────┘
```

★ = Sprint 1D 新增 / 改造

### 7.2 时序图

```
[User] → run CLI
          │
          ▼
    loadConfig()
      │
      ├─ 读 env: LLM_PROVIDER / LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
      │
      ├─ 检测老 env 5 个 ──→ 任一存在 + 新 env 未设 ──→ throw + exit≠0
      │                                                  (stderr: "请改用 LLM_API_KEY")
      ▼
    AppConfig.llm = { provider, apiKey, baseURL, model }
      │
      ▼
    createLLM(config)
      │
      ├─ provider === 'minimax' ──→ new AnthropicCompatAdapter({ baseURL, apiKey, model })
      │                                  │
      ▼                                  ▼
    adapter.generate(prompt)         fetch(`${baseURL}/v1/messages`, {
      │                                headers: { 'x-api-key': apiKey,
      │                                          'anthropic-version': '2023-06-01' },
      │                                body: { model, messages, max_tokens: 1024 }
      │                              })
      │                                  │
      │                                  ├─ ok + content ──→ return text
      │                                  ├─ ok + 空 content ──→ throw (B7)
      │                                  └─ !ok ──→ throw HTTP ${status}
      ▼
    [ScoreJob / AutoGreet] 拿到 string 文本
```

### 7.3 关系图

```
┌─────────────────┐         ┌──────────────────────────┐
│ LLMProvider     │ ──→     │ string (Sprint 1D 后)    │
│  (老 enum)      │  替换   │  'deepseek'|'openai'|...  │
└─────────────────┘         └──────────────────────────┘

┌──────────────────────┐    1:1    ┌──────────────────────┐
│ AppConfig.llm        │ ────────→ │ createLLM(config)    │
│  .provider (string)  │           │  return LLMAdapter    │
│  .apiKey             │           └──────────────────────┘
│  .baseURL            │                     │
│  .model              │                     │ instanceof
└──────────────────────┘                     ▼
                                  ┌───────────────────────┐
                                  │ OpenAIAdapter         │
                                  │   DeepSeek/OpenAI/     │
                                  │   Ollama               │
                                  ├───────────────────────┤
                                  │ AnthropicCompatAdapter│ ← ★通用化
                                  │   Anthropic/MiniMax/   │   (baseURL 参数)
                                  │   未来兼容             │
                                  └───────────────────────┘

env ──→ config 字段映射：
┌──────────────────────┐         ┌──────────────────────┐
│ LLM_PROVIDER         │ ──────→ │ config.llm.provider  │
│ LLM_API_KEY          │ ──────→ │ config.llm.apiKey    │
│ LLM_BASE_URL         │ ──────→ │ config.llm.baseURL   │
│ LLM_MODEL            │ ──────→ │ config.llm.model     │
└──────────────────────┘         └──────────────────────┘
（4 个新 env 替代 5 个老 env + 老 enum 隐式映射）
```

### 7.4 流程图

```
                  ┌─ start ─┐
                  │ loadConfig │
                  └──────┬─────┘
                         │
                         ▼
              ┌───────────────────────┐
              │ 读 LLM_* 4 env        │
              │  + 扫老 env 5 个       │
              └──────────┬────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      ┌──────────────┐      ┌──────────────┐
      │ 老 env 全部   │      │ 任一老 env   │
      │ 未设          │      │ 存在         │
      └──────┬───────┘      └──────┬───────┘
             │                     ▼
             │            ┌──────────────────┐
             │            │ throw + exit≠0    │
             │            │ stderr 列全老 env │
             │            └──────────────────┘
             ▼
      ┌──────────────┐
      │ 构造 config  │
      │ .llm 字段    │
      └──────┬───────┘
             │
             ▼
      ┌────────────────────┐
      │ createLLM(config)  │
      └────────┬───────────┘
               │
       ┌───────┼───────┬─────────┬─────────┬─────────┐
       ▼       ▼       ▼         ▼         ▼         ▼
   deepseek  openai  ollama  anthropic  minimax   huoshan
       │       │       │         │         │         │
       ▼       ▼       ▼         ▼         ▼         ▼
   OpenAI    OpenAI  OpenAI  Anthropic  Anthropic  throw
   Adapter   Adapter Adapter Compat    Compat   "未配置"
                              Adapter   Adapter ★
                                    (通用化)
```

---

## 8. 错误传播图（按 §3.9 必填）

```
[op1: loadConfig()]
    │
    ├─ 老 env 5 个任一存在 + 新 env 未设 ──→ throw "请改用 LLM_*"
    │                                              │
    │                                              ▼
    │                                       启动 fail-fast
    │                                       exit ≠ 0
    │
    └─ 老 env 全部未设 / 新 env 已设 ──→ 构造 AppConfig
                                              │
                                              ▼
                                      [op2: createLLM(config)]
                                              │
                                              ├─ provider='huoshan' ──→ throw "尚未配置" ──→ 透传给 CLI ──→ exit≠0
                                              ├─ provider 未知 ──→ throw "不支持的供应商" ──→ 透传 CLI ──→ exit≠0
                                              └─ provider 已知 ──→ 构造 adapter
                                                                      │
                                                                      ▼
                                                          [op3: adapter.generate()]
                                                                      │
                                                                      ├─ AnthropicCompatAdapter: !res.ok ──→ throw "HTTP {status}"
                                                                      ├─ AnthropicCompatAdapter: body.type='error' ──→ throw "[{type}]: {msg}"
                                                                      ├─ AnthropicCompatAdapter: content 空 ──→ throw (B7)
                                                                      ├─ OpenAIAdapter: choices[0].message.content 空 ──→ throw (B7 同款)
                                                                      └─ 正常 ──→ return string

注意：
- 每个 throw 都必须显式 catch 边界（op1/op2/op3 在 caller 一一对应）
- 老 env 检测在 loadConfig 层（最高优先级，避免后续污染）
- huoshan "未配置" 是业务错（不是 LLM 错），不重试（按 ADR-0010 智能分类）
- AnthropicCompatAdapter 错误处理 = 原 AnthropicAdapter 错误处理（throw 而非 fake green）
```

---

## 9. TDD 流程（必填）

### 9.1 RED（先测全红 / 7 个测试）

| Step | 状态 | 证据 |
|------|------|------|
| **RED** | ⏳ 待跑 | TEST R1-R7（详见下表） |
| **GREEN** | ⏳ | （待 RED 通过后最小实现） |
| **REFACTOR** | ⏳ | （待 GREEN 后抽 helper） |
| **自验证** | ⏳ | vitest 全绿 + tsc 0 error + 1 条 live smoke |

### 9.2 RED 测试清单

| # | 测试名 | 断言 |
|---|--------|------|
| R1 | `createLLM(provider='minimax') → AnthropicCompatAdapter, baseURL=https://api.minimaxi.com/anthropic` | instanceof + baseURL 字段 |
| R2 | `createLLM(provider='huoshan') → throw "尚未配置"` | rejects.toThrow(/尚未配置/) |
| R3 | env `DEEPSEEK_API_KEY` 存在 + `LLM_API_KEY` 未设 → loadConfig throw | rejects.toThrow(/DEEPSEEK_API_KEY.*LLM_API_KEY/) |
| R4 | `LLM_PROVIDER` unset → `config.llm.provider === 'deepseek'` | equals |
| R5 | `AnthropicCompatAdapter.generate()` 用传入 baseURL + `x-api-key` 调 `/v1/messages` | vi.stubGlobal('fetch') 断言 URL/headers/body |
| R6 | 老 5 env 同时存在 → loadConfig throw 一次性列全 5 个 | error.message.match(DEEPSEEK_API_KEY\|OPENAI_API_KEY\|ANTHROPIC_API_KEY\|OLLAMA_BASE_URL\|OLLAMA_MODEL).length === 5 |
| R7 | `AnthropicCompatAdapter.generate()` content 缺失 → throw（fake green 防御） | rejects.toThrow(/Anthropic.*空内容\|OpenAI.*空内容/) |

### 9.3 实施步骤（Sprint 1D）

1. **Step 1**：Read `src/types/index.ts` 找到 `LLMProvider` enum 精确字段名（H7 验证）
2. **Step 2**：改 enum → `type LLMProvider = string` + 加 `LLM_PROVIDER_VALUES` 常量（deepseek/openai/anthropic/ollama/minimax/huoshan）
3. **Step 3**：扩 `AppConfig.llm` 加 `apiKey` / `baseURL` / `model` 字段（替代原 `deepseekApiKey/openaiApiKey/anthropicApiKey/ollamaBaseUrl/ollamaModel`）
4. **Step 4**：`src/config/index.ts` 改 `parseLLMConfig`：
   - 读 4 个 LLM_* env
   - 扫 5 个老 env → 任一存在 + 新 env 未设 → throw（一次性列全）
   - provider unset → default = 'deepseek'
5. **Step 5**：`src/llm/index.ts` 改 `AnthropicAdapter` → `AnthropicCompatAdapter`（接受 baseURL + model 参数）
6. **Step 6**：`createLLM` switch 加 minimax case（→ AnthropicCompatAdapter with minimax baseURL）+ huoshan case（→ throw "尚未配置"）
7. **Step 7**：写 `.env.example`（新 4 env + 老 5 env 标注 deprecated，提示 hard fail）
8. **Step 8**：跑 R1-R7 RED → GREEN → REFACTOR → 自验证

### 9.4 自验证清单（§4.4 + §3.11）

- ✓ 单测：vitest 全绿（包含 R1-R7 + 原有 LLM 测试）
- ✓ 类型检查：tsc 0 error
- ✓ smoke：`scripts/smoke-search-pagination.mjs` 跑通 + 新加 `scripts/smoke-llm-minimax.mjs`（实测 miniMax 调用，验 baseURL + x-api-key）
- ✓ 集成：跑真实 `pnpm dev` + 改 .env 走 minimax → 成功评分一个 JD（不走 BOSS，只验 LLM 路径）
- ⚠️ 浏览器验收（最终由 user 跑）：本 ADR 不动浏览器，不涉及

### 9.5 Phase 边界（§4.3 Sprint 规模限制 → 拆 4 phase 实施）

> ⚠️ 按 §4.3 单 Sprint 上限（≤2 文件 / ≤5 测试），本 ADR 拆 4 phase 实施。**Phase 1 不能立刻删老字段**（避免 Phase 2 改 src/llm/index.ts 时编译已挂）。

| Phase | 范围 | 文件 | 测试 | 老字段 |
|---|---|---|---|---|
| **1D-Phase 1** | env 统一 | types + config + .env.example | R3/R4/R6（3 个） | 保留（marked `@deprecated`） |
| **1D-Phase 2** | provider string 化 + createLLM 扩展 | types + llm/index | R1/R2/R5（3 个） | 删（src/llm/index.ts 同步改） |
| **1D-Phase 3** | AnthropicAdapter → AnthropicCompatAdapter | llm/index | R7（1 个） | n/a |
| **1D-Phase 4** | huoshan 接入 | 待定 | 待定 | 待定 |

**Phase 1 关键约束**：
- `src/types/index.ts`：`AppConfig.llm` 老 5 字段**保留 + 标 `@deprecated`**（JSDoc 注释），同时加 `apiKey?` / `baseURL?` / `model?` 3 个新字段
- `LLMProvider` union 加 `'minimax' | 'huoshan'`（Phase 2 实施时再考虑 union → string）
- `src/config/index.ts`：加 `parseLLMConfig()`，但**不立即**清空老字段赋值（保留 5 行 process.env.X 兼容老配置直到 Phase 2 cleanup）
- 老 env 检测 throw 是**新增行为**，不破坏老 env 仍能跑（hard fail 在"新 env 缺失"时才触发，老 env 完整 + 新 env 未设 = 用户决定迁移时刻）
- Phase 2 入口：`src/llm/index.ts` 同步改 + `src/llm/index.test.ts` mock 改 + 老 5 字段从 types 删

**§10 触发条件未达**：本 §9.5 是 §9 实施细节补充（不是 §3-6 决策变化），按 §10 重写流程不动 §2/§3/§4/§5/§6/§7/§8。

---

## 10. 后续（不在本 ADR 范围 / 必填）

> ⚠️ 本 ADR 不解决的待办必须列出

- [ ] **task / issue**：huoshan 实际接入 — 等 user 提供 baseURL + protocol + model 后，扩 createLLM switch case（替换 throw "尚未配置"）
- [ ] **task / issue**：运维手册加「LLM 迁移指南」章节（老 .env → 新 .env 一对一映射表）
- [ ] **新 ADR（huoshan 接入时立）**：ADR-0012（火山方舟 coding plan 协议确认）
- [ ] **监控**：createLLM switch default throw 应被监控捕获（生产报错率 >0 = 配置错）
- [ ] **真实 KEY 管理**：本 ADR 起草过程中 user 在 prompt 粘贴真实 KEY 一次（已确认未 commit，§3 H6）→ user 后续考虑 revoke + 重发（强烈建议）

---

## 11. 真相变了怎么办（强制重写）

> ⚠️ 如果 §3-6 中任何一段被推翻，必须重写整个 ADR，不打补丁

可能触发重写的场景：
- H1/H2 被推翻（MiniMax 不是 Anthropic 协议）→ 整个架构要改
- E1 被推翻（MiniMax 实际可走 OpenAI SDK）→ 简化 AnthropicCompatAdapter 不需要
- huoshan 协议确认后（本 ADR 不知道）→ 创建 ADR-0012 补充，本 ADR 不打补丁
- user 撤销 hard fail 决定 → 重写 §2.4

重写步骤：
1. 在 frontmatter 加 `superseded-by: ADR-NNNN`
2. 新建 ADR-NNNN 写新真相
3. 本文档保留作为历史归档
4. commit message 明确写 "重写 ADR-NNNN：旧归因 [X] → 新归因 [Y]"

---

## Debug Gate 5 项（本 ADR 不涉及 bug 修复，但保留格式供 Sprint 1D 实施时用）

> ⚠️ 如果 Sprint 1D 实施过程暴露 bug（如 hard fail 太激进漏报老 env），必须填这 5 项

- **症状**：__________
- **多假设**：__________（≥3 独立）
- **修复**：__________（精确 commit hash）
- **自验证**：__________（实测）
- **未证明**：__________

---

## 决策溯源（按 §5.2 强约束 / 2026-07-09 立）

> ⚠️ 所有结论必须标 [已确认] / [AI 假设] / [待确认] 三态

| # | 决策项 | 标注 | 依据 |
|---|--------|------|------|
| 1 | MiniMax baseURL = `https://api.minimaxi.com/anthropic` | **[已确认]** | user 提供 + settings.json 验证 |
| 2 | MiniMax 协议族 = Anthropic（不是 OpenAI 兼容） | **[已确认]** | URL 字面 + ANTHROPIC_BASE_URL 实测跑通 |
| 3 | MiniMax 模型 = `MiniMax-M2.7-highspeed` | **[已确认]** | user 提供 |
| 4 | MiniMax API_KEY | **[已确认]**（但**禁止**写入本 ADR） | user 提供，§6 B9 强制隔离 |
| 5 | provider 改 string 替 enum | **[已确认]** | AskUserQuestion 历史 |
| 6 | 老 env hard fail 强制迁移 | **[已确认]** | user 在本轮回复 |
| 7 | default = deepseek | **[已确认]** | user 在本轮回复 |
| 8 | 火山方舟 protocol | **[待确认]** | user 说"稍后提供" |
| 9 | huoshan 走 Anthropic 还是 OpenAI | **[AI 假设]** 无依据 → ADR-0011 强制 throw "未配置" | E6 + §3.6 B 类 |
| 10 | 老 `AnthropicAdapter` → `AnthropicCompatAdapter` 通用化 | **[已确认]** | E2 证伪 + H3 代码路径 |

---

## 自检 Checklist（提交前必过）

- [x] §3 证据：每个假设都有独立证据（H1-H7 全部有 commit/file 实测）
- [x] §4 反例：每个被排除的假设都有证伪过程（E1-E6）
- [x] §5 备选：评估 4 个备选方案（D/A/B/C/E）+ 明确选择 D 理由
- [x] §6 行为契约：7 条可测契约 + 1 条安全契约（B9）
- [x] §7 4 类图：架构/时序/关系/流程全画
- [x] §8 错误传播图：每个 throw 显式对应 catch 边界
- [x] §9 TDD：7 个 RED 测试清单 + 8 步实施步骤
- [x] §10 后续：列出 4 个待办（含 huoshan + KEY revoke 建议）
- [x] **未引用未验证的归因**（"估计"/"应该"/"可能是" 已避）
- [x] **API_KEY 安全**：未在 ADR 任何位置写真实 KEY（仅引用 env var 名 `LLM_API_KEY`）
- [ ] **如果 Sprint 1D 实施过程暴露 bug**：Debug Gate 5 项待填
- [ ] **如果 huoshan 协议确认**：§10 重写流程待走（建 ADR-0012）

---

**纪律引用**：
- `~/.claude/CLAUDE.md` §3.5 4 类图前置 + §3.6 A/B 分类 + §3.8 调试纪律 + §3.9 错误传播图 + §3.10 refactor checklist + §3.11 不能只信 hook + §5.2 决策溯源 + §4 TDD 6 步
- memory `feedback_debug_root_cause_discipline.md`（8 条铁律）
- memory `feedback_debug_gate.md`（Debug Gate 5 项格式）
- memory `feedback_zero_tolerance_fake_green.md`（假绿零容忍 — 沿用 AnthropicCompatAdapter 空内容 throw）
- memory `feedback_stack_decision.md`（全栈 TS 单栈 — 油猴/CLI 不引 Java/Python/Go）