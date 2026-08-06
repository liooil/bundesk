# WebView2 SDK tooling

Dev-only artifacts for the WebView2 window provider. Nothing here ships in the package.

- `extract-vtables.ts` — downloads `Microsoft.Web.WebView2` from NuGet, extracts the official
  `WebView2.h`, and prints the COM vtable method order for the interfaces the shim hand-declares.
  Run: `bun webview2-sdk/extract-vtables.ts`

The runtime is discovered WITHOUT the official WebView2Loader.dll: the shim reads the runtime
version from the EdgeUpdate Clients registry key
(`{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`), locates
`<runtime>\EBWebView\x64\EmbeddedBrowserWebView.dll`, and calls its
`CreateWebViewEnvironmentWithOptionsInternal` export directly. That export is undocumented but
de-facto ABI-stable — it is the exact dependency the official loader uses (its env-creation
path is GetProcAddress on this export plus a direct call), so this approach carries no
stability delta versus shipping the loader binary.
