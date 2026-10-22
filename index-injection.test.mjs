import assert from 'node:assert/strict'
import test from 'node:test'
import { Script } from 'node:vm'
import { mountPlugin } from './tests/plugin-harness.mjs'

test('桌面引导为可序列化的 body 脚本，重复收集不增加行', t => {
  const host = mountPlugin(t, { widget: true })
  const existing = { kind: 'style', text: 'body { margin: 0 }' }
  const rows = host.collect([existing])
  assert.equal(rows.length, 2)
  assert.equal(rows[0], existing)
  assert.deepEqual(Object.keys(rows[1]).sort(), ['kind', 'placement', 'text'])
  assert.equal(rows[1].kind, 'script')
  assert.equal(rows[1].placement, 'body')
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows)
  assert.doesNotThrow(() => new Script(rows[1].text))
  host.collect(rows)
  assert.equal(rows.length, 2)
  assert.doesNotThrow(() => host.collect(null))
  assert.doesNotThrow(() => host.collect({}))
})

test('HTTP 挂件引导仍可用，重复渲染保留单个模块标签', t => {
  const host = mountPlugin(t, {})
  assert.equal(host.collect().length, 1)
  const html = host.render('<html><body><main>DSH</main></body></html>')
  assert.equal(html, '<html><body><main>DSH</main><script src="/live2d/boot.js" type="module"></script></body></html>')
  assert.equal(host.render(html), html)
})

test('关闭 widget 时两个宿主通道都不注入', t => {
  const host = mountPlugin(t, { widget: false })
  const html = '<html><body><main>DSH</main></body></html>'
  assert.equal(host.events.has('webserver/index-inject'), false)
  assert.deepEqual(host.collect(), [])
  assert.equal(host.render(html), html)
})
