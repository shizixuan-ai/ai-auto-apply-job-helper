// ============================================================
// src/browser/boss-ws/poc-main.ts — Sprint 2026-07-13 PoC 入口
// ============================================================
// 油猴脚本入口（被 esbuild bundle）：
//   1) 激活 WebSocketProxy
//   2) 注册 onmessage → decodeBossProtocol → console.log
//   3) 装上时打印 hook 状态
//
// 决策 2：仅 console.log，不写存储 / 不引入全局变量（除 proxy 必需的内置 hookMap）
// 决策 3：解码 type=1/9/10
// 决策 4：file:// 加载（esbuild 输出单文件 .user.js）
// ============================================================

import { activate } from './proxy.js'
import { decodeBossProtocol } from './decoder.js'

const POC_TAG = '[boss-ws-poc]'
let msgCount = 0

/** 自我诊断 DOM 容器：固定顶部、不被 console.clear 冲、不被 SPA 覆盖 */
let logBox: HTMLDivElement | null = null
function ensureLogBox(): HTMLDivElement {
  if (logBox && document.body?.contains(logBox)) return logBox
  const div = document.createElement('div')
  div.id = 'boss-ws-poc-log'
  div.style.cssText =
    'position:fixed;top:0;left:0;right:0;max-height:280px;overflow:auto;' +
    'background:rgba(0,0,0,0.86);color:#0f0;font:11px monospace;' +
    'z-index:99999;padding:8px;white-space:pre-wrap;border-bottom:1px solid #0f0;' +
    'pointer-events:auto'
  const insert = () => {
    if (div.parentElement !== document.body) document.body?.prepend(div)
  }
  if (document.body) insert()
  else document.addEventListener('DOMContentLoaded', insert)
  logBox = div
  // 头部说明
  div.innerText = `${POC_TAG} log box @ ${new Date().toISOString()}\n` +
    '-------------------------------------------------------------\n'
  return div
}
function appendLog(line: string): void {
  const box = ensureLogBox()
  box.innerText = `${box.innerText}${line}\n`
  box.scrollTop = box.scrollHeight
}
function toHex(bytes: Uint8Array, max = 32): string {
  return Array.from(bytes.slice(0, max))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function dump(msg: ReturnType<typeof decodeBossProtocol>[number]): void {
  const tag = `type=${msg.type} from=${msg.fromName}(${msg.fromUid}) to=${msg.toName}(${msg.toUid}) mid=${msg.mid} time=${fmtTime(msg.time)}`
  // 用户诊断 2026-07-13：dump 函数条件过严，type=3（图片）等非 1/9/10 时文本不显示。
  // 修复：无论 type，只要 msg.text 存在就同步到浮动 logBox。
  if (msg.text) {
    appendLog(`   📝 text: ${JSON.stringify(msg.text)}`)
  }
  if (msg.type === 1 && msg.text) {
    console.log(`${POC_TAG} text  ${tag} text=${JSON.stringify(msg.text)}`)
  } else if (msg.type === 9 && msg.jobDesc) {
    const j = msg.jobDesc
    console.log(`${POC_TAG} job   ${tag} title=${JSON.stringify(j.title)} company=${JSON.stringify(j.company)} salary=${JSON.stringify(j.salary)} jobId=${j.jobId}`)
  } else if (msg.type === 10 && msg.resume) {
    const r = msg.resume
    console.log(`${POC_TAG} resume ${tag} user=${JSON.stringify(r.user)} city=${JSON.stringify(r.city)} position=${JSON.stringify(r.position)} descLen=${r.description?.length ?? 0}`)
  } else {
    console.log(`${POC_TAG} other ${tag} rawType=${msg.type}`)
  }
}

export function main(): void {
  // 自我诊断 1：document.title 不会被 console.clear 冲掉
  document.title = `${POC_TAG} loaded @ ${new Date().toISOString()}`
  console.log(`${POC_TAG} activating WebSocket hook (chat-only)`)
  activate({
    shouldHook: (url) => url.includes('chat'),
    onMessage: (data) => {
      const newCount = ++msgCount
      // 1) 把"任何形式"的入参写到 logBox（先别判定格式）
      const kind =
        data instanceof ArrayBuffer ? 'ArrayBuffer' :
        data instanceof Uint8Array ? 'Uint8Array' :
        typeof data === 'string' ? 'string' :
        data && typeof data === 'object' ? (data as { constructor?: { name?: string } }).constructor?.name ?? 'object' :
        typeof data
      let bytes: Uint8Array | null = null
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
      else if (data instanceof Uint8Array) bytes = data
      else if (data instanceof Blob) bytes = new Uint8Array([])  // we can't await here
      const size = bytes?.byteLength ?? (typeof data === 'string' ? data.length : -1)
      const firstHex = bytes ? toHex(bytes) : (typeof data === 'string' ? data.slice(0, 64) : '')
      appendLog(
        `[${new Date().toISOString()}] #${newCount} kind=${kind} size=${size} ` +
          `first=${firstHex}${typeof data === 'string' ? ` str="${firstHex}"` : ''}`,
      )

      if (!bytes) {
        document.title = `${POC_TAG} msgs=${newCount} kind=${kind}`
        return data
      }

      // 2) 尝试 protobuf 解码 + 报告结果
      try {
        const messages = decodeBossProtocol(bytes)
        const decodedOk = messages.filter((m) => m.type !== 0).length
        const lastType = messages[0]?.type ?? null
        const firstText = messages[0]?.text
        const preview = firstText ? ` text="${firstText.slice(0, 24)}..."` : ''
        document.title = `${POC_TAG} msgs=${newCount} decoded=${decodedOk} lastType=${lastType ?? '-'}${preview}`
        appendLog(`   → decode OK: ${messages.length} msgs, types=${messages.map((m) => m.type).join(',')}`)
        for (const m of messages) dump(m)
      } catch (err) {
        const errMsg = (err as Error).message
        // ⚠ Sprint 2026-07-13 / 用户的诊断（采纳）：
        //   size <= 8 + illegal tag / out of range 几乎都是 BOSS MQTT-style 控制包（心跳/重连）
        //   不计入 DECODE_FAILED，也不写 document.title 与 console.warn
        if (
          bytes.length <= 8 &&
          (errMsg.includes('illegal tag') || errMsg.includes('index out of range'))
        ) {
          appendLog(`   → Control frame / Heartbeat (size=${bytes.length}, hex=${firstHex.slice(0, 12)})`)
        } else {
          document.title = `${POC_TAG} msgs=${newCount} DECODE_FAILED ${errMsg.slice(0, 30)}`
          appendLog(`   → decode FAILED: ${errMsg}`)
          console.warn(`${POC_TAG} decode failed`, errMsg)
        }
      }
      // 返回原始字节（不修改 BOSS 内部行为）
      return data
    },
  })
  console.log(`${POC_TAG} hook installed. open a chat page to see messages.`)
  document.title = `${POC_TAG} hook installed @ ${new Date().toISOString()}`

  // self-diagnostic: expose for console quick-check
  ;(globalThis as unknown as { __bossPocLoaded?: boolean }).__bossPocLoaded = true
}

// 立即执行
main()
