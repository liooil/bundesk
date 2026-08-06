declare module '*.c' {
  const source: string
  export default source
}

declare module '*.dll' {
  const path: string
  export default path
}
