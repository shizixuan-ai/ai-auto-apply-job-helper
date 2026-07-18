// ============================================================
// src/browser/boss-ws/decoder.test.ts — Sprint 2026-07-13 PoC v3 RED
// ============================================================
//
// PoC v3：用 master 完整 7KB protoDefinition（拷贝自
//   ai-job-master/ai-job-hunting-ui/src/webSocket/protobuf.ts:46）
// 测试 fixture 用 Type.create + encode 自动对齐字段 id。
//
// 字段位置（master schema）：
//   - TechwolfChatProtocol.messages = 3
//   - TechwolfMessage.from = 1 (TechwolfUser object)
//   - TechwolfMessage.to = 2   (TechwolfUser object)
//   - TechwolfMessage.mid = 4  (int64)
//   - TechwolfMessage.time = 5 (int64)
//   - TechwolfMessage.body = 6 (TechwolfMessageBody object)
//   - TechwolfMessageBody.type = 1
//   - TechwolfMessageBody.text = 3   ← 文本字段
//   - TechwolfMessageBody.image = 5
//   - TechwolfMessageBody.jobDesc = 10
//   - TechwolfMessageBody.resume = 12
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest'
import * as protobuf from 'protobufjs'

// 与 decoder.ts 完全一致的 master protoDefinition（拷贝）
const PROTO_DEFINITION = `option java_package = "cn.techwolf.boss.chat";option java_outer_classname = "ChatProtocol";message TechwolfUser {required int64 uid = 1;optional string name = 2;optional string avatar = 3;}message TechwolfMessageBody {required int32 type = 1;required int32 templateId = 2;optional string text = 3;optional TechwolfImage image = 5;optional TechwolfJobDesc jobDesc = 10;optional TechwolfResume resume = 12;}message TechwolfImage {optional int64 iid = 1;optional TechwolfImageInfo tinyImage = 2;optional TechwolfImageInfo originImage = 3;}message TechwolfImageInfo {optional string url = 1;optional int32 width = 2;optional int32 height = 3;}message TechwolfJobDesc {optional string title = 1;optional string company = 2;optional string salary = 3;optional string url = 4;optional int64 jobId = 5;}message TechwolfResume {optional TechwolfUser user = 1;optional string description = 2;optional string city = 3;optional string position = 4;}message TechwolfMessage {required TechwolfUser from = 1;required TechwolfUser to = 2;required int32 type = 3;optional int64 mid = 4;optional int64 time = 5;required TechwolfMessageBody body = 6;}message TechwolfChatProtocol {required int32 type = 1;repeated TechwolfMessage messages = 3;}`

let root: protobuf.Root

beforeEach(() => {
  root = protobuf.parse(PROTO_DEFINITION).root
})

function encodeMsg(outer: Record<string, unknown>): Uint8Array {
  const T = root.lookupType('TechwolfChatProtocol')
  return T.encode(T.create(outer)).finish()
}

