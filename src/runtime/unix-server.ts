import { isSecondInstanceRequest } from './single-instance'

type FetchHandler<WebSocketData = undefined> = (
  this: Bun.Server<WebSocketData>,
  request: Request,
  server: Bun.Server<WebSocketData>,
) => Response | Promise<Response> | void | Promise<void>

/**
 * Add the token-authenticated single-instance endpoint as a fallback fetch
 * handler without replacing Bun's native routes table.
 *
 * Bun 1.3.14 compatibility: when `HTTP_PROXY`/`HTTPS_PROXY` is set,
 * `fetch(url, { unix })` connects to the unix socket but writes a proxy-style
 * absolute-form request target (`GET http://host/path HTTP/1.1`). Its native
 * uWebSockets path router does not match that target, while the fallback fetch
 * receives a normalized `request.url` and can still dispatch the IPC request.
 *
 * Bun 1.4.0-canary.1+4c689909e still emits absolute-form on the wire, but its
 * router uses `getUrlForRouting()` to extract the path, so native routes and
 * HTML bundles work. Keep this fallback while BunDesk supports Bun 1.3.14.
 * Once Bun 1.4.0 is stable and the minimum version becomes `>=1.4.0`, register
 * `/second-instance` as a native route and remove this proxy-compatibility
 * fallback.
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
