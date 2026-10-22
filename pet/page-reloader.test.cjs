const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createPageReloader } = require('./page-reloader.cjs')

function clock() {
  let nextId = 0
  const timers = new Map()
  return {
    timers,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id },
    clearTimer(id) { timers.delete(id) },
    fire() {
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      timer.callback()
    },
  }
}

test('一次失败的事件和 Promise 拒绝共用一个重试，成功后重置退避', async () => {
  const time = clock()
  let succeeds = false
  let calls = 0
  const reloader = createPageReloader({ ...time, async load() {
    calls++
    if (!succeeds) {
      reloader.schedule() // 模拟 did-fail-load 先于 loadURL 拒绝。
      throw new Error('failed')
    }
  } })
  await reloader.reload()
  assert.equal(calls, 1)
  assert.equal(time.timers.size, 1)
  assert.equal([...time.timers.values()][0].delay, 2000)
  time.fire()
  await reloader.reload()
  assert.equal(calls, 2)
  assert.equal(time.timers.size, 1)
  assert.equal([...time.timers.values()][0].delay, 4000)
  succeeds = true
  await reloader.reload()
  assert.equal(time.timers.size, 0)
  reloader.schedule()
  assert.equal([...time.timers.values()][0].delay, 2000)
  reloader.dispose()
})

test('健康检查和计时器不会并发加载，关闭后未决失败不再重试', async () => {
  const time = clock()
  let rejectLoad
  let calls = 0
  const reloader = createPageReloader({ ...time, load() {
    calls++
    return new Promise((_, reject) => { rejectLoad = reject })
  } })
  const pending = reloader.reload()
  assert.equal(reloader.reload(), pending)
  await Promise.resolve()
  reloader.schedule()
  assert.equal(time.timers.size, 1)
  reloader.dispose()
  assert.equal(time.timers.size, 0)
  rejectLoad(new Error('closed during load'))
  await pending
  await reloader.reload()
  reloader.schedule()
  assert.equal(calls, 1)
  assert.equal(time.timers.size, 0)
})
