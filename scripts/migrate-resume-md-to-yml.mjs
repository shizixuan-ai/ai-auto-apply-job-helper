#!/usr/bin/env node
// ============================================================
// migrate-resume-md-to-yml.mjs — 一次性迁移工具
// ============================================================
// Sprint 1B：从老的 简历.md（H2 分段格式）迁移到 简历.yml（YAML 1.2）
//
// 行为：
//   1. 读 简历.md（如果存在）
//   2. 按 H2 分段解析（复用 md-fallback 解析逻辑的 inline 版）
//   3. 转换到新的 YAML 格式
//   4. 推断字段默认值：
//        - isElite: false  （候选人最清楚自己，应手工 review）
//        - isBigTech: false
//   5. 写 简历.yml
//   6. 提示用户补全推断字段
//   7. 删 简历.md
//
// 用法：
//   npx tsx scripts/migrate-resume-md-to-yml.mjs
//
// 安全策略：
//   - 简历.yml 已存在 → 拒绝覆盖（提示用户先备份或手动合并）
//   - 简历.md 不存在 → 退出（无需迁移）
//   - 解析失败 → 抛错，不写 yml
// ============================================================

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

const MD_PATH = '简历.md'
const YML_PATH = '简历.yml'

// ============================================================
// 解析 简历.md（H2 分段）
// ============================================================

function parseMd(content) {
  const lines = content.split('\n')
  const sections = {}
  let currentKey = null
  let currentLines = []

  const flush = () => {
    if (currentKey !== null) {
      sections[currentKey] = currentLines.join('\n').trim()
    }
  }

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/)
    if (m) {
      flush()
      currentKey = m[1].trim()
      currentLines = []
    } else if (currentKey !== null) {
      currentLines.push(line)
    }
  }
  flush()

  // 工作年限：必须是数字
  let yearsOfExperience
  const yearsRaw = sections['工作年限']?.trim()
  if (yearsRaw) {
    const n = Number(yearsRaw)
    if (Number.isFinite(n)) yearsOfExperience = n
  }

  // 技能：逗号分隔
  const skillsRaw = sections['技能']?.trim()
  const skills = skillsRaw
    ? skillsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    : undefined

  // 近期项目：- 列表
  const projectsRaw = sections['近期项目']?.trim()
  const recentProjects = projectsRaw
    ? projectsRaw
        .split('\n')
        .map((line) => line.replace(/^-\s*/, '').trim())
        .filter(Boolean)
    : undefined

  return {
    姓名: sections['姓名']?.trim() || undefined,
    工作年限: yearsOfExperience,
    学历: sections['学历']?.trim() || undefined,
    skills,
    recentProjects,
  }
}

// ============================================================
// 转换到 YAML 结构
// ============================================================

