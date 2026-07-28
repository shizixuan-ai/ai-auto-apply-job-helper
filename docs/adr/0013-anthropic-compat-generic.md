# ADR-0013: anthropic-compat 通用 provider + LLM_AUTH_STYLE env

> **状态**：已实施（2026-07-21）
> **作者**：AI + user（2026-07-21）
> **日期**：2026-07-21
> **关联**：ADR-0011（多供应商）/ ADR-0012（huoshan 接入 + minimax Bearer 修复）/ deepseek live 诊断（本次需求源头）
> **纪律**：§3.5 4 类图 + §3.6 A/B 分类 + §3.9 错误传播图 + §3.10 refactor checklist + §3.11 不能只信 hook + §4 TDD + §5.2 溯源
>
> **前置真相变更**：live 诊断发现 deepseek v4-flash 走 Anthropic 协议端点（`https://api.deepseek.com/anthropic`），但 createLLM 里 deepseek 硬编码走 OpenAIAdapter → 404。**deepseek 实际是 Anthropic 兼容供应商**，而当前 6 个 provider 名里没有"通用 Anthropic 兼容"位 —— minimax/huoshan 是两个独立 case，**未来加任何"走 Anthropic 协议的国内 LLM" 都要新加 case + 硬编码 baseURL/model**。本 ADR 显式补这个缺口。

---

## 1. 背景与目标

ADR-0012 接入 huoshan 时，ADR-0011 §10 留了"未来兼容供应商"由 createLLM switch case 传入 —— 但**没说"未来兼容"本身要有一个通用 provider**。本 ADR 补这个洞：

**问题**：
- 任何走 Anthropic Messages API + 任意 baseURL/任意 authStyle 的供应商，目前必须新加 switch case + 硬编码默认 baseURL/model。
- deepseek v4-flash 走 `https://api.deepseek.com/anthropic` + `x-api-key`（实测）—— 既不是 minimax 也不是 huoshan，但走的是同一协议族。
- 不想要"provider=deepseek 走 OpenAIAdapter"这个语义错配（baseURL 含 `/anthropic` 段），也不想加 `provider='deepseek-anthropic'` 这种 case-by-case 的死法。
- 同时 `authStyle`（x-api-key vs Bearer）当前**写死在各 case**里（minimax/huoshan 硬编 'bearer'，anthropic 硬编 'x-api-key'）—— 通用 provider 应该让 env 决定。

**目标**：
- 新增 `provider='anthropic-compat'` 通用 provider：**baseURL / model / authStyle 全部从 env 读，无硬编码默认**
- 新增 env `LLM_AUTH_STYLE ∈ {'x-api-key', 'bearer'}`，unset → 默认 `'bearer'`（多数国产 Anthropic 兼容是 Bearer）
- `anthropic-compat` 的 `baseURL/model` **不设默认** → 没设就 fail-fast 报错（避免假装"自动选 endpoint"的暗箱）
- 不破坏现有 6 个 provider 的行为（回归测试覆盖）
- 未来加任何"Anthropic 兼容 + 自定义 endpoint"的供应商（智谱 GLM API / 通义千问 Anthropic 兼容 / ...）→ **零代码改动，只改 .env**

---

## 2. 决策（Decision）

### 2.1 新增 `LLM_PROVIDER_VALUES.ANTHROPIC_COMPAT = 'anthropic-compat'`

types 注释说明语义（**全 env 驱动**）：
```
- anthropic-compat: 通用 Anthropic 协议供应商，所有字段从 env 读
                    必须设 LLM_BASE_URL / LLM_MODEL / LLM_AUTH_STYLE(可选,默认 bearer)
                    适配场景: deepseek v4 / 智谱 GLM API / 通义千问 Anthropic 兼容 / 任何 /v1/messages 端点
```

### 2.2 新增 env `LLM_AUTH_STYLE`

| env | 含义 | 默认 | 适用范围 |
|---|---|---|---|
| `LLM_AUTH_STYLE` | Anthropic 协议鉴权 header 风格 | unset → `'bearer'` | **仅 `anthropic-compat` 生效**（其他 provider 自己硬编） |

值校验：`'x-api-key' \| 'bearer'` 之外 → throw（fail-fast，避免拼错静默用错 header）。

### 2.3 `anthropic-compat` createLLM case

