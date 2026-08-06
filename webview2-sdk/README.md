# WebView2 SDK tooling

Dev-only artifacts for the WebView2 spike (`feat/webview2` branch). Nothing here ships in the package.

- `extract-vtables.ts` — downloads `Microsoft.Web.WebView2` from NuGet, extracts the official
  `WebView2.h`, and prints the COM vtable method order for the interfaces the shim hand-declares.
  Run: `bun webview2-sdk/extract-vtables.ts`

The `WebView2Loader.dll` used at runtime lives at `src/webview2-loader.dll`
(win-x64 from the NuGet `runtimes/win-x64/native/WebView2Loader.dll`). It is
imported with `with { type: 'file' }` and embedded into the compiled single
binary by `bun build --compile` — no base64 in the repo.
