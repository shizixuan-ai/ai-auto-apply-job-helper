# ADR-0004: fetchJobDetail 懒加载防御 + JD 长度 smoke 验证

> **状态**：草案（2026-07-10）
> **作者**：boss-apply dev
> **替代**：Sprint 2C（原目标"找新 selector"被真实探针证伪）

## 背景

Sprint 2C 的原始目标：用真实 BOSS HTML 探针找出"失效 selector"，加进 `JD_SELECTORS` 数组。

**真实探针结果**（用 Playwright `page.evaluate` 在已登录 BOSS tab 实测）：
- T0（立即查）：`.job-sec-text` matched=2，**textLength=551 字符**，4 个子元素
- T+3s：matched=1，**textLength=917 字符**，17 个子元素
- T+6s + scroll：917→919（稳定）

**结论**：
- 6 个 selector 全部"命中" — selector 没错
- 但**首屏只渲染 60% JD 内容**，等 3 秒才补齐剩余 40%
- 旧代码 `page.waitForSelector` + `page.$eval(textContent)` 在 selector 一出现时就 resolve，**拿到的是 551 字符的不完整 JD**

**事故路径**（§3.2 假绿）：
```
fetchJobDetail → 551 字符 → 返给 LLM 评分 → scored > 0 → 写飞书
  ↓
真实 JD 是 917 字符，40% 内容（任职要求/加分项等）被静默丢弃
```

## 决策

### 决策 1：双路都加 `MIN_JD_LENGTH` 校验
- **wapi 路径**：拿到 `jobDesc` 后检查 `length >= MIN_JD_LENGTH`（默认 500），不够则视为懒加载未完成，降级到 page.goto
- **page.goto 路径**：把 `page.waitForSelector(selector, timeout=3s)` 替换为 `page.waitForFunction((sel, min) => { const el = document.querySelector(sel); return el && el.textContent.trim().length >= min }, { timeout: 10s, polling: 500 })`

### 决策 2：抛出结构化 LazyLoadError
- 不抛字符串，而是抛 `new LazyLoadError({ selectors, lengthHistory, attemptLogs })`
- 每个 selector 在 1s/3s/10s 三个时间点的 `textLength` 记录到 `lengthHistory`
- 未来接 Sentry/Logstash 时按字段聚合分析

### 决策 3：throttleMs 期间加 waitForSelector 前置检查
- `page.waitForTimeout(throttleMs)` 之前先 `page.waitForSelector('body', { timeout: 5000 })` 检查页面骨架是否加载
- 防止"等 3 秒后页面 404 / 空白"浪费 selector 探针时间

### 决策 4：smoke rule #4 — jd-length-verify
- 触发条件：`src/browser/**` 改 + `src/browser/index.ts` 强制触发
- skip 条件：CDP :9222 不可达
- 验证内容：跑 `bapply search Java后端 --cdp --dry-run --limit 3`，断言**每个 scored job 的 JD textLength ≥ 500**
- exit 1 BLOCK：任一 scored job 的 JD 长度 < 500（"懒加载假绿"）
- exit 0 OK：所有 scored job 的 JD 长度 ≥ 500

### 决策 5：verdict 决策树新增硬契约关键词
- `/jd length \d+ < \d+/`（明确报告长度不足）
- `/懒加载未完成/`（中文提示）

## 阈值 `MIN_JD_LENGTH=500` 的边界说明

500 字符针对**中文 JD**（一段完整描述）。
- 全英文 JD：500 字母密度低，可能不够 → 用户未来可调高 `MIN_JD_LENGTH_THRESHOLD` env
- 极短岗位（如"急招搬运工"）：可能真就只有 200 字符 → 阈值需调
- **MVP 选 500 是经验值，后续根据真实数据校准**

## 实施步骤（Sprint 2E）

1. **RED**：写 `src/browser/index.test.ts` 新增 3 测试
   - TEST A：wapi 返 0 字符 → 自动降级 page.goto
   - TEST B：page.waitForSelector 抛 → 但 waitForFunction 等到 → 返完整 JD
   - TEST C：全部超时 → 抛 LazyLoadError with details
2. **GREEN**：改 `fetchJobDetail` 加懒加载防御
   - 新增 `MIN_JD_LENGTH` 常量
   - wapi 返长度校验
   - 替换 `waitForSelector` 为 `waitForFunction(textLength >= MIN)`
   - throttleMs 之前 `waitForSelector('body', 5s)`
3. **REFACTOR**：抽 `LazyLoadError` 类
4. **SMOKE**：加 `scripts/verify-jd-length.mjs` + rule #4 + verdict 关键词

## 备选方案（被否决）

### 备选 A：jsdom + mock HTML fixture
- ❌ mock HTML 永远不能代表 BOSS 真实异步行为
- ❌ fixture-based 测试是 §3.2 假绿的反模式

### 备选 B：加 `waitForTimeout(5000)` 硬等
- ❌ 不可靠（5s 可能还不够）
- ❌ 浪费等待时间（如果已经渲染完）
- ❌ 没有长度验证，仍可能拿到不完整 JD

### 备选 C：换 selector
- ❌ 实测所有 6 个 selector 都命中，问题不在 selector
- ❌ 换 selector 解决不了懒加载

## 验证方式

- 单元测试：3 个新增测试 + 现有 fetchJobDetail 测试
- 真实验证：跑 `cli-smoke` + `jd-length-verify`，确认 scored job 的 JD textLength ≥ 500
- smoke hook：commit `src/browser/index.ts` 时强制跑 jd-length-verify

## 相关文档

- ADR-0002: CDP + withGuard + human.ts 三件套架构
- ADR-0003: BOSS API city 锁定
- `src/browser/index.ts` JD_SELECTORS 数组
- `scripts/smoke/rules.yaml` rule #1 boss-probe（已存在）