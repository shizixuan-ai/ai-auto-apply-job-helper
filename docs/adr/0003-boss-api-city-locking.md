# ADR-0003: BOSS 直聘 API City 参数被忽略（接受现状）

- **状态**：Accepted
- **日期**：2026-07-04
- **决策者**：项目 owner（实测复现 + 接受）

---

## 1. Context（背景）

用户在 2026-07-04 实测发现：

- 调用 `bapply search "前端开发" --cdp --city "北京"`
- 命令带 `--city 北京` 参数
- CLI 正确把 101010100（北京 city code）传给 BOSS 直聘 `/wapi/zpgeek/search/joblist.json` 接口的 `body.city` 字段
- 但 BOSS API 服务端**忽略**该参数，返回的 15 条岗位**全部位于杭州**

进一步验证发现用户的 BOSS 账户在登录态下，cookie / account profile 已锁定城市为"杭州"，即使把"求职期望"切到上海，搜索接口仍返杭州岗位。

---

## 2. Evidence（证据）

四向独立验证：

| 验证手段 | 结果 | 结论 |
|---------|------|------|
| CLI `--city "上海"` | 15 条全杭州 | `body.city` 被服务端忽略 |
| CLI `--city "成都"` | 15 条全杭州 | 同上，确认跨大区也忽略 |
| Chrome 接管窗口访问 zhipin.com | 城市按钮 = "杭州" | BOSS session profile 锁定杭州 |
| 截图右下角"根据求职期望匹配：上海" | 但搜索结果仍全杭州 | 求职期望不参与 city 决策 |

截图佐证：
- `~/.claude/image-cache/.../4.png`（city"杭州 [切换]"标签、"上海"求职期望但搜索仍返杭州）
- 之前轮：`.../2.png`（验证 1 的 zhipin.com 杭州首页）

进一步推测（未确认）：
- BOSS 风控/产品决策：API 用 session profile 做服务端决策，`body.city` 只是 hint 而非 contract
- 不排除 IP-based 推断（用户当前 IP 在杭州）
- 不排除 BOSS 后端有更复杂的决策服务（如基于"求职期望 + profile + IP"复合运算）

---

## 3. Decision（决策）

**接受现状**：不在 v0.1 中尝试 reverse-engineer BOSS 真实的 city 决策机制。

具体做法：
- CLI `--city` 参数降级为 **hint** 而非 **contract**
- `searchJobs()` 调用 `detectCityMismatch()` 检查 BOSS 返回结果实际所在城市
- 不匹配时 `console.warn()` 打印标准化提示，明确告诉用户：
  - 命令行 `--city` 被忽略
  - BOSS 实际返回的城市
  - 用户需要的下一步动作（在 BOSS 直聘页面顶部手动切换城市 + 重启 Chrome CDP 会话）

抽 helper 到 `src/browser/city-utils.ts` 而非内联：
- 单一职责：city 逻辑一处维护
- 模糊匹配：normalizeCity 去掉"省"/"市"后缀转小写
- 易测：独立 vitest（17 测试覆盖 normalize / detect / 警告文案）

---

## 4. Consequences（影响）

### Positive（正面）
- 用户不会误以为 `--city` 能稳定切换城市
- 警告文案明确指引用户自行在 BOSS UI 切城市（终极解决路径）
- 模糊匹配避免"北京" vs "北京市"的误报
- helper 可复用：未来 DOM fallback 模式 / `greet` 命令也能复用

### Negative（负面 / Trade-off）
- v0.1 跨城仍需要用户手动切 BOSS profile 城市 → 不是"全自动"
- 警告文案有限长度内要表达 4 件事（命令 / 实际城市 / 影响 / 操作），可能啰嗦
- 没有覆盖 `greet` 命令的 city 同步（未来 backlog）

### Neutral（中性）
- BOSS 决策机制保持黑盒 — 升级 BOSS 后端时本 ADR 自动过期，需重新评估

---

## 5. Alternatives Considered（备选方案）

### A. 反向工程 BOSS 切换城市时的真实 API 字段
- **优点**：可能找到真正生效的 city 参数（如 `body.position` 或 `body.location_code`）
- **缺点**：属于"对抗性调研"，可能踩 BOSS 反爬边界（抓 Network 面板可能被风控标记）
- **结论**：暂缓 — 等 v0.1 实测周期稳定后再调研

### B. Playwright 模拟点击 BOSS 顶部"切换城市"按钮
- **优点**：完全模拟人工切换，session 更新彻底
- **缺点**：每次 CLI 调用前模拟 5-10 次点击，违反"少操作节奏"，可能撞 BOSS 异地登录提醒（"杭州 → 北京" → "非常用城市登录" → 强制验证码或重新登录）
- **结论**：风险太高，本版本不采用

### C. 改用 DOM 提取作为主路径
- **优点**：DOM 路径不依赖 BOSS API 行为，但仍受 zhipin.com 页面 city 锁定
- **缺点**：DOM 提取的数据粒度比 API 差，且仍受页面 city 锁定
- **结论**：非根治方案，pass

### D.（已选）接受现状 + 警告用户
- 与上述 3 个方案比性价比最高

---

## 6. When to Revisit（何时复审）

- BOSS 直聘 API 出现新文档或 developer site 公布城市参数语义
- BOSS 后端发生可知版本升级且我们对 city 决策有强需求
- 引入风控合规审查后，允许"对抗性调研"行为

---

## 7. References（参考）

- 实测记录：本次 session 2026-07-04（详见 `.claude-task.md` snapshot）
- 调研报告：`docs/research/boss-auto-apply-2026-06-research.md` §5.2
- helper 代码：`src/browser/city-utils.ts` + `src/browser/city-utils.test.ts`
- 集成点：`src/browser/index.ts` searchJobs() Phase 2.5
- 警告文案：用户审阅通过版（含 `--city` 标识 + `--remote-allow-origins` 修复生态一致）

---

## 8. Decision Authority（决策权威）

- 本 ADR 由项目 owner 实测复现后给出
- 任何后续修改需同时更新：(a) `src/browser/city-utils.ts` 实现 (b) 检测逻辑的测试 (c) README.md §配置说明（如有变化）