```ts
case 'anthropic-compat': {
  if (!apiKey) throw new Error('LLM 供应商 anthropic-compat 必填 LLM_API_KEY（详见 ADR-0013 §2.3）')
  if (!baseURL) throw new Error('LLM 供应商 anthropic-compat 必填 LLM_BASE_URL（通用 provider 无默认 endpoint，详见 ADR-0013 §2.3）')
  if (!model)   throw new Error('LLM 供应商 anthropic-compat 必填 LLM_MODEL（通用 provider 无默认 model，详见 ADR-0013 §2.3）')
  return new AnthropicCompatAdapter({ apiKey, baseURL, model, authStyle: ... })
}
```

`authStyle` 从 `config.llm.authStyle` 读，**不读 env 直接**（保持 env 解析在 config 层）—— 见 §8 错误传播图。

### 2.4 `AppConfig.llm` 加 `authStyle?: 'x-api-key' | 'bearer'`

types 扩展：跟现有 `apiKey?` / `baseURL?` / `model?` 同形态。
`config/index.ts parseLLMConfig` 读 `process.env.LLM_AUTH_STYLE`，校验后塞 `config.llm.authStyle`。

### 2.5 不动现有 6 个 provider

- `anthropic`：继续硬编 `x-api-key` + 硬编 `https://api.anthropic.com` 默认 + 硬编 `claude-sonnet-4-*` 默认 → **不受新 env 影响**（语义清晰："Anthropic 官方"）
- `minimax` / `huoshan`：继续硬编 `bearer` + 各自默认 baseURL/model → **不受新 env 影响**（这些是有强默认的命名供应商）
- `deepseek` / `openai` / `ollama`：走 OpenAIAdapter，跟 `LLM_AUTH_STYLE` 无关

**`anthropic-compat` 是新增第三种"Anthropic 协议"分支**,不是替换任何 case。

---

## 3. 证据

| # | 假设 | 证据 | 验证方式 |
|---|------|------|---------|
| H1 | deepseek 提供 Anthropic 协议端点 `https://api.deepseek.com/anthropic` | `https://api-docs.deepseek.com/zh-cn/` 文档列"OpenAI SDK: `api.deepseek.com` / Anthropic SDK: `api.deepseek.com/anthropic`" | WebFetch 实测 |
| H2 | deepseek `v4-flash` 接受 `x-api-key`（非 Bearer） | 直接 fetch `https://api.deepseek.com/anthropic/v1/messages` 带 `x-api-key` header → HTTP 200 返回 `model:"deepseek-v4-flash"` | 实测（2026-07-21 raw fetch） |
| H3 | deepseek `v4-flash` 也接受 OpenAI 协议（`/v1/chat/completions`） | raw fetch `https://api.deepseek.com/v1/chat/completions` 带 `Authorization: Bearer` → HTTP 200 | 实测 |
| H4 | deepseek `v4-flash` 返回的 content 块**没有 thinking 字段**（不像 glm-5.2） | 实测 deepseek live 返回 `"content":[{"type":"text","text":"DeepSeek在线..."}]`，首块直接是 text | live smoke `69b5e85` 后的复跑 |
| H5 | `LLM_AUTH_STYLE` env 当前未定义 | grep `src/config/index.ts` 全文无 LLM_AUTH_STYLE | Read 文件 |
| H6 | `createLLM` deepseek 硬编码 OpenAIAdapter | `src/llm/index.ts:20-25` `case 'deepseek': return new OpenAIAdapter({...})` | Read 文件 |
| H7 | createLLM 没有 `anthropic-compat` case | `src/llm/index.ts` switch 6 个 case 无 `anthropic-compat` | Read 文件 |

---

## 4. 反例

| # | 排除假设 | 证伪原因 | 证伪方式 |
|---|---------|---------|---------|
| E1 | "deepseek 该走 OpenAI 协议，改回 `baseURL=https://api.deepseek.com` 即可" | 你 .env 显式配 `LLM_BASE_URL=https://api.deepseek.com/anthropic`（走 Anthropic 协议），user 主动选择，且 thinking 块对推理模型更可控 | H1 + H2 + 你 .env 实测 |
| E2 | "加 `provider='deepseek-anthropic'` case 即可（仿 minimax/huoshan）" | 治标 —— 智谱 GLM / 通义千问 / ... 都要新加 case，违反 ADR-0011 "未来加供应商 0 改动 enum" 的精神 | 设计取舍，参考 §5 备选 B |
| E3 | "`LLM_AUTH_STYLE` 默认 = x-api-key" | 国产 Anthropic 兼容（minimax/huoshan）都用 Bearer；deepseek 用 x-api-key 是少数派。**默认 bearer 更符合"用户主动选 anthropic-compat 就是想用第三方"的心智** | H2 + minimax/huoshan 现状 |
| E4 | "`anthropic-compat` 给 baseURL/model 设默认（兜底）" | 通用 provider 假装"自动选 endpoint"是暗箱，违反 §3.11 不能只信 hook 精神。fail-fast 让用户显式选 | §3.11 |
| E5 | "现有 `authStyle` 参数（ADR-0012）不扩展，所有 provider 共用 `LLM_AUTH_STYLE`" | 现有 6 个 provider 的 `authStyle` 是**硬编码语义事实**（anthropic 官方就是 x-api-key，minimax/huoshan 就是 Bearer），让 env 覆盖会导致"以为改了实际是默认"的语义污染 | ADR-0012 §2.2 + E1 精神 |

