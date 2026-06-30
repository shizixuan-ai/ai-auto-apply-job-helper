# 调研报告：BOSS 直聘自动投递工具（2026-06）

> **调研目标**：盘点 2026-06 市场上可对接 BOSS直聘的"岗位查找 / 匹配 / 投递 / 跟踪"工具与插件，给出本项目（`boss-apply` / `bapply`）的 **buy / hybrid / build** 决策建议。
>
> **调研日期**：2026-06-30  
> **调研人**：自动研究（agent-browser + WebFetch）  
> **上下文**：本项目已选定 Playwright + stealth + 飞书 + LLM 适配器 + Node/TS CLI 架构，PRD 已定稿（`docs/prd.md`）

---

## 一、关键词矩阵（research-first Step 1）

| 角度 | 关键词 |
|---|---|
| **Problem** | boss直聘 自动投递 / 自动打招呼 / 海投 / AI 求职 / 招聘平台 RPA |
| **Stack** | Playwright、puppeteer-extra-stealth、Node.js、TypeScript、LLM（DeepSeek/Claude/OpenAI） |
| **Domain** | ai-auto-apply、job-helper、job-hunter、boss-apply、apply-bot |

---

## 二、调研对象盘点

### 2.1 Chrome Web Store 浏览器扩展（公开搜索）

来源：chromewebstore.google.com 关键词 "boss直聘 投递" 搜索结果（10 个匹配）

| # | 名称 | 关键能力 | 备注 |
|---|---|---|---|
| 1 | **BOSS海投助手** | 自动打招呼 | 名称直接对位 |
| 2 | **BOSS打招呼助手** | 自动打招呼 | 同上 |
| 3 | **AI找工作神器 - AI工作快搜** | **跨 4 平台**（BOSS/51Job/智联/猎聘）| AI 搜索匹配 |
| 4 | **前程无忧自动投递** | 51Job 平台 | 非 BOSS |
| 5 | **鼠鼠求职-自动投递插件** | 自动投递 | 老插件 |
| 6 | **鼠鼠求职 - AI岗位匹配自动投递** ⭐ | **AI 匹配 + 自动投递** | 与本项目 PRD 高度对位 |
| 7 | **智能求职助手** | 综合求职辅助 | 待核验 |
| 8 | **投投马** | 投递平台 | 待核验 |
| 9 | **简历Mapper：根据岗位量身定制的AI简历** | LLM 简历定制 | 互补型 |
| 10 | **求职加速器** | 综合加速 | 待核验 |

> **截图**：`/tmp/boss-research/screenshots/01-chrome-store-boss-search.png`

### 2.2 GitHub 开源项目（搜 "zhipin playwright" / "boss 投递 OR 打招呼"）

共 **8 个仓库**：

| 仓库 | ⭐ | 技术栈 | License | 最近活动 | **方向** | **与本项目对位度** |
|---|---|---|---|---|---|---|
| **wensia/boss-zhipin-automation** | 47 | Python + FastAPI + React + Playwright | MIT | 活跃 | ⚠️ **HR视角（招人）** | 无关（方向反） |
| **Snseam/boss-zhipin-mcp** | 33 | Python + MCP + Playwright + FastMCP | MIT | 2026-03 commit | ⚠️ **HR 视角** | 架构可借鉴（MCP 模式） |
| **ufownl/auto-zhipin** | 24 | Python + Playwright + Gemini + fast-agent | BSD-3 | 活跃（1 个 open issue） | ✅ **求职者向** | ⭐⭐⭐⭐（最对位） |
| **as161233574-alt/boss-zhipin-bot** | 6 | **Node.js + Playwright + stealth** | ISC | 活跃 | ✅ 求职者向 | ⭐⭐⭐⭐（**技术栈同构**） |
| **imwyvern/boss-autogreet** | 2 | Node.js 推测 | — | 活跃 | ✅ 求职者向 | ⭐⭐ |
| **zhengziha/boss-zhipin** | 1 | — | — | — | — | ⭐ |
| **h1077/BossJob-Helper** | 0 | — | — | — | — | ⭐ |
| **dugufeng666/Job-Data-Scraper / FabonacciiSS/jobs-hunter-workflow** | 0 | — | — | — | — | ⭐ |

#### 重点深挖：4 个候选

**A. ufownl/auto-zhipin** (24⭐, BSD-3-Clause) — **最对位**
- ✅ 求职者视角
- ✅ Playwright + 简历智能筛选 + 个性化文案 + 自动发起
- ✅ 城市/薪资/黑名单过滤
- ⚠️ Python（重写成本中）
- ⚠️ Gemini API（缺多供应商切换）
- ⚠️ **没有飞书集成**
- ⚠️ **没有话术锁定**
- ⚠️ License: BSD-3-Clause（比 MIT 严格，集成需注意归属）

