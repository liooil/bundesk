# WebView2 SDK tooling

Dev-only artifacts for the WebView2 window provider. Nothing here ships in the package.

- `extract-vtables.ts` — downloads `Microsoft.Web.WebView2` from NuGet, extracts the official
  `WebView2.h`, and prints the COM vtable method order for the interfaces the shim hand-declares.
  Run: `bun webview2-sdk/extract-vtables.ts`

The `WebView2Loader.dll` used at runtime is NOT stored in the repository. It is provisioned on
first use by `src/runtime/webview2-loader.ts` (downloaded from the
`Microsoft.Web.WebView2` NuGet package, version + SHA-256 pinned) and materialized at
`src/webview2-loader.dll` (gitignored), which `bun build --compile` then embeds into the single
binary. To update the loader version, change `WEBVIEW2_LOADER_VERSION` and `LOADER_SHA256` in
that module, or regenerate the pinned values from the NuGet `runtimes/win-x64/native/WebView2Loader.dll`.
