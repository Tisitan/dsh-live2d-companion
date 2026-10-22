/** Apply the host's authenticated browser/API admission to every plugin route. */
export function createAuthenticatedRegistrar(ctx) {
  return (route) => ctx.webServer.register({
    ...route,
    handler(req, res) {
      let rejection
      try {
        const connection = ctx.connection
        if (typeof connection?.requestRejection !== 'function') rejection = 503
        else rejection = connection.requestRejection(req)
      } catch {
        // Do not print request headers, cookies, or token-bearing URLs.
        rejection = 503
      }
      if (rejection !== undefined) {
        const status = rejection === 401 || rejection === 403 ? rejection : 503
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(status === 503 ? 'Live2D requires the DSH connection authentication service.\n'
          : status === 401 ? 'DSH authentication required; reopen the host login URL.\n' : 'forbidden\n')
        return
      }
      return route.handler(req, res)
    },
  })
}