**B. as161233574-alt/boss-zhipin-bot** (6⭐, ISC) — **技术栈同构**
- ✅ **Node.js + Playwright + stealth** — 与本项目技术栈 **完全一致**
- ✅ 扫码登录 + Cookie 持久化
- ✅ 全国远程岗位搜索
- ✅ 批量自动打招呼
- ✅ 反检测（playwright-extra + stealth）
- ✅ 人类行为模拟（随机延迟、鼠标轨迹）
- ✅ 每日上限检测
- ✅ 去重机制（history.json）
- ✅ 异常自动截图
- ⚠️ **没有 LLM 话术生成**
- ⚠️ **没有飞书集成**
- ⚠️ 没有 CLI 形态
- ⚠️ Star 数少（6⭐），长期维护风险存在
- ⚠️ License: ISC（≈ MIT，宽松）

**C. Snseam/boss-zhipin-mcp** (33⭐, MIT) — **MCP 模式参考**
- ✅ MIT
- ⚠️ **HR 视角**（搜候选人），与本项目方向相反
- **借鉴价值**：MCP Server 架构思路（Claude Code ↔ MCP ↔ Browser CDP）

**D. wensia/boss-zhipin-automation** (47⭐, MIT) — **HR 端 UI 全栈**
- ⚠️ **HR 视角**
- **借鉴价值**：FastAPI + React 全栈形态（与本项目 CLI 形态不同）

---

## 三、维度评估矩阵

按 research-first Step 3 的 3 级评分（✅/⚠️/❌）：

| 维度 | 调研要点 | A. ufownl/auto-zhipin | B. as161233574/boss-zhipin-bot | 鼠鼠求职 Chrome 扩展 |
|---|---|---|---|---|
| **需求匹配** | 与本项目 PRD（半自动+飞书+LLM+CLI） | ⚠️ 60%（无飞书/无话术锁） | ⚠️ 50%（无 LLM/无飞书/无 CLI） | ❌ 30%（黑盒、不可集成） |
| **活跃度** | 最近 commit / issue | ✅ 活跃 | ✅ 活跃 | ⚠️ Chrome Store 版本未知 |
| **集成成本** | 改造成本 | ⚠️ Python→TS 重写（中等） | ✅ Node→Node 集成（低） | ❌ 黑盒扩展不可集成 |
| **License** | 是否可商用 | ✅ BSD-3 | ✅ ISC | ⚠️ 视用户协议（未核验） |
| **API 质量** | 文档与稳定 | ⚠️ README 简洁 | ⚠️ README 简洁 | ❌ 无 API |
| **差异化能力** | 是否有独特优势 | ✗ 无飞书 | ✗ 无 LLM/飞书 | ✗ 不可二次开发 |

---

## 四、官方政策（部分调研）

调研路径遇阻：BOSS 直聘用户协议页 URL 难定位（多次 404）。

**已知风险点**（来自上一步骤候选项目的 README 提及）：

| 风险 | 出处 | 描述 |
|---|---|---|
| **日沟通限额约 100 次/天** | boss-zhipin-bot README | BOSS 平台硬性限额 |
| **短时间大量操作触发风控** | 同上 | 类 RPA 行为识别 |
| **遇滑块验证需手动处理** | 同上 | 部分场景下需人工介入 |
| **Boss 改版后需更新选择器** | 同上 | 维护成本不可消除 |
| **账号封禁** | 经验性风险 | 多项目均提示存在 |

> ⚠️ **本节调研不完整**：zhipin.com 协议页面 404、WebSearch API 持续 400 异常，公开政策原文未拿到。**建议用户在 buy/build 前自行查阅 BOSS 直聘最新版《用户协议》和《账号使用规范》**，重点确认"自动化操作"是否在禁止条款内。

---

## 五、Buy / Hybrid / Build 决策

### 5.1 评估候选覆盖度

| 核心需求（来自 PRD） | 现有候选覆盖度 | 关键缺口 |
|---|---|---|
| 岗位搜索抓取 | ✅ 全候选都覆盖 | — |
| 自动打招呼（RPA） | ✅ 全候选都覆盖 | — |
| **LLM 个性化话术** | 🟡 ufownl 仅 Gemini 单供应商 | DeepSeek/Claude/Ollama 切换 |
| **按 job-id 话术锁定** | ❌ 全部缺失 | — |
| **半自动 + 用户审核** | ❌ 几乎全是全自动 | 差异化核心 |
| **飞书多维表格** | ❌ **全部缺失** | 杀手特性 |
| **CLI 形态** | ❌ 全部为 GUI/Web/API | 差异化 |
| **多 LLM 供应商切换** | ❌ 仅 ufownl 一家做了一半 | — |

