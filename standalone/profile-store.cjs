const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const MAX_PERSONA_CHARS = 64 * 1024
const MAX_IMPORT_CHARS = 256 * 1024
const MEMORY_CATEGORIES = new Set(['identity', 'preference', 'relationship', 'instruction', 'event', 'general'])
const MEMORY_PROVIDERS = new Set(['local', 'opencode'])
const INDEX_STOP_TERMS = new Set(['今天', '昨天', '明天', '现在', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '还是', '然后', '已经', '就是', '一个', '一下', '我的', '你的', '他的', '她的', '记得'])

function cleanLine(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 64) : fallback
}

function cleanDocument(value, max = MAX_PERSONA_CHARS) {
  if (typeof value !== 'string') return ''
  return value.replace(/\u0000/g, '').trim().slice(0, max)
}

function normalizedMemory(value) {
  return cleanDocument(value, MAX_IMPORT_CHARS).normalize('NFKC').toLowerCase()
    .replace(/^#{1,6}\s+/gm, '').replace(/^>\s*更新于.*$/gm, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function memoryHash(value) {
  return crypto.createHash('sha256').update(normalizedMemory(value)).digest('hex')
}

function memoryKeywords(value) {
  const text = normalizedMemory(value)
  const ascii = new Set(text.match(/[a-z0-9_]{2,}/g) || [])
  const han = { 2: new Set(), 3: new Set(), 4: new Set() }
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i <= run.length - size; i++) {
        const term = run.slice(i, i + size)
        if (!INDEX_STOP_TERMS.has(term)) han[size].add(term)
      }
    }
  }
  return [
    ...[...ascii].slice(0, 100),
    ...[...han[2]].slice(0, 250),
    ...[...han[3]].slice(0, 150),
    ...[...han[4]].slice(0, 100),
  ]
}

function inferMemoryCategory(name, text) {
  const value = `${name || ''}\n${text || ''}`.toLowerCase()
  if (/身份|名字|姓名|生日|住在|identity|profile|name/.test(value)) return 'identity'
  if (/喜欢|讨厌|偏好|习惯|爱好|preference|prefer|likes?/.test(value)) return 'preference'
  if (/朋友|家人|亲人|关系|同事|主人|relationship|family|friend/.test(value)) return 'relationship'
  if (/请记住|以后|总是|永远|不要|必须|称呼|instruction|always|never|remember/.test(value)) return 'instruction'
  if (/今天|昨天|曾经|一起|发生|event|diary/.test(value)) return 'event'
  return 'general'
}

function modelLabel(model) {
  const normalized = String(model || '').replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  const folder = parts.length > 1 ? parts.at(-2) : ''
  const file = (parts.at(-1) || '桌宠').replace(/\.model3\.json$/i, '')
  return cleanLine(folder || file, '桌宠')
}

function validId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)
}