describe('decodeBossProtocol — PoC v3 RED', () => {
  it('RED gate: 函数存在', async () => {
    const mod = await import('./decoder.js')
    expect(typeof mod.decodeBossProtocol).toBe('function')
  })

  it('case 1: 解码 type=1 文本消息（master schema, text 在 body field 3）', async () => {
    const { decodeBossProtocol } = await import('./decoder.js')
    const buf = encodeMsg({
      type: 1,
      messages: [
        {
          from: { uid: '100', name: 'HR 张三' },
          to: { uid: '200', name: '我' },
          type: 1,
          mid: '1700000000001',
          time: 1700000000000,
          body: { type: 1, templateId: 1, text: '你好，方便聊聊吗？' },
        },
      ],
    })
    const out = decodeBossProtocol(new Uint8Array(buf))
    expect(out.length).toBe(1)
    expect(out[0].type).toBe(1)
    expect(out[0].fromName).toBe('HR 张三')
    expect(out[0].fromUid).toBe('100')
    expect(out[0].toName).toBe('我')
    expect(out[0].mid).toBe('1700000000001')
    expect(out[0].time).toBe(1700000000000)
    expect(out[0].text).toBe('你好，方便聊聊吗？')
  })

  it('case 2: 解码 type=9 职位消息（jobDesc 在 body field 10）', async () => {
    const { decodeBossProtocol } = await import('./decoder.js')
    const buf = encodeMsg({
      type: 1,
      messages: [
        {
          from: { uid: '300', name: 'HR 李四' },
          to: { uid: '200', name: '我' },
          type: 1,
          mid: '1700000000002',
          time: 1700000001000,
          body: {
            type: 9,
            templateId: 0,
            jobDesc: {
              title: 'Java 后端工程师',
              company: '某某公司',
              salary: '25-50K',
              jobId: 1001,
              url: 'https://www.zhipin.com/job/J001',  // master required
            },
          },
        },
      ],
    })
    const out = decodeBossProtocol(new Uint8Array(buf))
    expect(out[0].type).toBe(9)
    expect(out[0].jobDesc?.title).toBe('Java 后端工程师')
    expect(out[0].jobDesc?.company).toBe('某某公司')
    expect(out[0].jobDesc?.jobId).toBe('1001')
  })

  it('case 3: 解码 type=10 简历消息（resume 在 body field 12）', async () => {
    const { decodeBossProtocol } = await import('./decoder.js')
    const buf = encodeMsg({
      type: 1,
      messages: [
        {
          from: { uid: '400', name: '候选人张三' },
          to: { uid: '200', name: '我' },
          type: 1,
          mid: '1700000000003',
          time: 1700000002000,
          body: {
            type: 10,
            templateId: 0,
            resume: {
              user: { uid: '400', name: '候选人张三' },
              description: '5年 Java 经验',
              city: '北京',
              position: 'Java 后端',
            },
          },
        },
      ],
    })
    const out = decodeBossProtocol(new Uint8Array(buf))
    expect(out[0].type).toBe(10)
    expect(out[0].resume?.user).toBe('候选人张三')
    expect(out[0].resume?.city).toBe('北京')
  })

  it('case 4: 多消息一次性解码', async () => {
    const { decodeBossProtocol } = await import('./decoder.js')
    const buf = encodeMsg({
      type: 1,
      messages: [
        {
          from: { uid: '1', name: 'a' },
          to: { uid: '2', name: 'b' },
          type: 1, mid: '1', time: 1,
          body: { type: 1, templateId: 1, text: '第一条' },
        },
        {
          from: { uid: '2', name: 'b' },
          to: { uid: '1', name: 'a' },
          type: 1, mid: '2', time: 2,
          body: { type: 1, templateId: 1, text: '第二条' },
        },
      ],
    })
    const out = decodeBossProtocol(new Uint8Array(buf))
    expect(out.length).toBe(2)
    expect(out[0].text).toBe('第一条')
    expect(out[1].text).toBe('第二条')
  })

  it('case 5: 解码 type=3 图片消息（image 在 body field 5）', async () => {
    const { decodeBossProtocol } = await import('./decoder.js')
    const buf = encodeMsg({
      type: 1,
      messages: [
        {
          from: { uid: '500', name: 'HR 王五' },
          to: { uid: '200', name: '我' },
          type: 1, mid: '1700000000005', time: 1700000005000,
          body: {
            type: 3,
            templateId: 0,
            image: {
              originImage: { url: 'https://img.example.com/full.jpg', width: 1080, height: 1920 },
              tinyImage: { url: 'https://img.example.com/tiny.jpg', width: 100, height: 200 },
            },
          },
        },
      ],
    })
    const out = decodeBossProtocol(new Uint8Array(buf))
    expect(out[0].type).toBe(3)
    expect(out[0].image?.url).toBe('https://img.example.com/full.jpg')
    expect(out[0].image?.width).toBe(1080)
    // 图片消息没有 text 字段（确认）
    expect(out[0].text).toBeFalsy()
  })

  it('case 6: 解码 type=1 消息但 text 字段为空（image 消息时 body.text 为 undefined）', async () => {
    const { decodeBossProtocol } = await import('./decoder.js')
    const buf = encodeMsg({
      type: 1,
      messages: [
        {
          from: { uid: '600' },
          to: { uid: '200' },
          type: 1, mid: '6', time: 6,
          body: { type: 1, templateId: 1 },  // 没有 text
        },
      ],
    })
    const out = decodeBossProtocol(new Uint8Array(buf))
    expect(out[0].type).toBe(1)
    expect(out[0].text).toBeUndefined()
  })
})