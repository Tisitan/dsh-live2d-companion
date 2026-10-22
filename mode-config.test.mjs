import assert from 'node:assert/strict'
import test from 'node:test'
import { rewriteLive2dConfig } from './index.js'

test('mode update preserves following patch operations and nested keys', () => {
  const source = `- insert:
    - id: live2d-companion
      name: dsh-live2d-companion
      config:
        model: pack/model.model3.json
        widget: true
        nested:
          pet: untouched
        pet: false
- update:
    id: another-plugin
    config:
      widget: untouched
      pet: untouched
`
  const changed = rewriteLive2dConfig(source, { widget: false, pet: true })
  assert.ok(changed.includes('        widget: false\n        pet: true\n'))
  assert.ok(changed.includes('          pet: untouched'))
  assert.ok(changed.endsWith('- update:\n    id: another-plugin\n    config:\n      widget: untouched\n      pet: untouched\n'))
  assert.ok(changed.includes('model: pack/model.model3.json'))
  assert.equal(rewriteLive2dConfig(changed, { widget: false, pet: true }), changed)
})

test('missing config gets correct mapping indentation and unsupported layouts fail safely', () => {
  assert.equal(rewriteLive2dConfig('-   id: live2d-companion\n    config:\n      widget: true\n      pet: false', { widget: false, pet: true }),
    '-   id: live2d-companion\n    config:\n      widget: false\n      pet: true')
  assert.equal(rewriteLive2dConfig('- id: live2d-companion', { widget: true, pet: false }),
    '- id: live2d-companion\n  config:\n    widget: true\n    pet: false')
  assert.equal(rewriteLive2dConfig('- id: live2d-companion\n  config: {widget: true}', { widget: false, pet: true }), undefined)
  assert.equal(rewriteLive2dConfig('- id: live2d-companion\n- id: live2d-companion', { widget: true, pet: false }), undefined)
  assert.equal(rewriteLive2dConfig('- id: other', { widget: true, pet: false }), undefined)
})
