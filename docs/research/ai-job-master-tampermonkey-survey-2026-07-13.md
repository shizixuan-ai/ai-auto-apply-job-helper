# ai-job-master 油猴层深度调研（2026-07-13）

> **作者**：boss-apply dev（via general-purpose survey agent）
> **来源**：`/Users/wangjixue/workspace/ai-job-master`（monorepo）
> **目的**：回答用户问题"CDP 不可行时，能否切换为油猴模式？"
> **结论**：**可行性 high**，推荐切换。

---

## TL;DR

ai-job-master 的油猴 UI 是**当前公开资料里对 Boss 聊天协议最完整的还原**，与 Spring Boot 后端解耦清晰（只通过 `/api/*` + wapi/* 两个域通信）。**WebSocket hook + protobuf 解析 + 简历抓取 + 评分调用 四块都可独立 fork**。

最大脆弱点：**WebSocket hook 对 BOSS 全局对象名（ChatWebsocket / ChatWebsocketImage / GeekChatCore）硬依赖**——Boss 改版即崩。protoDefinition 是 7KB 单行字符串常量，维护性差。

---

## 4 子点调研结论

### 1. WebSocket 钩子（关键代码）

**路径**：`ai-job-hunting-ui/src/webSocket/hookMain.ts:25-66` + `AntiAnti-Hook.js:16-160`

**机制**：构造函数劫持（WebSocketProxy 继承原生 WebSocket）+ send/onmessage 双拦截

```typescript
class WebSocketProxy extends originalWebSocket {
  constructor(url, protocols?) {
    super(url, protocols);
    url = url.replace(':443','');
    const shouldHook = url.includes('chat');   // 只钩 chat 通道
    if (!shouldHook || hookMap.has(url)) return this;
    hookMap.set(url, this);
    Object.defineProperty(this, 'onmessage', {
      set: (fn) => this.addEventListener('message', e =>
        receiveInterceptor
          ? fn.call(this, new MessageEvent('message', {data: receiveInterceptor(e.data)}))
          : fn.call(this, e))
    });
    this.send = (data) =>
      sendInterceptor
        ? originalSend.call(this, sendInterceptor(data))
        : originalSend.call(this, data);
  }
}
Tools.window.WebSocket = WebSocketProxy as any;
```

**心跳 / 重连**：无显式——复用 BOSS 自带的 mqtt 心跳，hook 层不干预。`hookExistingWebSockets()` (hookMain.ts:99-129) 兜底对未在构造期捕获的实例补装 send 拦截。

**关键依赖**：`Tools.window.ChatWebsocket` / `ChatWebsocketImage` / `GeekChatCore`——**硬编码**，代码注释已有 hardcoded "boss 可能更新了，请反馈"。

### 2. BOSS WebSocket protobuf 结构

**路径**：`ai-job-hunting-ui/src/webSocket/protobuf.ts:46`（protoDefinition 单行 7KB 字符串） + `utils.ts:5-37`（解码） + `mqtt.ts:53-125`（编/发）

**lib**：`protobufjs`（运行时 parse + lookupType）

**主要 messageTypes**：

| 类型 | 关键字段 |
|------|---------|
| `TechwolfChatProtocol` | type / version / messages / presence / iq / iqResponse / messageSync / messageRead / dataSync / domain |
| `TechwolfMessage` | from / to / type / mid / time / body / offline / received / pushText / taskId / cmid / status / uncount / pushSound / flag / encryptedBody / bizId / bizType / securityId |
| `TechwolfMessageBody` | type（1=文本/2=模板/3=图片/9=职位/10=简历/...）/ content / atInfo / sticker / listCard / frame / extend |
| `TechwolfResume` | user / description / city / position / keywords / expectId / lid / gender / salary / workYear / content1-3 / education / age / labels / experiences / securityId / boss / brandName |
| `TechwolfJobDesc` | title / company / salary / url / jobId / lid / stage / labels / boss / securityId |
| `TechwolfMessageRead` | userId / messageId / readTime / sync / userSource |
| `TechwolfPresence` | clientInfo / clientTime / lastMessageId |

### 3. 简历数据抓取 + 传递

**路径**：`ai-job-hunting-ui/src/utils/tools.ts:156-179` + `AiJob.vue:420-488`

**数据流**：

```
wapi/zpgeek/resume/sidebar.json  (axios.get)
       │
       ▼ 拿 resumeId
docdownload.zhipin.com/wflow/zpgeek/download/download4geek?resumeId={id}
  (GM_xmlhttpRequest 跨域拉 PDF 字节流)
       │
       ▼ FormData (file + resumeId + uniqueId)
后端 POST /api/user/import/resume (multipart/form-data, Spring Boot UserResume 表)
```

**关键代码**：

```typescript
let resumeInfoResp = await axiosOriginal.get(
  'https://www.zhipin.com/wapi/zpgeek/resume/sidebar.json',
  { headers: { 'Zp_token': token } }
);
let zpData = resumeInfoResp.data.zpData;
let resumeId = zpData.attachmentList[0].resumeId;
let resumeFileResp = await fetchWithGM_request(
  'https://docdownload.zhipin.com/wflow/zpgeek/download/download4geek?resumeId=' + resumeId,
  { headers: { 'Zp_token': token }, responseType: 'arraybuffer' }
);
let fileBlob = new Blob([resumeFileResp.response], { type: 'application/pdf' });
let formData = new FormData();
formData.append('file', fileBlob);
formData.append('resumeId', resumeId);
formData.append('uniqueId', bossUserId);
let importResp = await axios.post('/api/user/import/resume', formData, {
  headers: { 'Content-Type': 'multipart/form-data' }
});
```

**对我们方案的启示**：油猴 → 用户脚本自管 resume，可以不传 Spring Boot；回传到我们自己的 local API（Py/Go 容器）+ 本地文件系统 / SQLite。

### 4. 评分逻辑 + 剥离方案

**路径**：`ai-job-hunting-server/src/main/java/com/maple/ai/job/hunting/service/biz/JobFilterService.java:30-60` + `JobFilterController.java:29-32` + `AIPromptStrConstant.java:91-101`

**模型池**：`AIServiceFacade.askAndAnswer` 路由 OpenAI / Kimi / DeepSeek / CustomOpenAI 多池（由 `OpenAIPoolService` + `UserAIConfigService` 动态选）

**特征**：
- 用户自然语言 prompt（preference.af）
- 岗位：jobName / salaryDesc / jobLabels / skills / jobExperience / jobDegree / cityName / areaDistrict / businessDistrict / brandName / brandStageName / brandIndustry / brandScaleName / welfareList（`unpackBaseInfo`）
- 描述：postDescription / address / activeTimeDesc（`unpackExtInfo`）
- 硬规则前置：排除 / 包含关键词（jce / jci）、排除公司、是否已沟通

**剥离 / 接口方案**：

| 项 | 建议 |
|-----|------|
| 可行性 | **high** |
| 接口 | REST `POST /api/job/filter/one`，保持现状契约即可最小化改动 |
| 评分服务 | 独立部署 Python/Go 容器，`JobFilterController` 改成 HTTP 客户端调用 |
| 契约建议 | 保留：Request `{ prompt, jobBaseInfo(JSON), jobExtInfo(JSON) }`，Response `{ code, data: { filter, reason } }`；**新增** `score: 0-100` + `matchedFeatures: string[]` 让我们前端能直接展示 |

---

## 风险点（dealBreakers）

| 风险 | 影响 | 缓解 |
|------|------|------|
| BOSS 全局对象名（ChatWebsocket / ChatWebsocketImage / GeekChatCore）硬依赖 | Boss 改版即崩 | 建 watcher 监控 Boss 前端改版 + 自动通知 |
| protoDefinition 是单行 7KB 字符串常量 | 维护难、无外部 .proto 可读 | 抽到独立 `.proto` 文件 + 生成 TS 类型 |
| hookMain.ts:23 URL.includes('chat') 只钩 chat 通道 | 其它协议监听不到 | 改为可配置 allowlist |
| messageId 生成 `Date.now()+68256432452609` 经验值 | Boss 端校验会变 | 改成 UUID v7 + 服务端不依赖 ID 校验 |
| Spring Boot 后端与油猴强耦合（URL/鉴权/支付/会员） | 剥离难 | 评分 (`JobFilterService`) 是干净的，可独立抽出；resume 存储可换自己服务 |
| `function.toString()` 反调试伪装 + iframe.contentWindow Proxy | Boss 检测增强时可能反扑 | 在 AntiAnti-Hook.js 已覆盖基础，未来需扩展 |

---

## 综合判断

| 维度 | 评估 |
|------|------|
| 油猴 fork 可行性 | ✓ high |
| 工作量估时 | 1-2 sprint（fork + 去商业化 + 部署） |
| 与 BOSS 风控对抗状态 | 切换后预期**显著降低**（流量特征转为浏览器内） |
| 与现有 CDP 模式兼容 | 兼容（task #14 保留 CDP 作 dev 备胎） |
| 简历评分穿透 | feasible（独立 REST 接口 + 多模型池） |

---

## 下一步建议

1. **架构图重画**：以"油猴为入口 + 本地 AI API + 可选 CDP 备胎" 画 4 类图
2. **下游简历评分**：先在 web 端口做一个 mock 评分服务（FastAPI），确认数据流端到端
3. **BOSS 全局对象名 watcher**：建一个最小脚本（每 24h 在登录态 BOSS 上跑一次探测，检测名字是否变了）
4. **protoDefinition 外置**：拆出 `.proto` 文件，重新生成 TS 类型

**用户裁决下一步**：
- (A) 直接启动 fork（task #12）—— 立即动手
- (B) 先做架构图重画 + watcher 兜底，再启动 fork
- (C) 先小范围 PoC：只 hook WebSocket 看一条聊天消息流，确认在我们的 BOSS 会话下能跑通，再展开