---

## 5. 备选方案

| 方案 | 优点 | 缺点 | 评估 |
|------|------|------|------|
| **本方案**（anthropic-compat + LLM_AUTH_STYLE env 驱动） | 未来加供应商零代码 / baseURL/model/authStyle 全部 env 显式 / fail-fast / 现有 6 provider 不动 | 多 1 个 env / 改 ~4 文件 | ✓ |
| A. 改 .env 配 `provider=anthropic` + 复用 deepseek baseURL | 零代码 | "anthropic" 实际是 deepseek，语义错配；未来加供应商还是要 case | ✗ 不可扩展 |
| B. 加 `provider='deepseek-anthropic'` 单独 case | 语义最准 | 治标，每个"走 Anthropic 协议的国内 LLM" 都要新 case | ✗ §3.3 耦合爆炸精神 |
| C. 现有 6 provider 都加 LLM_AUTH_STYLE env 覆盖 | 统一 | E5 语义污染，破坏"官方供应商 = 固定 authStyle"的隐式契约 | ✗ E5 |
| D. 改 `parseLLMConfig` 让 anthropic-compat 用默认 endpoint（智能猜测） | user 不用填 | 暗箱；猜错 = 静默调错供应商；违反 §3.11 | ✗ |

---

## 6. 行为契约（可测）

- ✓ **B1**：`createLLM(provider='anthropic-compat', apiKey=sk-x, baseURL=URL, model=M)` → AnthropicCompatAdapter，baseURL/model **透传 env**，无任何默认填充 — TEST R11
- ✓ **B2**：`createLLM(provider='anthropic-compat')` 缺 apiKey/baseURL/model 任一 → throw（fail-fast 列举缺失项）— TEST R12
- ✓ **B3**：`createLLM(provider='anthropic-compat', authStyle='bearer')` → `Authorization: Bearer` header,**无** `x-api-key` — TEST R13
- ✓ **B4**：`createLLM(provider='anthropic-compat', authStyle='x-api-key')` → `x-api-key` header,**无** `Authorization` — TEST R13
- ✓ **B5**：`loadConfig()` 读 `LLM_AUTH_STYLE='bearer'` → `config.llm.authStyle === 'bearer'` — TEST R14
- ✓ **B6**：`loadConfig()` 读 `LLM_AUTH_STYLE='bearer-x'`（非合法值）→ throw "LLM_AUTH_STYLE 仅支持 'x-api-key' | 'bearer'" — TEST R15
- ✓ **B7**：`loadConfig()` 读 `LLM_AUTH_STYLE` unset → `config.llm.authStyle === 'bearer'`（默认） — TEST R16
- ✓ **B8（回归）**：现有 6 provider 行为不变（`anthropic` 仍走 x-api-key，`minimax`/`huoshan` 仍走 Bearer） — 现有 R1/R5/R8 全保持
- ✗ **B9（不在本 ADR）**：deepseek-v4-flash 实际跑通 live = §10 待办（这次是 inline 跑过，本 ADR 实施时复跑）

---

## 7. 4 类图

### 7.1 架构图（增量）

