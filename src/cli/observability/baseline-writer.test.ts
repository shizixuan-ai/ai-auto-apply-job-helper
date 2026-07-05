// ============================================================
// baseline-writer 单元测试（RED）
// ============================================================
// Sprint A — 拦截诊断：基线观测（被动）
//
// AC:
//   1. 写一条记录到 .claude/diagnose/baseline/<YYYY-MM-DD>.jsonl
//   2. IO 失败时降级（console.warn，不抛）
//   3. 同一天多次写入进同一文件（追加而非覆盖）
//   4. JSON schema 完整（所有必填字段存在且类型正确）
//
// 设计约束：测试必须 chdir 到 tmpDir，避免污染真实 .claude/ 目录
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeBaselineRecord, writeBaselineRecordSync, type BaselineRecord } from './baseline-writer.js'

/** 根据 ISO 日期生成 YYYY-MM-DD 文件名 */
function expectedFilePath(tmpDir: string, iso: string): string {
  const date = iso.slice(0, 10)
  return path.join(tmpDir, '.claude', 'diagnose', 'baseline', `${date}.jsonl`)
}

describe('writeBaselineRecord', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-writer-'))
    originalCwd = process.cwd()
    process.chdir(tmpDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ------------------------------------------------------------
  // AC 1: 正常写入一条记录
  // ------------------------------------------------------------
  it('正常写入一条记录到 .claude/diagnose/baseline/<date>.jsonl', async () => {
    const record: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'search',
      duration_ms: 1234,
      http_code: 200,
      result_count: 15,
      status: 'ok',
    }

    await writeBaselineRecord(record)

    const filePath = expectedFilePath(tmpDir, record.ts)
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.trim().split('\n')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual(record)
  })

  // ------------------------------------------------------------
  // AC 2: IO 失败时降级（不抛，只 warn）
  // ------------------------------------------------------------
  it('IO 失败时降级（console.warn，不抛异常）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Mock appendFile 模拟磁盘满
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC: disk full'))

    const record: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'search',
      duration_ms: 1234,
      http_code: 200,
      result_count: 15,
      status: 'ok',
    }

    // 关键断言：不应抛异常
    await expect(writeBaselineRecord(record)).resolves.toBeUndefined()

    // 关键断言：应有一次 warn（降级信号）
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/baseline/i)
  })

  // ------------------------------------------------------------
  // AC 3: 同一天多次写入进同一文件（追加而非覆盖）
  // ------------------------------------------------------------
  it('同一天多次写入都进同一文件（追加而非覆盖）', async () => {
    const baseRecord: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'search',
      duration_ms: 1234,
      http_code: 200,
      result_count: 15,
      status: 'ok',
    }

    await writeBaselineRecord({ ...baseRecord, ts: '2026-07-05T10:00:00.000Z', duration_ms: 100 })
    await writeBaselineRecord({ ...baseRecord, ts: '2026-07-05T11:00:00.000Z', duration_ms: 200 })
    await writeBaselineRecord({ ...baseRecord, ts: '2026-07-05T12:00:00.000Z', duration_ms: 300 })

    const filePath = expectedFilePath(tmpDir, baseRecord.ts)
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.trim().split('\n')

    expect(lines).toHaveLength(3)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed.map((r) => r.duration_ms)).toEqual([100, 200, 300])
  })

  // ------------------------------------------------------------
  // AC 4: JSON schema 完整（所有必填字段存在且类型正确）
  // ------------------------------------------------------------
  it('JSON schema 完整（所有必填字段存在且类型正确）', async () => {
    const record: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'greet',
      duration_ms: 2500,
      http_code: null, // http_code 允许 null（搜索阶段不发 HTTP）
      result_count: 0,
      status: 'fail',
      interrupted_reason: 'captcha',
    }

    await writeBaselineRecord(record)

    const filePath = expectedFilePath(tmpDir, record.ts)
    const content = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content.trim())

    // 必填字段存在
    expect(parsed).toHaveProperty('ts')
    expect(parsed).toHaveProperty('command')
    expect(parsed).toHaveProperty('duration_ms')
    expect(parsed).toHaveProperty('http_code')
    expect(parsed).toHaveProperty('result_count')
    expect(parsed).toHaveProperty('status')

    // 类型正确
    expect(typeof parsed.ts).toBe('string')
    expect(typeof parsed.command).toBe('string')
    expect(typeof parsed.duration_ms).toBe('number')
    expect(parsed.http_code).toBeNull()
    expect(typeof parsed.result_count).toBe('number')
    expect(parsed.status).toBe('fail')
    expect(parsed.interrupted_reason).toBe('captcha')
  })

  // ------------------------------------------------------------
  // AC 边界: 自动创建不存在的目录
  // ------------------------------------------------------------
  it('自动创建不存在的 .claude/diagnose/baseline 目录', async () => {
    // 确认目录确实不存在
    const dirPath = path.join(tmpDir, '.claude', 'diagnose', 'baseline')
    await expect(fs.access(dirPath)).rejects.toThrow()

    const record: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'search',
      duration_ms: 1234,
      http_code: 200,
      result_count: 15,
      status: 'ok',
    }

    await writeBaselineRecord(record)

    // 写入后目录应存在
    const stat = await fs.stat(dirPath)
    expect(stat.isDirectory()).toBe(true)
  })

  // ------------------------------------------------------------
  // AC 边界: err 非 Error 实例时也降级（String(err) 分支）
  // ------------------------------------------------------------
  it('IO 失败且 err 非 Error 实例时，String(err) 降级分支也被覆盖', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Mock appendFile reject 一个 string（非 Error 实例）
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce('plain string error')

    const record: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'search',
      duration_ms: 1234,
      http_code: 200,
      result_count: 15,
      status: 'ok',
    }

    await expect(writeBaselineRecord(record)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    // warn 信息应包含原始错误（String(err) 路径）
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/plain string error/)
  })
})

