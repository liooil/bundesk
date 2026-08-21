/**
 * Add the token-authenticated single-instance endpoint to Bun's native routes
 * table. Bun 1.4 routes proxy-style absolute-form Unix requests correctly, so
 * the Bun 1.3 fallback fetch handler is no longer needed.
 */
export function withUnixIpc<WebSocketData = undefined, Routes extends string = string>(
  options: Bun.Serve.Options<WebSocketData, Routes>,
  ipc: (request: Request) => Response | Promise<Response>,
): Bun.Serve.Options<WebSocketData, Routes> {
  return {
    ...options,
    routes: {
      ...options.routes,
      '/second-instance': { POST: ipc },
    },
  } as Bun.Serve.Options<WebSocketData, Routes>
}