```
┌─────────────────────────────────────────────────────────────────┐
│ src/llm/index.ts createLLM(config)                              │
│   switch (provider)                                              │
│     ├─ 'deepseek' / 'openai' / 'ollama' ──→ OpenAIAdapter       │
│     ├─ 'anthropic'              ──→ AnthropicCompatAdapter      │
│     │                                  authStyle='x-api-key'     │
│     ├─ 'minimax' / 'huoshan'    ──→ AnthropicCompatAdapter      │
│     │                                  authStyle='bearer' (硬编)│
│     ├─ 'anthropic-compat' ★NEW  ──→ AnthropicCompatAdapter      │
│     │                                  authStyle=config.llm.authStyle│
│     │                                  (env 驱动,bearer 默认)    │
│     └─ default                  ──→ throw "不支持的供应商"       │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ from
┌─────────────────────────────────────────────────────────────────┐
│ src/config/index.ts parseLLMConfig()                              │
│   provider:  process.env.LLM_PROVIDER ?? 'deepseek'              │
│   apiKey:    process.env.LLM_API_KEY                              │
│   baseURL:   process.env.LLM_BASE_URL                            │
│   model:     process.env.LLM_MODEL                               │
│   authStyle: process.env.LLM_AUTH_STYLE                           │
│              ∈ {'x-api-key','bearer'}                            │
│              unset → 'bearer'                                    │
│              其他值 → throw                                       │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 时序图（anthropic-compat 路径）

```
[User] run CLI
  │
  ▼
loadConfig()
  │ 读 env: LLM_PROVIDER='anthropic-compat' + LLM_BASE_URL + LLM_MODEL + LLM_API_KEY + LLM_AUTH_STYLE
  │
  ├─ 任一老 env 5 个存在 + 新 env 未设 ──→ throw (ADR-0011 §2.4 行为不变)
  │
  ├─ LLM_AUTH_STYLE unset → 'bearer'    ┐
  ├─ LLM_AUTH_STYLE='x-api-key'         │ → config.llm.authStyle
  ├─ LLM_AUTH_STYLE='bearer'            │
  └─ LLM_AUTH_STYLE=其他 → throw        ┘
  │
  ▼
AppConfig.llm = { provider, apiKey, baseURL, model, authStyle }
  │
  ▼
createLLM(config)
  │
  ├─ provider='anthropic-compat'
  │   ├─ apiKey/baseURL/model 任一空 → throw "anthropic-compat 必填 LLM_*"
  │   └─ 全齐 → new AnthropicCompatAdapter({ apiKey, baseURL, model, authStyle: config.llm.authStyle })
  │
  ▼
adapter.generate(prompt)
  │ fetch(`${baseURL}/v1/messages`, { headers: buildHeaders(), body })
  │   buildHeaders():
  │     - 'x-api-key': apiKey         (if authStyle='x-api-key')
  │     - 'Authorization': 'Bearer '+apiKey  (if authStyle='bearer')
  │     + 'anthropic-version': '2023-06-01'  (恒发)
  │ + 'Content-Type': 'application/json'      (恒发)
  │
  ├─ !res.ok ──→ throw "HTTP {status}"
  ├─ body.type='error' ──→ throw "[{type}]: {msg}"
  ├─ 空 content(text 块拼接后) ──→ throw (B12 复用 ADR-0012 R10 修复)
  └─ 正常 ──→ return text
```

### 7.3 关系图

```
┌──────────────────────────┐    1:1    ┌──────────────────────┐
│ AppConfig.llm (Sprint 1D)│ ────────→ │ createLLM(config)    │
│  .provider (string)      │           │  return LLMAdapter    │
│  .apiKey                 │           └──────────────────────┘
│  .baseURL                          │
│  .model                            │ instanceof
│  .authStyle ★NEW (ADR-0013)        ▼
└──────────────────────────┘                  ┌───────────────────────┐
                                              │ OpenAIAdapter         │