**结论**：**没有任何候选覆盖 ≥80% 的需求**（最高 ufownl 约 60%）。

### 5.2 反爬策略：从"修补指纹"到"接管真浏览器"的根本转向

#### 5.2.1 核心原则（修订后的唯一决策依据）

**BOSS 直聘属于国内风控强度 Top 5 的招聘平台，不应在新启 Chromium 实例上通过修补指纹来对抗检测，而应让脚本运行在用户真实 Chrome 的"羊皮"之下。**  
Node 生态不需要任何"更强的反爬库"——只需要将 `chromium.connectOverCDP()` 作为主路径，`puppeteer-extra-plugin-stealth` 降级为**仅当 CDP 不可用时的兜底方案**。

此前调研中列举的 L1/L2/L3 三层六种工具均为干扰项，实际收敛为唯一正确路线：

| 阶段 | 唯一动作 |
|------|----------|
| 启动 | 提示用户以 `--remote-debugging-port=9222 --user-data-dir=~/.boss-chrome` 启动 Chrome |
| 接管 | `chromium.connectOverCDP('http://localhost:9222')` |
| 复用 | 直接获取 `browser.contexts()[0]` —— 用户多年稳态的真实身份 |
| 降级 | 仅当 CDP 连接失败时，回退到 Playwright 自启 Chromium + stealth，并标注为次要兜底 |

#### 5.2.2 架构总览

```
┌──────────────────────┐    CDP/WS    ┌──────────────────────────────────┐
│   Node CLI (bapply)  │ ◄─────────►  │  用户本地 Chrome 实例              │
│                      │               │  --remote-debugging-port=9222     │
│  src/cli/            │               │  --user-data-dir=~/.boss-chrome   │
│  src/browser/cdp.ts  │ ────────────► │                                  │
│  src/browser/human.ts│               │  ┌─ 真实用户 profile（多年稳态）   │
│  src/browser/guard.ts│               │  │  ├─ Cookies（含 BOSS session） │
│  src/feishu/         │               │  │  ├─ LocalStorage              │
│  src/llm/            │               │  │  └─ Canvas/WebGL 真指纹        │
│  src/template/       │               │  └─ 已登录态（复用）                │
│  src/config/         │               └──────────────┬───────────────────┘
└──────────┬───────────┘                              │
           │ 写回数据                                  ▼
           ▼                              ┌────────────────────────────┐
    ┌──────────────────┐                    │   BOSS 直聘 Web 服务         │
    │  飞书多维表格    │                    │   风控判定："用户在浏览" ✅   │
    │  (jobs / 话术)  │                    │   无 webdriver 痕迹          │
    └──────────────────┘                    └────────────────────────────┘
```

BOSS 服务端感知到的始终是 `navigator.webdriver=false`、指纹长期稳定、IP 段与历史一致——与真人操作无异。

#### 5.2.3 用户交互时序（含风控处理）

```
 用户                 Node CLI               Chrome (CDP)              BOSS 直聘
  │                       │                       │                          │
  │  启 Chrome 9222       │                       │                          │
  │ ───────────────────► │                       │                          │
  │                       │                       │  (用户长期登录态)        │
  │                       │                       │                          │
  │  bapply greet job-7   │                       │                          │
  │ ───────────────────► │  CDP connect          │                          │
  │                       │ ───────────────────► │ 复用 context[0]           │
  │                       │                       │                          │
  │                       │  search / fetch jobs  │                          │
  │                       │ ─────────────────────────────────────────────► │
  │                       │                       ◄───────── HTML ──────────│
  │                       │                       │                          │
  │                       │  fill greet box      │                          │
  │                       │  (人类节奏 + 贝塞尔)   │                          │
  │                       │ ─────────────────────────────────────────────► │
  │                       │                       ◄──────── success ────────│
  │                       │                       │                          │
  │  ⚠️  风控弹窗          │  guard.ts 检测到       │                          │
  │ ◄──────────────────── │ ◄── "verify required"─┤                          │
  │  用户手动过验证        │                       │                          │
  │ ───────────────────► │  resume 自动流程      │                          │
  │                       │ ─────────────────────────────────────────────► │
  │                       │                       ◄──────── success ────────│
```

