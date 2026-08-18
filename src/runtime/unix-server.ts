import { isSecondInstanceRequest } from './single-instance'

type FetchHandler<WebSocketData = undefined> = (
  this: Bun.Server<WebSocketData>,
  request: Request,
  server: Bun.Server<WebSocketData>,
) => Response | Promise<Response> | void | Promise<void>

/**
 * Add the token-authenticated single-instance endpoint as a fallback fetch
 * handler without replacing Bun's native routes table. This also handles
 * proxy-style absolute-form requests produced by Bun 1.3 when `fetch({ unix })`
 * runs with HTTP_PROXY/HTTPS_PROXY set: uWebSockets does not match those in its
 * path router, but Bun normalizes `request.url` before invoking fetch.
 */
export function withUnixIpc<WebSocketData = undefined, Routes extends string = string>(
  options: Bun.Serve.Options<WebSocketData, Routes>,
  ipc: (request: Request) => Response | Promise<Response>,
): Bun.Serve.Options<WebSocketData, Routes> {
  const fallback = options.fetch as FetchHandler<WebSocketData> | undefined
  return {
    ...options,
    async fetch(request, server) {
      if (isSecondInstanceRequest(request)) return ipc(request)
      if (fallback) return (await fallback.call(server, request, server)) ?? new Response('Not found', { status: 404 })
      return new Response('Not found', { status: 404 })
    },
  }
}
