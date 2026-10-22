const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'chat.js'), 'utf8')
  .replace(/^import .*\r?\n/, '').replace('export function initChat', 'function initChat')
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function fixture() {
  const elements = new Map()
  class Element {
    constructor() {
      this.listeners = new Map()
      this.children = []
      this.style = {}
      this.dataset = {}
      this.classList = { add() {}, remove() {}, toggle() {} }
      this.hidden = false
      this.value = ''
    }
    set id(value) { this._id = value; elements.set(value, this) }
    get id() { return this._id }
    set innerHTML(value) {
      this.children = []
      for (const match of value.matchAll(/id="([^"]+)"/g)) { const child = new Element(); child.id = match[1]; this.children.push(child) }
    }
    querySelector(selector) { return elements.get(selector.slice(1)) }
    querySelectorAll() { return [] }
    addEventListener(event, handler) { this.listeners.set(event, handler) }
    dispatch(event, data = {}) { return this.listeners.get(event)?.({ preventDefault() {}, stopPropagation() {}, ...data }) }
    append(...children) { this.children.push(...children) }
    appendChild(child) { this.children.push(child) }
    replaceChildren(...children) { this.children = children }
    setAttribute() {}
    remove() {}
    focus() {}
  }
  const a = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'A', persona: 'A persona', autoDiary: false }
  const b = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'B', persona: 'B persona', autoDiary: false }
  let active = a
  const calls = []
  const overrides = new Map()
  const events = new Map()
  const response = data => ({ ok: true, status: 200, json: async () => data })
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body, method: options.method || 'GET' })
    if (overrides.has(url)) return overrides.get(url)(body)
    if (url.endsWith('/companion-profiles')) {
      if (body) active = { ...active, ...body }
      return response({ active: { ...active } })
    }
    if (url.endsWith('/chat/status')) return response({ profileId: active.id, profileName: active.name, connected: true })
    if (url.endsWith('/diary/summarize')) return response({ profileId: body.profileId, summary: 'summary' })
    if (url.endsWith('/diary/save')) return response({ ok: true, file: 'diary.md', profileId: body.profileId })
    if (url.endsWith('/chat')) return response({ reply: `${active.name} reply` })
    throw new Error('Unexpected route: ' + url)
  }
  const ctx = {
    on: (event, fn) => events.set(event, fn),
    enter() {}, showBubble() {}, evalIgnore() {}, modelBounds: () => null,
  }
  const sandbox = {
    BASE: '/live2d', PET: true, STANDALONE: true, BRIDGE: null,
    document: { createElement: () => new Element(), head: new Element(), body: new Element() },
    window: { innerWidth: 1000, innerHeight: 800 },
    fetch, AbortController, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, requestAnimationFrame() {},
  }
  vm.runInNewContext(source + '\nglobalThis.init = initChat', sandbox)
  sandbox.init(ctx)
  await flush()
  return {
    a, b, calls, overrides, response,
    switchTo(profile) { active = profile; events.get('profile')(profile) },
    element: id => elements.get('l2d-' + id),
    async chat(text) { elements.get('l2d-chat-input').value = text; await elements.get('l2d-chat-form').dispatch('submit') },
    history: () => elements.get('l2d-chat-history').children.map(line => line.children.at(-1).textContent),
  }
}

test('switching characters keeps chat and diary transcripts within their owner', async () => {
  const f = await fixture()
  await f.chat('A private message')
  f.switchTo(f.b)
  assert.deepEqual(f.history(), [])
  await f.chat('B message')
  f.element('diary-save').dispatch('click')
  await flush()
  const summary = f.calls.find(call => call.url.endsWith('/diary/summarize'))
  assert.equal(summary.body.profileId, f.b.id)
  assert.deepEqual(summary.body.messages.map(item => item.text), ['B message', 'B reply'])
  assert.equal(f.calls.find(call => call.url.endsWith('/diary/save')).body.profileId, f.b.id)
  f.switchTo(f.a)
  assert.deepEqual(f.history(), ['A private message', 'A reply'])
})

test('a profile switch cancels the save after a delayed diary summary', async () => {
  const f = await fixture()
  await f.chat('A private message')
  const pending = deferred()
  f.overrides.set('/live2d/diary/summarize', () => pending.promise)
  f.element('diary-save').dispatch('click')
  await flush()
  f.switchTo(f.b)
  pending.resolve(f.response({ profileId: f.a.id, summary: 'A private diary' }))
  await flush()
  assert.equal(f.calls.some(call => call.url.endsWith('/diary/save')), false)
  f.element('diary-auto').checked = true
  await f.element('diary-auto').dispatch('change')
  const update = f.calls.find(call => call.url.endsWith('/companion-profiles') && call.method === 'POST')
  assert.deepEqual(update.body, { id: f.b.id, expectedActiveId: f.b.id, autoDiary: true })
})

test('an old in-flight chat reply is retained only in its original character history', async () => {
  const f = await fixture()
  const pending = deferred()
  f.overrides.set('/live2d/chat', () => pending.promise)
  const submitting = f.chat('A pending message')
  await flush()
  f.switchTo(f.b)
  pending.resolve(f.response({ reply: 'A late reply' }))
  await submitting
  assert.deepEqual(f.history(), [])
  f.switchTo(f.a)
  assert.deepEqual(f.history(), ['A pending message', 'A late reply'])
})
