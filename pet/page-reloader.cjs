// 一次加载失败可能同时触发 Electron 事件和 Promise 拒绝，统一重试入口避免计时器倍增。
function createPageReloader({ load, isClosed = () => false, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null
  let retryTimer = null
  let attempts = 0
  let disposed = false
  const cancelRetry = () => {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
  }
  const loaded = () => {
    attempts = 0
    cancelRetry()
  }
  const schedule = () => {
    if (disposed || isClosed() || retryTimer !== null) return
    const delay = Math.min(30000, 2000 * 2 ** attempts++)
    retryTimer = setTimer(() => {
      retryTimer = null
      void reload()
    }, delay)
  }
  const reload = () => {
    if (disposed || isClosed()) return Promise.resolve()
    if (pending) return pending
    cancelRetry()
    pending = Promise.resolve().then(() => {
      if (!disposed && !isClosed()) return load()
    }).then(loaded).catch(error => {
      if (disposed || isClosed()) return
      onError(error)
      schedule()
    }).finally(() => { pending = null })
    return pending
  }
  return {
    reload, schedule, loaded,
    dispose() { disposed = true; cancelRetry() },
  }
}
module.exports = { createPageReloader }