**关键设计**：风控触发时整个 CDP session 暂停，等待用户在真实 Chrome 中手动完成验证，随后自动化无缝恢复。整个过程无需重启浏览器或切换设备。

#### 5.2.4 数据实体关系

```
   ┌─────────────────────┐                  ┌─────────────────────┐
   │ Chrome Profile      │                  │ Feishu 多维表格      │
   │ ~/.boss-chrome/     │                  │                     │
   │ ├── Cookies ⓘ       │                  │  ├─ Jobs 表         │
   │ ├── LocalStorage ⓘ  │                  │  │   jobId (BOSS id) │
   │ └── IndexedDB       │                  │  │   公司/岗位/状态   │
   └─────────┬───────────┘                  │  ├─ Greetings 表    │
             │ 接管 + 持久化                  │  │   jobId → 话术   │
             ▼                              │  │   (锁定不覆盖)   │
   ┌─────────────────────┐                  │  └─ Tracking 表     │
   │ Playwright Browser  │                  │      沟通状态/时间戳 │
   │  contexts()[0]      │ ────回写───────► │                     │
   │  pages()            │                  └─────────────────────┘
   └─────────────────────┘
                                       ⓘ = 不被自动化写入，
                                            仅作为接管来源
```

**约束**：Cookie/LocalStorage 为只读的"接管来源"，自动化过程绝不主动写入，避免被风控识别为 cookie 被篡改。

#### 5.2.5 风控降级决策流程

```
                    ┌──────────────────────┐
                    │ bapply 任意子命令启动 │
                    └──────────┬───────────┘
                               │
                               ▼
                 ┌──────────────────────────────┐
                 │ 检测 CDP 端口 9222 是否就绪     │
                 └──────────────┬──────────────┬─┘
                                │ 是            │ 否
                                ▼              ▼
               ┌────────────────────────┐  ┌────────────────────────┐
               │ connectOverCDP(9222)    │  │ 自动 fallback：         │
               │ 接管用户真 Chrome       │  │ 启 Playwright + stealth │
               └────────────┬───────────┘  │ + 真 Chrome channel    │
                            │              │ (提示用户日后改用主路径) │
                            ▼              └────────────┬────────────┘
                 ┌────────────────────┐                 │
                 │ 任务执行（受日限）  │ ◄───────────────┘
                 └────────────┬───────┘
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
         ┌──────────┐  ┌──────────────┐  ┌──────────────┐
         │ 正常完成  │  │ 验证码弹窗    │  │ 频率封禁      │
         └─────┬────┘  └──────┬───────┘  └──────┬───────┘
               │              │                  │
               ▼              ▼                  ▼
         ┌──────────┐  ┌──────────────┐  ┌──────────────┐
         │ 写回飞书  │  │ 暂停+通知用户 │  │ 停止今日任务  │
         └──────────┘  │ (手动过验证)  │  │ 明/后日重试  │
                      └──────┬───────┘  └──────────────┘
                             │
                             ▼
                      ┌──────────────┐
                      │ 验证通过后    │
                      │ 恢复自动化   │
                      └──────────────┘
```

#### 5.2.6 实施清单（已收敛，按优先级）

| 优先级 | 任务 | 影响范围 |
|--------|------|----------|
| P0 | 新增 `src/browser/cdp.ts`：封装 `connectOverCDP` 与 context 复用逻辑 | 单文件新增 |
| P0 | 新增 `src/cli/init.ts` 中的 `bapply chrome` 命令，提示用户启动 Chrome 的参数 | CLI 扩展 |
| P0 | 重写 `src/browser/index.ts`：将 `chromium.launch()` 主路径改为 `connectOverCDP()` | 单文件重写 |
| P1 | 新增 `src/browser/guard.ts`：风控检测 hook（验证码/频率拦截） | 单文件新增 |
| P1 | 新增 `src/browser/human.ts`：人类行为模拟（贝塞尔鼠标、随机键入延迟） | 单文件新增 |
| P2 | 在 `.env.example` 暴露 `BOSS_CDP_PORT`、`BOSS_CHROME_PATH` | 配置 |
| P2 | README 重写：将 CDP 接管列为唯一推荐路径，stealth 标记为 fallback | 文档 |
| 弃用 | `puppeteer-extra-plugin-stealth` 保留依赖但仅作为 fallback 使用 | package.json 注释 |

### 5.3 推荐路径

**Phase 1（1-2 Sprint）**：完成本项目已规划的核心功能
- 不引入第三方 fork，直接基于 PRD 推进 TDD

