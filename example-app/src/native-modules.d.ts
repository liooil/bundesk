// Mirrors src/webview2-shim.d.ts so the example's own typecheck resolves
// the framework's `with { type: 'file' }` imports of the C shims.
declare module '*.c' {
  const source: string
  export default source
}

declare module '*.dll' {
  const path: string
  export default path
}
