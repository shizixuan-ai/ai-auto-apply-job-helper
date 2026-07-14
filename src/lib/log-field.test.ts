// ============================================================
// src/lib/log-field.test.ts — TDD RED（先写失败测试）
// ============================================================
// 目的：调试打印 helper，统一截断策略，**绝对不静默截断**
// 教训：2026-07-14 fetchJobDetail 调试时 .slice(0,20) 误导归因
// 纪律：~/.claude/CLAUDE.md §3.8 + memory feedback_debug_root_cause_discipline
// ============================================================

import { describe, it, expect } from 'vitest'
import { logField } from './log-field.js'

describe('logField', () => {
  describe('短字符串（≤ 80 字符）', () => {
    it('完整输出', () => {
      expect(logField('name', 'hello')).toBe('name=hello')
    })

    it('空字符串输出空', () => {
      expect(logField('empty', '')).toBe('empty=')
    })

    it('边界值 80 字符完整输出', () => {
      const s = 'a'.repeat(80)
      expect(logField('len80', s)).toBe(`len80=${s}`)
    })
  })

  describe('长字符串（> 80 字符）', () => {
    it('输出 name + length + head/tail 预览', () => {
      const s = 'a'.repeat(100)
      const result = logField('long', s)
      // 必须包含长度信息（不能静默截断）
      expect(result).toContain('long=')
      expect(result).toContain('length=100')
      // head = maxLen/2 = 40
      expect(result).toContain('a'.repeat(40)) // head 预览
    })

    it('绝对不静默截断（不输出 "..." 假装完整）', () => {
      const s = 'securityId_' + 'x'.repeat(200)
      const result = logField('sid', s)
      // 必须包含完整长度信息
      expect(result).toContain('length=' + s.length)
      // 不能只输出前 20 字符（之前的 .slice(0,20) bug）
      expect(result).not.toBe('sid=' + s.slice(0, 20) + '...')
      // 不能以 '...' 结尾假装完整
      expect(result).not.toMatch(/\.\.\.$/)
    })
  })

  describe('数字/布尔/null/undefined', () => {
    it('数字直接输出', () => {
      expect(logField('count', 42)).toBe('count=42')
    })

    it('布尔 true', () => {
      expect(logField('flag', true)).toBe('flag=true')
    })

    it('布尔 false', () => {
      expect(logField('flag', false)).toBe('flag=false')
    })

    it('null', () => {
      expect(logField('n', null)).toBe('n=null')
    })

    it('undefined', () => {
      expect(logField('u', undefined)).toBe('u=undefined')
    })

    it('0 输出 "count=0"（不输出空字符串）', () => {
      expect(logField('count', 0)).toBe('count=0')
    })

    it('负数', () => {
      expect(logField('temp', -5)).toBe('temp=-5')
    })
  })

  describe('对象', () => {
    it('简单对象 JSON.stringify', () => {
      expect(logField('obj', { a: 1 })).toBe('obj={"a":1}')
    })

    it('嵌套对象', () => {
      expect(logField('nested', { a: { b: 2 } })).toBe('nested={"a":{"b":2}}')
    })

    it('对象过长时输出 length', () => {
      const obj = { data: 'x'.repeat(500) }
      const result = logField('big', obj)
      expect(result).toContain('length=')
    })
  })

  describe('数组', () => {
    it('数组 JSON.stringify', () => {
      expect(logField('arr', [1, 2, 3])).toBe('arr=[1,2,3]')
    })

    it('空数组', () => {
      expect(logField('empty', [])).toBe('empty=[]')
    })
  })

  describe('自定义 maxLen', () => {
    it('maxLen=200 短字符串仍完整', () => {
      expect(logField('x', 'hello', { maxLen: 200 })).toBe('x=hello')
    })

    it('maxLen=10 长字符串截断但输出 length', () => {
      const s = 'a'.repeat(50)
      const result = logField('x', s, { maxLen: 10 })
      expect(result).toContain('length=50')
      expect(result).toContain('x=')
    })
  })

  describe('安全保证', () => {
    it('长对象在 length 字段', () => {
      // 用一个明显 > 80 的对象
      const obj = { data: 'x'.repeat(200) }
      const result = logField('big', obj)
      expect(result).toContain('length=' + JSON.stringify(obj).length)
    })

    it('字段名带特殊字符不抛错', () => {
      expect(() => logField('field-with-dash', 'x')).not.toThrow()
    })
  })
})