**Phase 2（按需）**：参考 boss-zhipin-bot 的工程化经验
- 移植其"人类行为模拟"参数（随机延迟、鼠标轨迹）到本项目
- 移植其"每日上限检测 + 异常自动截图"机制
- License: ISC ≈ MIT，可直接借鉴实现思路（无需 fork）

**Phase 3（可选）**：评估是否值得集成 ufownl 的 LLM prompt
- BSD-3 比 ISC/MIT 严格，**集成时注意保留 BSD-3 归属声明**

---

## 六、风险登记册

| ID | 风险 | 等级 | 缓解措施 |
|---|---|---|---|
| R1 | BOSS 直聘官方政策禁止自动化 | 中 | 上线前用户自查协议；保留手动模式 |
| R2 | 账号封禁 | 高 | 严格限速（≤100 次/天）+ 异常自动截图上报 |
| R3 | 反爬升级（人机验证） | 高 | 保留"遇验证码切手动"开关（PRD 已有半自动设计） |
| R4 | BOSS 前端改版导致选择器失效 | 中 | 集中管理选择器在 `src/browser/selectors.ts`，便于维护 |
| R5 | LLM 话术质量不稳定 | 中 | 话术锁定 + 用户审核（PRD 已有） |
| R6 | 飞书 API 凭证泄露 | 低 | 仅写本地 .env，README 提示不入库 |
| R7 | Chrome 扩展类竞品被用户首选 | 低 | CLI 形态定位"专业玩家"，扩展定位"普通用户"，不冲突 |

---

## 七、未完成的调研

由于 WebSearch API 在本次会话持续报 400 错误，部分调研路径被阻断：

1. ❌ **BOSS 直聘官方政策原文**（zhipin.com 协议页 404）  
   → 建议用户自行查阅最新版协议，重点核"自动化操作"条款

2. ❌ **微信公众号 / 知乎 AI 求职工具评测文章横评**  
   → 关键词建议："AI 求职 boss直聘 自动投递 评测"、"鼠鼠求职 坑"、"BOSS海投助手 封号"

3. ❌ **NPM/PyPI 包注册表扫描**（playwright-boss、zhipin-*、job-apply* 等纯包）  
   → 这类包级工具多为单一功能，整体对位度低

4. ⚠️ **Chrome Web Store 中各插件的最近更新日期、用户数、评分**——需要逐一点进详情页确认活跃度

如果用户决定进入 TDD/Build 阶段，建议先完成项 1（BOSS 政策）和项 2（评测反坑），避免踩坑后再回头改 PRD。

---

## 八、引用列表（研究证据）

| 类别 | 来源 | URL |
|---|---|---|
| Chrome Web Store | "boss直聘 投递" 搜索结果 | chromewebstore.google.com/search/boss直聘%20投递 |
| GitHub | wensia/boss-zhipin-automation (47⭐) | github.com/wensia/boss-zhipin-automation |
| GitHub | Snseam/boss-zhipin-mcp (33⭐) | github.com/Snseam/boss-zhipin-mcp |
| GitHub | ufownl/auto-zhipin (24⭐, BSD-3) | github.com/ufownl/auto-zhipin |
| GitHub | as161233574-alt/boss-zhipin-bot (6⭐, ISC) | github.com/as161233574-alt/boss-zhipin-bot |
| GitHub | imwyvern/boss-autogreet (2⭐) | github.com/imwyvern/boss-autogreet |
| GitHub | Search: "zhipin playwright" | github.com/search?q=zhipin+playwright |
| GitHub | Search: "boss 投递 OR 打招呼" | github.com/search?q=boss+投递+OR+打招呼 |
| 项目 PRD | 本项目 PRD（已有） | docs/prd.md |
| 截图 | Chrome Web Store 搜索结果 | /tmp/boss-research/screenshots/01-chrome-store-boss-search.png |

---

## 九、Handoff 信号

> **决策**：**HYBRID**
> **下一步**：
> - 用户确认方向 → 切到 `/tdd`（按现有 PRD 实现）
> - 用户想先补调研 → 走本报告 §7 未完成项（BOSS 政策、知乎评测）
> - 用户想换方向（如改造成 Chrome 扩展）→ 重新跑 research-first

**推荐**：基于 PRD 继续 TDD，把"参考 boss-zhipin-bot 行为模拟机制"作为 **Phase 2 follow-up** 而非启动阻塞。差异化优势（飞书 + LLM 多供应商 + 半自动审核）才是本项目应该抢占的方向。