┌──────────────────────────┐                  │   DeepSeek/OpenAI/     │
│ env → config 字段映射     │                  │   Ollama               │
│ ─────────────────────     │                  ├───────────────────────┤
│ LLM_PROVIDER → provider  │                  │ AnthropicCompatAdapter│
│ LLM_API_KEY  → apiKey    │                  │   ─────────────────   │
│ LLM_BASE_URL → baseURL   │                  │   anthropic:          │
│ LLM_MODEL    → model     │                  │     硬编 x-api-key     │
│ LLM_AUTH_STYLE →         │                  │   minimax/huoshan:    │
│   authStyle ★NEW         │                  │     硬编 bearer        │
│   unset → 'bearer'       │                  │   anthropic-compat:   │
│   其他值 → throw         │                  │     config 传入 ★NEW  │
└──────────────────────────┘                  └───────────────────────┘
```

### 7.4 流程图

```
                  ┌─ start ─┐
                  │ loadConfig │
                  └──────┬─────┘
                         │
                         ▼
              ┌───────────────────────┐
              │ 读 LLM_* 5 env         │ ← 4 老 → 5 新(+LLM_AUTH_STYLE)
              │  + 扫老 env 5 个        │
              └──────────┬────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      ┌──────────────┐      ┌──────────────┐
      │ 老 env 全部   │      │ 任一老 env   │
      │ 未设          │      │ 存在 + 新未设│
      └──────┬───────┘      └──────┬───────┘
             │                     ▼
             │            ┌──────────────────┐
             │            │ throw (0011 §2.4)│
             │            └──────────────────┘
             ▼
      ┌──────────────────────┐
      │ 校验 LLM_AUTH_STYLE  │ ★NEW
      │ 合法 → 塞 config     │
      │ 非法 → throw         │
      └──────┬───────────────┘
             │
             ▼
      ┌────────────────────┐
      │ createLLM(config)  │
      └────────┬───────────┘
               │
       ┌───────┼───────┬─────────┬─────────┬─────────┬──────────┐
       ▼       ▼       ▼         ▼         ▼         ▼          ▼
   deepseek  openai  ollama  anthropic  minimax   huoshan  anthropic-compat
       │       │       │         │         │         │          │
       ▼       ▼       ▼         ▼         ▼         ▼          ▼
   OpenAI    OpenAI  OpenAI  Anthropic  Anthropic  Anthropic  Anthropic
   Adapter   Adapter Adapter Compat    Compat    Compat    Compat
                              Adapter   Adapter   Adapter   Adapter
                              (硬编)    (硬编)    (硬编)    (env 驱动)
                                                            baseURL/model
                                                            必填
                                                            authStyle='bearer' 默认
```

---

## 8. 错误传播图（§3.9）

```
[op1: loadConfig()]
    │
    ├─ 老 env 任一 + 新 env 未设 ──→ throw (ADR-0011 §2.4 行为)
    │
    ├─ LLM_AUTH_STYLE 非法值 ──→ throw "LLM_AUTH_STYLE 仅支持 'x-api-key' | 'bearer', got: X"
    │
    └─ 都合法 ──→ AppConfig.llm.authStyle 必有值
                                              │
                                              ▼
                                      [op2: createLLM(config)]
                                              │
                                              ├─ provider='anthropic-compat'
                                              │   ├─ apiKey 空 ──→ throw "anthropic-compat 必填 LLM_API_KEY"
                                              │   ├─ baseURL 空 ──→ throw "anthropic-compat 必填 LLM_BASE_URL"
                                              │   ├─ model 空 ──→ throw "anthropic-compat 必填 LLM_MODEL"
                                              │   └─ 全齐 ──→ new AnthropicCompatAdapter({...authStyle: config.llm.authStyle})
                                              │                     │
                                              │                     ▼
                                              │            [op3: adapter.generate()]
                                              │                     │
                                              │                     ├─ HTTP !ok ──→ throw (沿用 ADR-0011 §8)
                                              │                     ├─ body.type='error' ──→ throw (沿用)
                                              │                     ├─ 空 content ──→ throw (沿用 ADR-0012 R10 修复)
                                              │                     └─ ok ──→ return text
                                              │
                                              ├─ provider='huoshan'/'minimax'/'anthropic' ──→ 各自行为(回归测试覆盖)
                                              ├─ provider 未知 ──→ throw (沿用 ADR-0011 §8)
                                              └─ provider='deepseek'/'openai'/'ollama' ──→ OpenAIAdapter(不读 authStyle)

