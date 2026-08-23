const fsp = require('node:fs/promises')
const path = require('node:path')

const MAX_FILE_BYTES = 512 * 1024
const MAX_CONTEXT_CHARS = 1200
const MAX_INDEXED_CANDIDATES = 80
const MAX_SEMANTIC_CANDIDATES = 12
const MAX_SEMANTIC_CHARS = 5000
const STOP_TERMS = new Set([
  '今天', '昨天', '明天', '现在', '刚才', '我们', '你们', '他们', '大家', '这个', '那个',
  '什么', '怎么', '为何', '为什么', '可以', '还是', '然后', '已经', '就是', '一个', '一下',
  '我的', '你的', '他的', '她的', '它的', '记得', '知道', '觉得', '目前', '当前',
  'the', 'and', 'that', 'this', 'with', 'what', 'when', 'where', 'how', 'your', 'about',
])
const CATEGORY_LABELS = {
  identity: '身份', preference: '偏好', relationship: '关系', instruction: '长期约定', event: '经历', general: '长期记忆',
}

function terms(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase()
  const result = new Set((text.match(/[a-z0-9_]{2,}/g) || []).filter(term => !STOP_TERMS.has(term)))
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i <= run.length - size; i++) {
        const term = run.slice(i, i + size)
        if (!STOP_TERMS.has(term)) result.add(term)
      }
    }
  }
  return result
}

function termWeight(term) {
  if (/^[a-z0-9_]+$/i.test(term)) return 3
  return Math.max(2, Math.min(4, [...term].length))
}

function scoreTerms(candidateTerms, queryTerms) {
  let score = 0
  let matches = 0
  for (const term of queryTerms) {
    if (!candidateTerms.has(term)) continue
    score += termWeight(term)
    matches++
  }
  return { score, matches }
}

function preferredCategory(query) {
  const value = String(query || '').toLowerCase()
  if (/名字|姓名|身份|生日|住哪|是谁|name|identity/.test(value)) return 'identity'
  if (/喜欢|讨厌|偏好|爱好|习惯|prefer|like/.test(value)) return 'preference'
  if (/朋友|家人|关系|同事|主人|family|friend|relationship/.test(value)) return 'relationship'
  if (/约定|要求|以后|不要|必须|称呼|remember|always|never/.test(value)) return 'instruction'
  if (/发生|上次|以前|曾经|一起|哪次|event/.test(value)) return 'event'
  return ''
}

function chunksFrom(text, source, mtime = 0, category = 'general') {
  return String(text || '').split(/\n\s*\n+/).map(value => value.trim())
    .filter(value => value && !/^#{1,6}\s+.{1,80}$/.test(value) && !/^>\s*更新于/.test(value))
    .map(value => ({ source, category, text: value.slice(0, 700), mtime }))
}

async function readLimited(file) {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile() || stat.size === 0) return { text: '', mtime: 0 }
  if (stat.size <= MAX_FILE_BYTES) return { text: await fsp.readFile(file, 'utf8').catch(() => ''), mtime: stat.mtimeMs }
  const handle = await fsp.open(file, 'r').catch(() => null)
  if (!handle) return { text: '', mtime: stat.mtimeMs }
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES)
    await handle.read(buffer, 0, buffer.length, stat.size - buffer.length)
    return { text: buffer.toString('utf8'), mtime: stat.mtimeMs }
  } finally {
    await handle.close()
  }
}

async function indexedMemories(profile, queryTerms, broad = false) {
  if (!profile.storage.memories || !profile.storage.memoryIndex) return []
  const raw = await fsp.readFile(profile.storage.memoryIndex, 'utf8').catch(() => '')
  let index = []
  try { index = JSON.parse(raw) } catch { }
  if (!Array.isArray(index)) return []
  const selected = index.map(entry => {
    const indexedTerms = new Set(Array.isArray(entry?.keywords) ? entry.keywords : [])
    return { entry, ...scoreTerms(indexedTerms, queryTerms) }
  }).filter(item => item.entry && (broad || item.matches > 0) && typeof item.entry.file === 'string'
    && /^memory-[a-z0-9._-]+\.md$/i.test(item.entry.file))
    .sort((a, b) => b.score - a.score || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || '')))
    .slice(0, broad ? 24 : MAX_INDEXED_CANDIDATES)
  const candidates = []
  for (const item of selected) {
    const loaded = await readLimited(path.join(profile.storage.memories, item.entry.file))
    if (!loaded.text) continue
    candidates.push(...chunksFrom(loaded.text, item.entry.source || item.entry.file, loaded.mtime, item.entry.category || 'general'))
  }
  return candidates
}

