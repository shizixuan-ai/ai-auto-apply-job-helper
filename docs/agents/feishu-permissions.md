# Feishu (飞书) Bitable API 权限完整指南

> **写给**：需要在 `boss-apply` 项目里读写飞书多维表格的所有人（含 compact 后的 AI）
> **踩坑记录**：2026-07-07 init-feishu.sh 跑通失败，根因是缺「文档级授权」这一步

## TL;DR — 飞书个人版应用的 Bitable 写入需要两步授权

1. **API Scope 授权**（在飞书开放平台 → 权限管理 → API 权限里给应用加 `bitable:app`）
2. **文档级授权**（在多维表格本身 → `···` → 更多 → 添加文档应用 → 设为「可编辑」）

**缺任何一步**都会得到同一个错误：`code=91403 Forbidden`，但**无法通过错误码区分**。

---

## 详细步骤

### Step 1: API Scope 授权（开放平台）

1. 打开 https://open.feishu.cn/app → 选择你的应用
2. 左侧导航 → **权限管理** → **API 权限**
3. 搜索 `bitable:app` 或「多维表格」
4. 勾选 **「查看、评论、编辑和管理多维表格（bitable:app）」**
   - ⚠️ `bitable:app:readonly` 只读，**不能写入**，不要只勾这个
5. 点 **「确认开通权限」**
6. 左侧导航 → **版本管理与发布** → 创建新版本 → 提交
   - 「免审权限」自动通过，1-2 分钟生效
   - 看到顶部绿色「当前修改均已发布」即可

### Step 2: 文档级授权（多维表格本身）

> 🔑 **这是最容易漏的一步**。即使 Step 1 全做完，不做这一步依然 91403 Forbidden。

1. 浏览器打开目标多维表格（URL: `https://xxx.feishu.cn/base/<APP_TOKEN>?table=<TABLE_ID>`）
2. 右上角 `···` → **更多** → **添加文档应用**
3. 搜索你的应用名 → 选中
4. 权限级别改为 **「可编辑」**（默认可能是「可阅读」）

**注意**：个人版飞书的某些表格类型不支持添加应用（极少，但存在）。遇到这种情况的解法：

- 方案 A：升级到企业版飞书
- 方案 B：在飞书「工作台」里创建一个新的多维表格，**从企业版工作台入口新建的表格 100% 支持**

### Step 3: 独立验证（必做，不靠 UI）

Step 1+2 完成后，**必须**用 curl 直接调 API 验证，不要相信 UI 状态：

```bash
cd /Users/wangjixue/Documents/projects/ai-auto-apply-job-helper
APP_ID=$(grep '^FEISHU_APP_ID=' .env | sed -E "s/^FEISHU_APP_ID=//; s/^['\"]//; s/['\"]$//")
APP_SECRET=$(grep '^FEISHU_APP_SECRET=' .env | sed -E "s/^FEISHU_APP_SECRET=//; s/^['\"]//; s/['\"]$//")
APP_TOKEN=$(grep '^FEISHU_APP_TOKEN=' .env | sed -E "s/^FEISHU_APP_TOKEN=//; s/^['\"]//; s/['\"]$//")
TABLE_ID=$(grep '^FEISHU_TABLE_ID=' .env | sed -E "s/^FEISHU_TABLE_ID=//; s/^['\"]//; s/['\"]$//")

TOKEN=$(curl -sS -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tenant_access_token'])")

# 写探测：尝试创建 1 条记录
RESP=$(curl -sS -X POST "https://open.feishu.cn/open-apis/bitable/v1/apps/$APP_TOKEN/tables/$TABLE_ID/records" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"文本":"权限探测"}}')

echo "$RESP" | python3 -m json.tool
```

**期望结果**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "record": { "record_id": "recXXXXX", "fields": { "文本": "权限探测" } } }
}
```

**仍然 Forbidden 的话**：

- 回到 Step 1 确认勾选了 `bitable:app`（不是 readonly）
- 回到 Step 2 确认应用已添加到该多维表格且权限为「可编辑」
- 等待 5-10 分钟（权限发布有缓存延迟）

---

## 常见错误码速查

| code | msg | 含义 | 解法 |
|------|-----|------|------|
| `0` | success | 成功 | — |
| `91403` | Forbidden | 权限不足 | 按本文 Step 1+2 检查 |
| `99991663` | token invalid | `tenant_access_token` 过期或失效 | 重新调用 `/auth/v3/tenant_access_token/internal` |
| `99991668` | token expired | token 已过期（2 小时有效期） | 重新获取 |
| `91402` | NOTEXIST | 表格不存在 | 检查 `APP_TOKEN` / `TABLE_ID` |
| `1254040` | rate limit | API 调用频率超限 | 脚本里加 sleep 或减少并发 |
| `99991400` | invalid parameter | 请求参数错误 | 检查 field_name、type 等 |

---

## 加密策略与本项目无关（FAQ）

**问题**：飞书开放平台的「事件与回调 → 加密策略」里 Encrypt Key 没开启，会影响 bitable API 写入吗？

**答案**：**不会**。

- Encrypt Key：仅加密**事件订阅 / Webhook 回调**的 payload（飞书 → 你的服务器）
- Verification Token：仅验证回调请求来源

本项目用的是 `tenant_access_token` + Bearer 认证，**完全不经过加密策略**。

---

## 相关项目资源

- 初始化脚本：`scripts/init-feishu.sh`（已修复 `declare -A` bash 3.2 兼容性问题）
- 端到端测试：`scripts/test-auto-greet.sh`
- 业务代码：`src/feishu/index.ts`（API 调用层，已修 `res.ok` 检查 P0 fake green）