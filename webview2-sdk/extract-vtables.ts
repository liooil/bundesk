const header = await Bun.file('webview2-sdk/WebView2.h').text()
const lines = header.split('\n')
const targets = [
  ['ICoreWebView2Environment', ['CreateCoreWebView2Controller']],
  ['ICoreWebView2Controller', ['put_IsVisible', 'get_CoreWebView2', 'put_Bounds', 'Close']],
  ['ICoreWebView2', ['Navigate', 'NavigateToString', 'add_NavigationCompleted', 'ExecuteScript', 'PostWebMessageAsJson', 'add_WebMessageReceived', 'get_Settings', 'Stop']],
  ['ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler', ['Invoke']],
  ['ICoreWebView2CreateCoreWebView2ControllerCompletedHandler', ['Invoke']],
  ['ICoreWebView2WebMessageReceivedEventHandler', ['Invoke']],
  ['ICoreWebView2NavigationCompletedEventHandler', ['Invoke']],
  ['ICoreWebView2ExecuteScriptCompletedHandler', ['Invoke']],
  ['ICoreWebView2WebMessageReceivedEventArgs', ['get_WebMessageAsJson']],
  ['ICoreWebView2NavigationCompletedEventArgs', ['get_IsSuccess', 'get_WebErrorStatus']],
]
const dumpFull = new Set(['ICoreWebView2Environment', 'ICoreWebView2Controller', 'ICoreWebView2'])
const methodRe = /STDMETHODCALLTYPE \*(\w+)\s*\)/
for (const [iface, want] of targets) {
  const start = lines.findIndex((l) => l.includes(`typedef struct ${iface}Vtbl`))
  if (start === -1) {
    console.log(iface, ': NOT FOUND')
    continue
  }
  const end = lines.findIndex((l, i) => i > start && l.includes(`} ${iface}Vtbl;`))
  const methods: string[] = []
  for (let i = start; i < (end === -1 ? start + 500 : end); i++) {
    const m = lines[i].match(methodRe)
    if (m) methods.push(m[1])
  }
  const out: Record<string, number | string> = {}
  for (const w of want) {
    const idx = methods.indexOf(w)
    out[w] = idx === -1 ? 'MISSING' : idx
  }
  console.log(iface, 'vtbl methods:', methods.length, JSON.stringify(out))
  if (dumpFull.has(iface)) console.log(iface, 'FULL:', methods.join(','))
}
