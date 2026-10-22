import { apply } from '../index.js'

// 挂载真实插件并收集宿主接入点；不监听端口、不启动桌宠，可用 overrides 补充服务。
export function mountPlugin(t, config = {}, overrides = {}, applyPlugin = apply) {
  const events = new Map()
  const taps = []
  const routes = []
  const disposers = []
  let disposed = false
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    connection: { requestRejection() { return undefined } },
    on(event, listener) {
      const listeners = events.get(event) || []
      listeners.push(listener)
      events.set(event, listeners)
      const dispose = () => {
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    emit(event, ...args) {
      for (const listener of events.get(event) || []) listener(...args)
    },
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      port: 0,
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
      tapIndex(transform) {
        taps.push(transform)
        return () => {
          const index = taps.indexOf(transform)
          if (index !== -1) taps.splice(index, 1)
        }
      },
    },
    ...overrides,
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    for (const cleanup of disposers.reverse()) await cleanup()
  }
  t?.after(dispose)
  applyPlugin(ctx, { ...config, pet: false })
  return {
    ctx, events, taps, routes, dispose,
    collect(table = []) {
      ctx.emit('webserver/index-inject', table)
      return table
    },
    render(html) { return taps.reduce((result, transform) => transform(result), html) },
  }
}