function rankCandidates(candidates, queryTerms, query, limit = 4) {
  const wantedCategory = preferredCategory(query)
  return candidates.map(item => {
    const matched = scoreTerms(terms(item.text), queryTerms)
    const categoryBonus = wantedCategory && item.category === wantedCategory ? 2 : 0
    return { ...item, score: matched.score + categoryBonus, matches: matched.matches }
  }).filter(item => item.matches > 0 && item.score >= 2)
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime)
    .slice(0, limit)
}

function formatMemory(items, maxChars = MAX_CONTEXT_CHARS) {
  const output = []
  let used = 0
  for (const item of items) {
    const label = CATEGORY_LABELS[item.category] || item.source
    const block = `【${label} · ${item.source}】\n${item.text}`
    if (used + block.length > maxChars) continue
    output.push(block)
    used += block.length + 2
  }
  return output.join('\n\n')
}

function semanticPool(candidates, ranked) {
  const priority = new Map(ranked.map((item, index) => [item.text, index]))
  const selected = [...candidates].sort((a, b) => {
    const aRank = priority.has(a.text) ? priority.get(a.text) : 999
    const bRank = priority.has(b.text) ? priority.get(b.text) : 999
    return aRank - bRank || b.mtime - a.mtime
  })
  const result = []
  const seen = new Set()
  let used = 0
  for (const item of selected) {
    const text = item.text.trim()
    if (!text || seen.has(text)) continue
    const label = CATEGORY_LABELS[item.category] || item.source
    const block = `【${label} · ${item.source}】\n${text}`
    if (used + block.length > MAX_SEMANTIC_CHARS) continue
    result.push({ id: `M${result.length + 1}`, text: block })
    seen.add(text)
    used += block.length
    if (result.length >= MAX_SEMANTIC_CANDIDATES) break
  }
  return result
}

class LocalMemoryProvider {
  async recallBundle(profile, query) {
    if (!profile?.storage || !String(query || '').trim()) return { memory: '', candidates: [] }
    const queryTerms = terms(query)
    if (!queryTerms.size) return { memory: '', candidates: [] }
    const semantic = profile.memoryProvider === 'opencode'
    const candidates = await indexedMemories(profile, queryTerms, semantic)
    const legacy = await readLimited(profile.storage.memory)
    if (legacy.text) candidates.push(...chunksFrom(legacy.text, '旧版长期记忆', legacy.mtime, 'general'))
    const diaryEntries = await fsp.readdir(profile.storage.diaries, { withFileTypes: true }).catch(() => [])
    const diaryFiles = []
    for (const entry of diaryEntries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      const target = path.join(profile.storage.diaries, entry.name)
      const stat = await fsp.stat(target).catch(() => null)
      if (stat?.isFile()) diaryFiles.push({ target, name: entry.name, mtime: stat.mtimeMs })
    }
    diaryFiles.sort((a, b) => b.mtime - a.mtime)
    for (const item of diaryFiles.slice(0, 30)) {
      const loaded = await readLimited(item.target)
      if (loaded.text) candidates.push(...chunksFrom(loaded.text, item.name.replace(/\.md$/i, ''), item.mtime, 'event'))
    }
    const ranked = rankCandidates(candidates, queryTerms, query)
    return {
      memory: formatMemory(ranked),
      candidates: semantic ? semanticPool(candidates, ranked) : [],
    }
  }

  async recall(profile, query) {
    return (await this.recallBundle(profile, query)).memory
  }
}

function createMemoryProvider(profile) {
  // Provider boundary: plugin/MCP implementations can be added without changing profile or chat UI.
  if (!profile || profile.memoryProvider === 'local') return new LocalMemoryProvider()
  return new LocalMemoryProvider()
}

module.exports = { LocalMemoryProvider, createMemoryProvider }
