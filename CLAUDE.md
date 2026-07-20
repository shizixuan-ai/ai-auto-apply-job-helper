# 🚨 RED LINES (违反任何一条即视为本 session 失败)

> **每次 session 启动必须读。违反即停手 + 承认 + 不狡辩。**

1. **【调研类禁止发散】** 调研 / 找 API / 找方案 → 先 Read `scripts/probe-*.mjs` + `docs/adr/*.md` + `docs/research/*.md` + 已有 GitHub 调研。**不准凭印象推断。**
2. **【禁止重复造轮子】** 写新脚本/工具前 → grep 项目 `scripts/` `src/` `tests/` 已有同名/类似功能。命中则用已有，不重建。
3. **【Edit/Write 前必 Read】** 改任何文件前 → Read 目标文件 + 相关 ADR + probe 脚本 + 单测。"看目标再动手"。
4. **【承认错误不狡辩】** user 指出错误 → 立刻承认 + 简短复盘（不展开发散）。**禁止"我之前是对的"式反驳**。
5. **【不浪费 user 时间】** 上下文 < 30% 时立刻 Checkpoint + 拆 Sprint。**禁止在 100% 上下文下继续发散讨论**。

---

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles with default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.