注意：
- 每个 throw 都显式 catch 边界
- LLM_AUTH_STYLE 校验在 loadConfig 层(最高优先级,避免后续污染)
- anthropic-compat fail-fast 在 createLLM(配错立刻炸,不静默用默认)
- error 边界对 OpenAIAdapter 透明(它不读 authStyle)
```

---

## 9. TDD 流程

| Step | 状态 | 证据 |
|------|------|------|
| RED | ⏳ | R11/R12/R13/R14/R15/R16（详见下表）|
| GREEN | ⏳ | （RED 全红后最小实现）|
| REFACTOR | ⏳ | （GREEN 后抽 helper）|
| 自验证 | ⏳ | vitest 全绿 + tsc 0 error + 1 条 live smoke（anthropic-compat 验 deepseek）+ 回归（huoshan/minimax/anthropic）|

### 9.1 RED 测试清单

| # | 测试 | 断言 |
|---|------|------|
| R11 | `createLLM(provider='anthropic-compat', apiKey, baseURL, model)` | 返回 AnthropicCompatAdapter，baseURL/model 透传（无默认） |
| R12 | `createLLM(provider='anthropic-compat')` 缺 apiKey | throws "anthropic-compat 必填 LLM_API_KEY" |
| R12 | `createLLM(provider='anthropic-compat')` 缺 baseURL | throws "anthropic-compat 必填 LLM_BASE_URL" |
| R12 | `createLLM(provider='anthropic-compat')` 缺 model | throws "anthropic-compat 必填 LLM_MODEL" |
| R13 | `createLLM(provider='anthropic-compat', authStyle='bearer')` | fetch header = `Authorization: Bearer key`，**无** `x-api-key` |
| R13 | `createLLM(provider='anthropic-compat', authStyle='x-api-key')` | fetch header = `x-api-key: key`，**无** `Authorization` |
| R14 | `loadConfig()` env `LLM_AUTH_STYLE='bearer'` | config.llm.authStyle === 'bearer' |
| R15 | `loadConfig()` env `LLM_AUTH_STYLE='garbage'` | throws /仅支持 'x-api-key' \| 'bearer'/ |
| R16 | `loadConfig()` env `LLM_AUTH_STYLE` unset | config.llm.authStyle === 'bearer'（默认） |
| 回归 | R1/R5/R5-supplement/R8 保持绿 | minimax→Bearer, huoshan→Bearer, anthropic→x-api-key 不变 |

### 9.2 实施步骤

1. **Step 1**：`src/types/index.ts` LLM_PROVIDER_VALUES 加 `ANTHROPIC_COMPAT` + 注释
2. **Step 2**：`src/types/index.ts` AppConfig.llm 加 `authStyle?: 'x-api-key' | 'bearer'`
3. **Step 3**：`src/config/index.ts` parseLLMConfig 读 `LLM_AUTH_STYLE` + 校验 + 默认
4. **Step 4**：`src/llm/index.ts` createLLM switch 加 `case 'anthropic-compat'` + fail-fast
5. **Step 5**：写 R11-R16 测试 → RED → GREEN → REFACTOR
6. **Step 6**：live smoke 跑 anthropic-compat 验 deepseek-v4-flash(改 .env 临时跑完恢复)
7. **Step 7**：回归 live 验 huoshan + minimax + anthropic 行为不变
8. **Step 8**：更新 ADR-0013 状态为"已实施" + 记录 commit hash

---

## 10. 后续

- [x] **live smoke**:用 anthropic-compat 验 deepseek-v4-flash → 1.4s 返回「在线，我是 DeepSeek。」(inline 跑,未改 .env)
- [ ] **.env.example 补 anthropic-compat 配置示例**(用户手动,我被权限守卫拦)
- [ ] **未来加供应商**:智谱 GLM API / 通义千问 Anthropic 兼容 / ... → 零代码,只改 .env
- [ ] **真实 KEY revoke**(沿用 ADR-0011 §10):草拟期 user 贴过 minimax key,建议 revoke

---

## Debug Gate 5 项（无 bug 修复,占位）

本 ADR 不涉及 bug 修复(新增功能,非修复)。如实施过程暴露 bug,按 §3.8 填 Debug Gate。

---

## 决策溯源（§5.2）

| # | 决策项 | 标注 | 依据 |
|---|--------|------|------|
| 1 | 新增 `provider='anthropic-compat'` | **[已确认]** | live 诊断 + user 选 C |
| 2 | baseURL/model 不设默认(fail-fast) | **[已确认]** | E4 §3.11 精神 |
| 3 | authStyle 默认 = 'bearer' | **[已确认]** | E3 多数国产兼容是 Bearer |
| 4 | LLM_AUTH_STYLE 非合法值 throw | **[已确认]** | 拼错静默用错 header = 危险 |
| 5 | 现有 6 provider 不受影响 | **[已确认]** | E5 语义污染 |
| 6 | deepseek-v4-flash 走 anthropic-compat | **[已确认]** | H1 + H2 live |
| 7 | deepseek-v4-flash 用 x-api-key(Bearer 也行但默认 bearer 会错) | **[已确认]** | H2 live 实测 |
| 8 | anthropic-compat live 跑通（deepseek-v4-flash） | **[已确认]** | smoke-llm.mjs inline 跑 anthropic-compat + x-api-key + deepseek-v4-flash → 1.4s 返回「在线，我是 DeepSeek。」 |