function toYaml(parsed) {
  const lines = []
  lines.push('# ============================================================')
  lines.push('# 简历主文件 — 由 scripts/migrate-resume-md-to-yml.mjs 自动生成')
  lines.push('# Sprint 1B 强切（2026-07-19）')
  lines.push('# ============================================================')
  lines.push('# ⚠️  请补全以下字段（候选人最清楚自己）：')
  lines.push('#   - 是否985_211: false   ← 查教育部 2022 名单')
  lines.push('#   - 是否大厂背景: false   ← 阿里/腾讯/字节/美团/京东/华为/拼多多/网易/滴滴/小米')
  lines.push('# ============================================================')
  lines.push('')

  // 基础信息
  lines.push('基础信息:')
  lines.push(`  姓名: ${parsed.姓名 || '你的姓名'}`)
  lines.push('  性别: ""')
  lines.push('  年龄: 0')
  lines.push('  手机号: ""')
  lines.push('  邮箱: ""')
  lines.push('')

  // 求职意向（可选）
  lines.push('求职意向:')
  lines.push('  目标岗位: ""')
  lines.push('')

  // 学历 — 旧格式是 "本科（华北理工大学 · 全日制 · 2012.9-2016.6）"
  //       新格式拆分为 school + degree
  const 学历Raw = parsed.学历 || ''
  const 学历Match = 学历Raw.match(/^([^（(]+)（?(.*)?$/)
  const degree = 学历Match ? 学历Match[1].trim() : 学历Raw
  lines.push('教育背景:')
  // 尝试从 "本科（华北理工大学 · ..." 中提取学校
  const schoolMatch = 学历Raw.match(/[（(]([^·（(]+)/)
  const school = schoolMatch ? schoolMatch[1].trim() : ''
  lines.push(`  毕业院校: ${school}`)
  lines.push(`  学历层次: ${degree}`)
  lines.push('  专业名称: ""')
  lines.push('')

  // 推断字段（默认 false，候选人手工 review）
  lines.push('# 是否 985/211（顶层必填 boolean）')
  lines.push('#   候选人最清楚自己 — 请查 教育部 2022 名单（139 所）后改成正确值')
  lines.push('是否985_211: false')
  lines.push('')

  // 工作经历
  lines.push('工作经历:')
  lines.push(`  工作年限: ${parsed.工作年限 ?? 0}`)
  lines.push('# 是否大厂背景（必填 boolean）— 阿里/腾讯/字节/美团/京东/华为/拼多多/网易/滴滴/小米')
  lines.push('  是否大厂背景: false')
  lines.push('  经历: []  # array of objects: { 公司, 时间段, 职位, 描述 }')
  lines.push('')

  // 技能清单
  lines.push('技能清单:')
  if (parsed.skills && parsed.skills.length > 0) {
    for (const s of parsed.skills) {
      lines.push(`  - ${s}`)
    }
  } else {
    lines.push('  - （请填写）')
  }
  lines.push('')

  // 自我介绍
  lines.push('自我介绍: |')
  lines.push('  （可选）请用多行块写一段自我介绍。')
  lines.push('')

  return lines.join('\n')
}

// ============================================================
// 主流程
// ============================================================

function main() {
  // 1. 简历.md 不存在
  if (!existsSync(MD_PATH)) {
    console.log(`✅ ${MD_PATH} 不存在，无需迁移。`)
    if (existsSync(YML_PATH)) {
      console.log(`   ${YML_PATH} 已存在。`)
    } else {
      console.log(`   可运行: cp 简历.yml.example ${YML_PATH}`)
    }
    process.exit(0)
  }

  // 2. 简历.yml 已存在 → 拒绝覆盖
  if (existsSync(YML_PATH)) {
    console.error(`❌ ${YML_PATH} 已存在，迁移工具拒绝覆盖。`)
    console.error(`   请先备份现有 yml，或手动合并：`)
    console.error(`     cp ${YML_PATH} ${YML_PATH}.bak`)
    console.error(`     rm ${YML_PATH}`)
    console.error(`     npx tsx scripts/migrate-resume-md-to-yml.mjs`)
    process.exit(1)
  }

  // 3. 解析 + 转换
  console.log(`📖 读取 ${MD_PATH} ...`)
  const mdContent = readFileSync(MD_PATH, 'utf8')
  const parsed = parseMd(mdContent)

  if (!parsed.姓名) {
    console.error(`❌ ${MD_PATH} 缺少「姓名」字段，无法迁移。`)
    process.exit(1)
  }

  console.log(`🔄 转换为 YAML 格式 ...`)
  const ymlContent = toYaml(parsed)

  // 4. 写 简历.yml
  writeFileSync(YML_PATH, ymlContent, 'utf8')
  console.log(`✅ 已生成 ${YML_PATH}`)
  console.log('')
  console.log('⚠️  必填字段已用 false 默认，请手工 review 并补全：')
  console.log('   1. 是否985_211  — 查教育部 2022 名单（139 所）')
  console.log('   2. 是否大厂背景 — 阿里/腾讯/字节/美团/京东/华为/拼多多/网易/滴滴/小米')
  console.log('   3. 工作经历.经历 — 改为 array of objects 格式（公司/时间段/职位/描述）')
  console.log('')

  // 5. 验证 yml 语法（用 yaml 包 parse 一次，确保写出来的 yml 可被 parser 读取）
  try {
    parseYaml(ymlContent)
    console.log('✅ YAML 语法校验通过')
  } catch (e) {
    console.error(`❌ 生成的 ${YML_PATH} YAML 语法有问题:`, e.message)
    console.error('   请手工检查后再跑 bapply')
    process.exit(1)
  }

  // 6. 删 简历.md
  unlinkSync(MD_PATH)
  console.log(`🗑️  已删除 ${MD_PATH}`)
  console.log('')
  console.log('迁移完成。运行 bapply 验证：')
  console.log('   npx tsx src/cli/index.ts search <keyword>')
}

main()
