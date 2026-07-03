# Environment Variables 文档

> **本文件是 boss-apply 环境变量的权威单文档**。
> 与 `.env.example` 的关系：本文件说明每个变量的语义、`(.env)` 文件是"实际填值"的运行时载体。
> 任何新增 / 删除 / 默认值变更，必须先改本文件并跑 `npm test`。

---

## 1. 核心业务凭证（必填：FEISHU）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `FEISHU_APP_ID` | ✓ | — | 在 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用后获取 |
| `FEISHU_APP_SECRET` | ✓ | — | 同上 |

**缺失行为**：`bapply init` 会明确报错并指向本文件。

---

## 2. LLM 供应商（按需填一个）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `LLM_PROVIDER` | ⨁ | `deepseek` | 取值：`deepseek` / `openai` / `anthropic` / `ollama` |
| `DEEPSEEK_API_KEY` | 视 provider | — | DeepSeek API Key（推荐，国内直连快） |
| `OPENAI_API_KEY` | 视 provider | — | OpenAI API Key |
| `ANTHROPIC_API_KEY` | 视 provider | — | Anthropic Claude API Key |
| `OLLAMA_BASE_URL` | 视 provider | `http://localhost:11434` | Ollama 本地服务地址 |
| `OLLAMA_MODEL` | 视 provider | `llama3` | Ollama 模型名 |

**provider 与 key 的强制关系**：
- `deepseek` → 必须有 `DEEPSEEK_API_KEY`
- `openai` → 必须有 `OPENAI_API_KEY`
- `anthropic` → 必须有 `ANTHROPIC_API_KEY`
- `ollama` → 启动本地服务即可，不需要 key

---

## 3. 简历信息

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `BOSS_RESUME_UID` | ⨁ | — | BOSS 直聘在线简历 UID（在简历页 URL 中可找到）。仅在某些简历抓取场景需要。 |

---

## 4. CDP 接管配置（推荐主路径：接管用户本地 Chrome） 🆕

> **为什么这一节单独存在**：CDP 接管（`chromium.connectOverCDP`）是项目反爬转向的核心（见 [§5.2 调研报告](research/boss-auto-apply-2026-06-research.md)），它的两个开关与环境变量绑定关系最复杂，必须有专属文档。

### 4.1 `BOSS_CDP_PORT`

| 属性 | 值 |
|------|-----|
| **作用** | Chrome `--remote-debugging-port` 的端口 |
| **类型** | 正整数 1-65535 |
| **默认值** | `9222`（Chrome 官方默认） |
| **优先级** | CLI `-p <port>` > 本环境变量 > 默认 9222 |
| **使用方** | `src/browser/cdp.ts` 的 `resolvePort()` |

**何时修改？**
- 端口 9222 被其他程序占用（如调试工具残留进程）
- 想跑多个 Chrome 实例做对比测试（9223 / 9224 ...）

**示例**：
```bash
BOSS_CDP_PORT=9333
```

### 4.2 `BOSS_CHROME_PATH`  🆕

| 属性 | 值 |
|------|-----|
| **作用** | Chrome 可执行文件的绝对路径，**覆盖平台推断值** |
| **类型** | 字符串路径（绝对路径） |
| **默认值** | 平台推断：<br>• macOS   → `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`<br>• Windows → `C:\Program Files\Google\Chrome\Application\chrome.exe`<br>• Linux   → `google-chrome` |
| **优先级** | 本环境变量（非空时）> 平台推断 |
| **使用方** | `src/browser/cdp.ts` 的 `detectChromePath()`（已导出供测试） |

**何时修改？**
- 本机装了 Stable + Beta + Dev 多个版本并存，需要指定某个版本
- Chrome 安装在非默认路径（如 `~/Applications/Google Chrome.app`）
- 用 Chromium / Brave / Edge 等替代 Chrome（理论上可用但未实测）

**示例**（macOS 自定义路径）：
```bash
BOSS_CHROME_PATH=/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta
```

**空值与边界**：
- 留空 → 走平台推断
- 设成 `""`（空字符串） → 视为未设置，走平台推断（避免空字符串误覆盖）

**安全提示**：此变量值会被拼进 `bapply chrome` 输出的命令。如果你修改此变量后启动报错 `ENOENT`，请检查路径是否含空格或需要 escape。

---

## 5. 浏览器配置（Fallback 启动模式）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `CHROMIUM_PATH` | ⨁ | Playwright 内置 Chromium | **仅 fallback 启动模式**用，CDP 接管模式不读 |

**什么时候用？**
- 完全不想用 CDP 接管（比如担心 `connectOverCDP` 副作用）
- 想跑 Chromium 而不是 Chrome（指纹差异）

---

## 6. 完整优先级链

```
CLI 参数 (-p <port>)
   ↓
进程环境变量 (BOSS_CDP_PORT / BOSS_CHROME_PATH)
   ↓
内置默认 (9222 / 平台推断 Chrome 路径)
```

**冲突解决**：
- CLI 必胜
- 环境变量必胜于默认
- 默认必胜于"未设置"

---

## 7. 快速对照表（README §"配置说明" 的权威源）

| 环境变量 | 必填？ | 默认 | 引用本文件 |
|---------|--------|------|-----------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | ✓ | — | [§1](#1-核心业务凭证必填feishu) |
| `LLM_PROVIDER` | ⨁ | `deepseek` | [§2](#2-llm-供应商按需填一个) |
| `BOSS_RESUME_UID` | ⨁ | — | [§3](#3-简历信息) |
| `BOSS_CDP_PORT` | ⨁ | `9222` | [§4.1](#41-boss_cdp_port) |
| `BOSS_CHROME_PATH` | ⨁ | 平台推断 | [§4.2](#42-boss_chrome_path-) |
| `CHROMIUM_PATH` | ⨁ | Playwright 内置 | [§5](#5-浏览器配置fallback-启动模式) |

---

## 8. 修改本文件的 checklist

- [ ] 先搜索代码引用：`grep -r "BOSS_CDP_PORT\|BOSS_CHROME_PATH" src/`
- [ ] 更新 `src/config/index.ts` 或对应模块
- [ ] 更新 `.env.example`（如果空间允许）
- [ ] 更新 README.md §"配置说明" 表格
- [ ] 更新本文件 §7 对照表
- [ ] 跑 `npm test` 确保契约测试还绿

---

> 📌 **设计动机**：把 `.env.example` 当成"示例 / 模板"，把本文件当成"权威文档"，避免单一文件既承担"机器可读的契约"又承担"人易读的说明"的双重职责。