function createProfileStore({ dataDir }) {
  const root = path.join(dataDir, 'profiles')
  const activeFile = path.join(root, 'active.json')
  const diaryNames = new Map()

  const profileDir = id => path.join(root, id)
  const profileFile = id => path.join(profileDir(id), 'profile.json')
  const personaFile = id => path.join(profileDir(id), 'persona.md')
  const memoryFile = id => path.join(profileDir(id), 'memory.md')
  const memoriesDir = id => path.join(profileDir(id), 'memories')
  const memoryIndexFile = id => path.join(memoriesDir(id), 'index.json')
  const extractionFile = id => path.join(memoriesDir(id), 'extractions.json')
  const diariesDir = id => path.join(profileDir(id), 'diaries')

  async function readJson(file, fallback = null) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return fallback }
  }

  async function readMeta(id) {
    if (!validId(id)) return null
    const raw = await readJson(profileFile(id))
    if (!raw || raw.id !== id || typeof raw.model !== 'string') return null
    return {
      id,
      name: cleanLine(raw.name, modelLabel(raw.model)),
      model: raw.model.slice(0, 512),
      memoryProvider: MEMORY_PROVIDERS.has(raw.memoryProvider) ? raw.memoryProvider : 'local',
      autoDiary: raw.autoDiary === true,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    }
  }

  async function list() {
    await fsp.mkdir(root, { recursive: true })
    const entries = await fsp.readdir(root, { withFileTypes: true })
    const profiles = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !validId(entry.name)) continue
      const meta = await readMeta(entry.name)
      if (meta) profiles.push(meta)
    }
    return profiles.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  async function activeId() {
    const raw = await readJson(activeFile, {})
    return validId(raw?.id) ? raw.id : ''
  }

  async function activate(id) {
    const meta = await readMeta(id)
    if (!meta) throw new Error('角色档案不存在')
    await fsp.mkdir(root, { recursive: true })
    await fsp.writeFile(activeFile, JSON.stringify({ id, updatedAt: new Date().toISOString() }, null, 2) + '\n')
    return get(id)
  }

  async function get(id = '') {
    const targetId = validId(id) ? id : await activeId()
    const meta = await readMeta(targetId)
    if (!meta) return null
    const persona = await fsp.readFile(personaFile(targetId), 'utf8').catch(() => '')
    return {
      ...meta,
      persona: cleanDocument(persona),
      storage: {
        root: profileDir(targetId),
        memory: memoryFile(targetId),
        memories: memoriesDir(targetId),
        memoryIndex: memoryIndexFile(targetId),
        diaries: diariesDir(targetId),
      },
    }
  }

  async function save(input = {}) {
    const existing = validId(input.id) ? await readMeta(input.id) : null
    const id = existing?.id || crypto.randomUUID()
    const model = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim().slice(0, 512)
      : existing?.model || ''
    if (!model || model.includes('\0')) throw new Error('角色档案必须绑定模型')
    const now = new Date().toISOString()
    const meta = {
      id,
      name: cleanLine(input.name, existing?.name || modelLabel(model)),
      model,
      memoryProvider: MEMORY_PROVIDERS.has(input.memoryProvider) ? input.memoryProvider : existing?.memoryProvider || 'local',
      autoDiary: input.autoDiary === undefined ? existing?.autoDiary === true : input.autoDiary === true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    await Promise.all([
      fsp.mkdir(diariesDir(id), { recursive: true }),
      fsp.mkdir(memoriesDir(id), { recursive: true }),
    ])
    await fsp.writeFile(profileFile(id), JSON.stringify(meta, null, 2) + '\n')
    if (input.persona !== undefined) {
      await fsp.writeFile(personaFile(id), cleanDocument(input.persona) + '\n', 'utf8')
    } else if (!fs.existsSync(personaFile(id))) {
      await fsp.writeFile(personaFile(id), '', 'utf8')
    }
    if (!fs.existsSync(memoryFile(id))) await fsp.writeFile(memoryFile(id), '', 'utf8')
    if (!fs.existsSync(memoryIndexFile(id))) await fsp.writeFile(memoryIndexFile(id), '[]\n', 'utf8')
    if (!fs.existsSync(extractionFile(id))) await fsp.writeFile(extractionFile(id), '[]\n', 'utf8')
    return activate(id)
  }

  async function readMemoryIndex(id) {
    const raw = await readJson(memoryIndexFile(id), [])
    if (!Array.isArray(raw)) return []
    return raw.filter(entry => entry && typeof entry === 'object'
      && typeof entry.id === 'string' && /^[a-f0-9-]{36}$/i.test(entry.id)
      && typeof entry.hash === 'string' && /^[a-f0-9]{64}$/i.test(entry.hash)
      && typeof entry.file === 'string' && /^memory-[a-z0-9._-]+\.md$/i.test(entry.file))
      .map(entry => ({
        id: entry.id,
        category: MEMORY_CATEGORIES.has(entry.category) ? entry.category : 'general',
        source: cleanLine(entry.source, '导入记忆'),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
        hash: entry.hash,
        file: entry.file,
        keywords: Array.isArray(entry.keywords) ? entry.keywords.filter(item => typeof item === 'string').slice(0, 600) : [],
      }))
  }

  async function ensureForModel(model) {
    const profiles = await list()
    const current = await get()
    if (current?.model === model) return current
    const match = profiles.find(item => item.model === model)
    if (match) return activate(match.id)
    return save({ name: modelLabel(model), model, memoryProvider: 'local', autoDiary: false, persona: '' })
  }

  async function importText(id, kind, name, content) {
    const profile = await get(id)
    if (!profile) throw new Error('角色档案不存在')
    const text = cleanDocument(content, MAX_IMPORT_CHARS)
    if (!text) throw new Error('导入内容为空')
    if (kind === 'persona') {
      await fsp.writeFile(personaFile(profile.id), text + '\n', 'utf8')
      return { kind, file: 'persona.md' }
    }
    if (kind === 'memory') {
      await fsp.mkdir(memoriesDir(profile.id), { recursive: true })
      const index = await readMemoryIndex(profile.id)
      if (!normalizedMemory(text)) throw new Error('记忆内容没有可检索文字')
      const hash = memoryHash(text)
      const legacy = await fsp.readFile(memoryFile(profile.id), 'utf8').catch(() => '')
      const duplicate = index.some(entry => entry.hash === hash) || normalizedMemory(legacy).includes(normalizedMemory(text))
      if (duplicate) return { kind, duplicate: true }
      const id = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const source = cleanLine(name, '导入记忆')
      const category = inferMemoryCategory(source, text)
      const file = `memory-${createdAt.replace(/[:.]/g, '-').toLowerCase()}-${id.slice(0, 8)}.md`
      await fsp.writeFile(path.join(memoriesDir(profile.id), file), `# ${source}\n\n${text}\n`, 'utf8')
      index.push({ id, category, source, createdAt, updatedAt: createdAt, hash, file, keywords: memoryKeywords(text) })
      await fsp.writeFile(memoryIndexFile(profile.id), JSON.stringify(index, null, 2) + '\n', 'utf8')
      return { kind, file, category, duplicate: false }
    }
    if (kind === 'diary') {
      await fsp.mkdir(diariesDir(profile.id), { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const base = cleanLine(String(name || '').replace(/\.(md|txt)$/i, ''), '导入日记').replace(/[<>:"/\\|?*]/g, '_')
      const file = `imported-${stamp}-${base}-${crypto.randomUUID().slice(0, 8)}.md`
      await fsp.writeFile(path.join(diariesDir(profile.id), file), text + '\n', 'utf8')
      return { kind, file }
    }
    throw new Error('不支持的导入类型')
  }

  async function saveDiary(summary) {
    const profile = await get()
    if (!profile) throw new Error('没有启用的角色档案')
    const text = cleanDocument(summary, 12000)
    if (!text) throw new Error('日记内容为空')
    await fsp.mkdir(diariesDir(profile.id), { recursive: true })
    let file = diaryNames.get(profile.id)
    if (!file) {
      const now = new Date()
      const pad = value => String(value).padStart(2, '0')
      file = `diary-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`
      diaryNames.set(profile.id, file)
    }
    const generated = new Date().toLocaleString('zh-CN', { hour12: false })
    await fsp.writeFile(path.join(diariesDir(profile.id), file), `# ${profile.name}的日记\n\n> 更新于 ${generated}\n\n${text}\n`, 'utf8')
    return { ok: true, file, profileId: profile.id }
  }

  async function listDiaryEntries(id, limit = 40) {
    const profile = await get(id)
    if (!profile) throw new Error('角色档案不存在')
    const names = await fsp.readdir(diariesDir(profile.id)).catch(() => [])
    const entries = []
    for (const file of names.filter(name => name.toLowerCase().endsWith('.md'))) {
      const target = path.join(diariesDir(profile.id), file)
      const [raw, stat] = await Promise.all([
        fsp.readFile(target, 'utf8').catch(() => ''),
        fsp.stat(target).catch(() => null),
      ])
      const content = cleanDocument(raw.replace(/^#{1,6}[^\n]*\n+/, '').replace(/^>\s*更新于[^\n]*\n+/m, ''), 12000)
      if (!content) continue
      entries.push({ file, content, updatedAt: stat?.mtimeMs || 0,
        sourceHash: crypto.createHash('sha256').update(`${file}\n${raw}`).digest('hex') })
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(80, Number(limit) || 40)))
  }

  async function listMemoryEntries(id, limit = 40) {
    const profile = await get(id)
    if (!profile) throw new Error('角色档案不存在')
    const index = await readMemoryIndex(profile.id)
    const selected = index.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .slice(0, Math.max(1, Math.min(80, Number(limit) || 40)))
    const result = []
    for (const entry of selected) {
      const raw = await fsp.readFile(path.join(memoriesDir(profile.id), entry.file), 'utf8').catch(() => '')
      const content = cleanDocument(raw.replace(/^#{1,6}[^\n]*\n+/, ''), 600)
      if (content) result.push({ id: entry.id, category: entry.category, content })
    }
    return result
  }

  async function extractionProcessed(id, sourceHash) {
    if (!validId(id) || !/^[a-f0-9]{64}$/i.test(sourceHash || '')) return false
    const hashes = await readJson(extractionFile(id), [])
    return Array.isArray(hashes) && hashes.includes(sourceHash)
  }

  async function commitMemories(id, items, sourceHashes = []) {
    const profile = await get(id)
    if (!profile) throw new Error('角色档案不存在')
    if (!Array.isArray(items) || items.length > 20) throw new Error('记忆候选数量不正确')
    const index = await readMemoryIndex(profile.id)
    const byId = new Map(index.map(entry => [entry.id, entry]))
    let added = 0
    let replaced = 0
    let skipped = 0
    for (const raw of items) {
      const content = cleanDocument(raw?.content, 1000)
      if (!normalizedMemory(content)) { skipped++; continue }
      const category = MEMORY_CATEGORIES.has(raw?.category) ? raw.category : inferMemoryCategory('', content)
      const hash = memoryHash(content)
      const replaceId = validId(raw?.replaceId) ? raw.replaceId : ''
      if (raw?.replaceId && (!replaceId || !byId.has(replaceId))) { skipped++; continue }
      const duplicate = index.find(entry => entry.hash === hash && entry.id !== replaceId)
      if (duplicate) { skipped++; continue }
      const now = new Date().toISOString()
      if (replaceId && byId.has(replaceId)) {
        const entry = byId.get(replaceId)
        await fsp.writeFile(path.join(memoriesDir(profile.id), entry.file), `# ${entry.source || '日记提炼'}\n\n${content}\n`, 'utf8')
        Object.assign(entry, { category, hash, keywords: memoryKeywords(content), updatedAt: now })
        replaced++
      } else {
        const memoryId = crypto.randomUUID()
        const file = `memory-${now.replace(/[:.]/g, '-').toLowerCase()}-${memoryId.slice(0, 8)}.md`
        await fsp.writeFile(path.join(memoriesDir(profile.id), file), `# 日记提炼\n\n${content}\n`, 'utf8')
        const entry = { id: memoryId, category, source: '日记提炼', createdAt: now, updatedAt: now,
          hash, file, keywords: memoryKeywords(content) }
        index.push(entry)
        byId.set(memoryId, entry)
        added++
      }
    }
    await fsp.writeFile(memoryIndexFile(profile.id), JSON.stringify(index, null, 2) + '\n', 'utf8')
    const completedHashes = (Array.isArray(sourceHashes) ? sourceHashes : [sourceHashes])
      .filter(value => /^[a-f0-9]{64}$/i.test(value || '')).slice(0, 40)
    if (completedHashes.length) {
      const hashes = await readJson(extractionFile(profile.id), [])
      const next = Array.isArray(hashes) ? hashes.filter(value => typeof value === 'string') : []
      for (const sourceHash of completedHashes) if (!next.includes(sourceHash)) next.push(sourceHash)
      await fsp.writeFile(extractionFile(profile.id), JSON.stringify(next.slice(-200), null, 2) + '\n', 'utf8')
    }
    return { ok: true, added, replaced, skipped, profileId: profile.id }
  }

  return { root, list, get, save, activate, ensureForModel, importText, saveDiary, listDiaryEntries,
    listMemoryEntries, extractionProcessed, commitMemories }
}

module.exports = { createProfileStore }
