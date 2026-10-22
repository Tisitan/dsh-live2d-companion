/** Keep authentication in Electron's main process and browser cookie session. */
function createHostAuth({ session, target, authUrl = '' }) {
  const origin = new URL(target).origin
  if (!/^https?:$/.test(new URL(target).protocol)) throw new Error('Unsupported DSH host protocol')
  let bootstrapUrl = null
  if (authUrl) {
    const parsed = new URL(authUrl)
    if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.username || parsed.password
      || parsed.hash || parsed.searchParams.getAll('token').length !== 1
      || [...parsed.searchParams.keys()].some((key) => key !== 'token')) {
      throw new Error('Invalid DSH authentication bootstrap URL')
    }
    bootstrapUrl = parsed.href
  }
  let pending = null
  const request = (url) => session.fetch(url, {
    credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000),
  })
  const release = async (response) => { try { await response.body?.cancel() } catch { } }
  const fetchState = () => request(origin + '/live2d/state')
  const ensureAuthenticated = () => {
    if (pending) return pending
    pending = (async () => {
      const current = await fetchState()
      await release(current)
      if (current.ok) return
      if (current.status !== 401 || !bootstrapUrl) throw new Error('DSH authentication unavailable; restart the pet from the host')
      // Root login exchanges the launch token for the persistent host cookie.
      // The URL is never sent to a renderer, logged, or stored in the PID file.
      const login = await request(bootstrapUrl)
      await release(login)
      if (!login.ok) throw new Error('DSH authentication failed; restart the pet from the host')
      const verified = await fetchState()
      await release(verified)
      if (!verified.ok) throw new Error('DSH authentication verification failed')
    })().finally(() => { pending = null })
    return pending
  }
  return { ensureAuthenticated, fetchState }
}
module.exports = { createHostAuth }