// ============================================================
// writeBaselineRecordSync — 同步版本（用于 process.exit 前）
// ============================================================
// 设计动机：async 版本在 process.exit() 前调用会丢（exit 不等 await）
// ============================================================

describe('writeBaselineRecordSync', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-sync-'))
    originalCwd = process.cwd()
    process.chdir(tmpDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('同步写入一条记录到指定文件', () => {
    const record: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'send',
      duration_ms: 500,
      http_code: null,
      result_count: 1,
      status: 'ok',
    }

    writeBaselineRecordSync(record)

    const filePath = path.join(tmpDir, '.claude', 'diagnose', 'baseline', '2026-07-05.jsonl')
    const content = fsSync.readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual(record)
  })

  it('同步写入失败时降级（console.warn，不抛）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Mock appendFileSync 抛错
    vi.spyOn(fsSync, 'appendFileSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })

    const record: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'send',
      duration_ms: 500,
      http_code: null,
      result_count: 0,
      status: 'fail',
    }

    // 关键断言：不应抛
    expect(() => writeBaselineRecordSync(record)).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/同步写入失败/)
  })

  it('同步写入多个记录都进同一文件（追加）', () => {
    const base: BaselineRecord = {
      ts: '2026-07-05T10:00:00.000Z',
      command: 'send',
      duration_ms: 500,
      http_code: null,
      result_count: 1,
      status: 'ok',
    }

    writeBaselineRecordSync({ ...base, duration_ms: 100 })
    writeBaselineRecordSync({ ...base, duration_ms: 200 })

    const filePath = path.join(tmpDir, '.claude', 'diagnose', 'baseline', '2026-07-05.jsonl')
    const content = fsSync.readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')

    expect(lines).toHaveLength(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed.map((r) => r.duration_ms)).toEqual([100, 200])
  })
})