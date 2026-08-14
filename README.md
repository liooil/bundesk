# BunDesk

> [中文](README.zh-CN.md) · **English**

**Turn local web apps into desktop applications that start fast, build fast and are easy to debug — with Bun and the system browser.**

BunDesk is a desktop application framework for Bun — not just an EXE packaging script. The name is **Bun + Desktop**. The framework handles the HTTP server, browser windows, single instance, automatic updates, Windows file associations and Start Menu integration as one unit, while keeping the low-level composable API available.

## Why BunDesk

### Fast builds

A BunDesk release build is a single `Bun.build({ compile })`: TypeScript, the server, browser assets and the Bun runtime are compiled straight into a single-file executable. There is no Rust/C++ desktop shell to compile and no Chromium to bundle, which skips the heaviest steps of Tauri's native dependency builds and Electron's renderer/runtime packaging.

Actual build time still depends on application size, plugins and network cache; record a CI baseline in your specific project. BunDesk's framework tests actually build and run Windows/Linux executables rather than only testing configuration objects.
### The deliverable is a single binary

BunDesk compiles the Bun runtime, the server and the frontend assets imported by the entrypoint into a single platform executable; releasing means copying just that one binary. Even when Electron provides a single-file installer, it usually expands after installation into an app directory containing Electron/Chromium, `app.asar`, DLLs, locale and resources. BunDesk carries no browser directory, and app data is stored in the current user's data directory per the runtime convention, never mixed into the release.

Real-project benchmarks record the number of release files, the total size after unpacking/installing, and the compressed download size, so the comparison is not based only on the installer's single-file appearance.

### Direct debugging

In development the app is an ordinary Bun HTTP server and an ordinary web page:

- server code runs directly under Bun, so existing TypeScript debugging techniques work;
- the UI is debugged with the browser's DevTools, no custom debugging bridge;
- `--no-browser` starts only the server, so you can debug with any browser or API client;
- app routes, Bun plugins, and Vite/Tailwind and Worker build logic all stay in the app repository.

### Cross-compilation support

Windows x64/ARM64 single-file EXEs can be produced on Linux CI. BunDesk downloads a Windows runtime of the **same version** as the building Bun, writes icon, version resources and manifest cross-platform first, then completes the Bun compile via `executablePath`. A Windows build machine is not required.

> The current artifact is a directly distributable single-file EXE. MSI, MSIX and installer wizards are not 0.1 artifact formats.

### No bundled Chromium

At runtime BunDesk prefers an installed Microsoft Edge, Google Chrome or Chromium and opens it as a standalone app window via `--app=<url>`. If none is installed, it launches Firefox with an isolated, tracked profile; the system URL opener is the final fallback. Every selection or failure is logged. The payoff is smaller releases, less renderer update burden and a shorter packaging pipeline.

## Positioning vs Electron / Tauri

| | BunDesk | Electron | Tauri |
| --- | --- | --- | --- |
| App backend | Bun | Node.js | Rust + optional sidecar |
| Renderer | System Chromium/Firefox or native WebView | Bundled Chromium | System WebView |
| Main release-build path | Bun bundle + compile | JS bundle + Electron packaging | Frontend build + Rust/native compile |
| Windows single-file EXE from Linux | Yes | Depends on target packaging config | Usually needs an extra cross toolchain |
| Debugging | Bun + browser DevTools | Electron DevTools | WebView DevTools + Rust debugging |
| Native capabilities | Bun/Node API + Windows integration module | Electron API | Tauri plugins/Rust |

BunDesk suits tool-style desktop apps built around a local HTTP service plus a Web UI. When you need deeply native UI, OS-level sandboxing or a Chromium version pinned to the app, pick a solution that matches better.

## Core features

- `createDesktopApp(...)` hosts the server, windows and lifecycle in one place;
- low-level composable APIs such as `launchAppWindow(...)`;
- standalone Edge/Chrome/Chromium `--app=<url>` windows (Brave included on macOS); Termux uses the Android VIEW intent;
- loopback IPC single instance with a random 256-bit token;
- secondary instances forward `argv`, `cwd` and PID to the primary instance's callback;
- two update providers: static binary URL/ETag/SHA-256 and GitHub Releases;
- download verification, atomic replacement, rollback on failure, restart and cleanup of old versions;
- system notifications (Windows WinRT toast via a PowerShell bridge; Linux notify-send / macOS osascript / Termux termux-notification);
- system tray (implemented on Windows: pure bun:ffi against Win32, no native compilation);
- service registration (headless `serve` daemon): Windows HKCU Run key, Linux systemd user unit, macOS launchd LaunchAgent, Termux boot script;
- Windows per-user file associations, default open behavior and Start Menu shortcuts;
- Linux XDG file associations, desktop entries and mimeapps registration (register/unregister/status);
- macOS `.app` packaging: Info.plist, UTI/document types, URL schemes, icons and ad-hoc codesign;
- three Windows console strategies: `detached` / `hidden` / `inherit`;
- cross-compiling from Linux to Windows x64, baseline x64 and ARM64, as well as macOS x64/ARM64 `.app`;
- build artifact size and SHA-256 output.

## Installation

```bash
bun add -d bundesk
```

The package name `bundesk` is used directly with Bun:

```ts
import { createDesktopApp, defineConfig } from 'bundesk'
```

Requires Bun 1.3.14 or newer.

## Runtime quick start

The app entrypoint:

```ts
import {
  createDesktopApp,
  githubReleaseProvider,
} from 'bundesk'

const app = createDesktopApp({
  id: 'my-company.my-app',
  version: '1.2.3',

  server: {
    hostname: '127.0.0.1',
    port: 0,
    routes: {
      '/': new Response('<h1>My App</h1>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      '/api/health': Response.json({ ok: true }),
    },
  },

  window: {
    path: '/',
    preferred: 'edge',
    exitWithWindow: true,
  },

  singleInstance: {},
  async onSecondInstance(event, context) {
    console.log('Second launch:', event.argv, event.cwd)
    await context.launchWindow()
  },

  updates: {
    currentVersion: '1.2.3',
    provider: githubReleaseProvider({
      owner: 'OWNER',
      repository: 'REPOSITORY',
      assetName: {
        'windows-x64': 'my-app.exe',
        'linux-x64': 'my-app',
        'darwin-arm64': 'My App.app.zip',
      },
    }),
    checkOnStartup: false,
  },

  desktopIntegration: {
    fileAssociations: [{
      extension: '.demo',
      progId: 'MyCompany.MyApp.Document',
      description: 'My App Document',
    }],
    startMenuShortcut: {
      name: 'My App',
      description: 'Open My App',
    },
  },
})

await app.run()
```

The framework reserves the following app commands:

```text
my-app                         start the server and a browser window
my-app --help                  print help generated from the config, then exit
my-app --version               print the application name and version, then exit
my-app --browser               force the system browser provider
my-app --pwa                   open the configured installed Chromium PWA
my-app --webview               force the platform-native in-process WebView
my-app --provider pwa          explicitly select browser, pwa, or webview
my-app <file>                  start, or forward the file argument to the primary instance
my-app serve --no-browser      start only the HTTP server
my-app register [--default]    register per-user file associations and a launcher
my-app unregister              undo the registration
my-app status                  show desktop integration status
my-app install-service         register as an auto-start service (headless serve)
my-app uninstall-service       remove the service registration
my-app service-status          show service status
my-app upgrade [--force]       check for, install and restart after an upgrade
```

`-h` is equivalent to `--help`, and `-V` to `--version`. Use `cli.name`, `cli.description`, and `cli.options` to customize the displayed name, description, and application-specific options; framework commands are listed automatically.

`register` only writes `HKCU` and requires no administrator privileges. `--default` writes the per-user default ProgID for the extension, but does not bypass Windows' `UserChoice` protection.

## Example app

[`example-app/`](example-app/) is a runnable showcase of the framework,
packaged into per-platform executables by the CI pipeline (it is not part of
the npm package). It demonstrates:

- a **fullstack page** (HTML import route — hot-reload in dev, AOT in the
  compiled binary)
- **window providers**: `webview` on Windows, `webkit` on Linux, `browser`
  elsewhere — picked at runtime from `process.platform`
- **tray** (Windows + Linux), **notifications**, **single instance**, **desktop
  integration** (`register` / `unregister` / `status`), the resolved
  **runtime environment** (`context.env`)
- a headless `--smoke` mode used by CI to verify the server without a display

```bash
cd example-app
bun run dev        # open the desktop window (dev environment, HMR active)
bun run smoke      # headless server check, no window
bun run build      # build the executables for the current OS
bun run build:win  # force a Windows target
```

CI (`.github/workflows/ci.yml`) builds each platform on its native runner
(Windows x64, Linux x64, macOS arm64 + x64) and smoke-tests both the source
and the compiled binary.

## Composable API

When you don't use the all-in-one entrypoint, compose the pieces individually:

```ts
import {
  acquireSingleInstance,
  createUpdater,
  findChromiumBrowser,
  findFirefoxBrowser,
  launchAppWindow,
  registerWindowsIntegration,
  staticBinaryProvider,
} from 'bundesk'
```

These modules share the same implementation as `createDesktopApp`; there is no second set of behaviors.

## Runtime environment (development / production)

The framework resolves an app environment and exposes it as `context.env`
(`'development' | 'production'`). The mode only fills **defaults** — any
behavior configured explicitly always wins.

Resolution priority (highest first):

1. CLI: `my-app --mode=production` (or `--mode production`)
2. `BUNDESK_ENV` env var — framework-specific override, so apps that need
   `NODE_ENV` for their own purposes can pin it independently
3. `NODE_ENV` env var (standard)
4. Default: **production** when the process is a compiled single binary,
   **development** when running under bun

```ts
onReady: (context) => {
  if (context.env === 'production') {
    // minimal logging, no debug endpoints, ...
  }
}
```

What the mode currently drives:

- `Bun.serve({ development })` — defaults to `context.env === 'development'`
  (rendered error pages, contextual exceptions). Set `development: false`
  explicitly in the `server` option to pin it regardless of the mode.

Values other than `development`/`production` are never consumed: a CLI
`--mode=staging` stays an app argument and a `NODE_ENV=staging` stays readable
by the app — the framework only recognizes the two standard values.

### Sticky dynamic ports

Dynamic ports are sticky by default. When `server.port` is omitted or set to
`0`, the first launch asks the OS for a random free port and stores it in
`<appData>/server-port.json`. Later launches try that port first, preserving a
stable local URL across restarts; if it is occupied, BunDesk falls back to a
new random port and updates the record.

An explicit non-zero `server.port` or non-zero CLI `--port` always wins and is
neither read from nor written to the sticky record. Disable reuse while keeping
random allocation with `stickyPort: false`, or override the record directory for
portable/test setups:

```ts
server: {
  port: 0,
  stickyPort: { dataDirectory: './portable-data' }, // true by default
  fetch: () => new Response('Hello'),
}
```

## Fullstack pages (HTML imports)

Bun's bundler can serve a full frontend pipeline directly from HTML files:
import an `.html` file and pass it as a route — Bun bundles every
`<script>` and `<link>` tag (TypeScript/TSX/JSX/CSS), rewrites the markup to
hashed asset URLs, and serves the result.

```ts
import dashboard from './src/dashboard.html'

const app = createDesktopApp({
  id: 'my-company.my-app',
  server: {
    port: 0,
    routes: {
      '/': dashboard,
      '/api/data': () => Response.json({ ok: true }),
    },
  },
  window: { provider: 'webview' },
})
```

No custom frontend build script is needed — the page assets are part of the
app's build graph (a `bundesk` compile emits the same assets ahead of time).

### Tailwind CSS v4

BunDesk does not bundle or wrap Tailwind. Use Bun's official static-route
plugin so the same source CSS participates in Bun's HTML pipeline during both
development and compilation.

Install the application-owned dependencies:

```bash
bun add -d tailwindcss bun-plugin-tailwind
```

Load the plugin before `Bun.serve()` bundles HTML routes by adding a project
`bunfig.toml`:

```toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

Reference the source CSS directly from the HTML page:

```css
/* src/page/app.css */
@import "tailwindcss";
@source "../components/";
```

```html
<link rel="stylesheet" href="./app.css" />
```

For compiled applications, pass the same plugin through the standard Bun
build configuration already exposed by `defineConfig`:

```ts
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'bundesk'

export default defineConfig({
  entrypoint: 'src/main.ts',
  outfile: 'dist/my-app.exe',
  plugins: [tailwind],
})
```

Development can then run the app directly (`bun src/main.ts`): Bun rebuilds
Tailwind CSS with the HTML route and HMR updates the open page. No generated
CSS file or separate `tailwindcss --watch` process is required.

The static plugin must be loaded through `[serve.static]`; dynamically calling
`Bun.plugin(tailwind)` is not equivalent because the runtime plugin builder
does not expose the native `onBeforeParse` hook required by the Tailwind
plugin. Also verify the generated CSS before removing an existing Tailwind CLI
pipeline: plugin releases can embed a different Tailwind compiler version. In
our Bun 1.3.14 check, `bun-plugin-tailwind@0.1.2` emitted a Tailwind 4.1.14
banner even with `tailwindcss@4.3.3` installed. Keep the CLI watcher when exact
compiler-version parity is required.

See [Bun's Tailwind plugin documentation](https://bun.sh/docs/bundler/fullstack#tailwindcss-plugin)
and [`bun-plugin-tailwind`](https://www.npmjs.com/package/bun-plugin-tailwind).

### dev vs prod behavior

The pipeline is switched by the runtime environment (see above): the
framework's `development` default is exactly the switch Bun's fullstack
server uses.

| Feature | dev (`bun server/main.ts`) | prod (compiled binary) |
| --- | --- | --- |
| Asset bundling | re-bundled on every request | cached (dev) / AOT manifest (compiled) |
| Source maps | ✅ | ❌ |
| Minification | ❌ | ✅ |
| Hot module reload | ✅ (WebSocket runtime woven into the client) | ❌ |
| Error details | detailed | minimal |

Verified on bun 1.3.14: dev responses carry `sourceMappingURL` and the HMR
client; a compiled single binary serves `chunk-<hash>.js/css` minified.

### The dev loop

In development the desktop window (webview/webkit) loads the dev server, so
frontend edits hot-reload into the open window — no app restart:

```bash
bun server/main.ts          # window opens, HMR active
# edit src/dashboard.html / its scripts -> the window updates in place
```
Add `development: { console: true }` to the `server` option to echo the
page's console.log to the terminal over the HMR connection.

### Server-side `bun --hot`

Run the application with `bun --hot` to soft-reload backend modules without
restarting the Bun process:

```bash
bun --hot src/main.ts
```

`app.run()` detects hot mode automatically. It returns after startup instead
of keeping the entry module evaluation pending; on the next evaluation,
BunDesk stops the previous app session (server, window, tray and
single-instance lock) before starting its replacement in the same process and
on the same configured or sticky port.

This is complementary to Bun's browser HMR: `server.development` updates the
HTML/TSX/CSS client, while `bun --hot` re-evaluates backend code and lifecycle
configuration. `bun --watch` remains the isolated alternative when a full
process restart is preferable.

Use `await app.run()` unchanged. Do not wrap it in an additional never-ending
promise or interval: the entry module must finish evaluating for Bun to apply
the next soft reload. Hot mode is intended for development; compiled binaries
keep the normal blocking lifecycle.

## Platform integration

### Linux: XDG file associations and launcher

On Linux, `register` / `unregister` / `status` write to the XDG standard locations, all at the current-user level:

- MIME package: `~/.local/share/mime/packages/<appId>.xml` (extension → `application/x-<progId>`), followed by a best-effort `update-mime-database` refresh;
- desktop entry: `~/.local/share/applications/<appId>.desktop` (`Exec="<exe>" %F`, `MimeType=`);
- default associations: `[Added Associations]` in `~/.config/mimeapps.list` (`--default` writes to `[Default Applications]`).

```bash
my-app register [--default]
my-app unregister
my-app status
```

Without `update-mime-database`, registration still succeeds; only the MIME cache is not refreshed.

### macOS: build-time `.app` packaging

macOS has no runtime registration: file associations, URL schemes and icons are written into the bundle's `Info.plist` at build time, and the `register`/`status` commands return an explicit unsupported message.

```ts
export default defineConfig({
  entrypoint: 'server/main.ts',
  outfile: 'dist/My App.app',
  target: 'bun-darwin-arm64',
  macos: {
    bundleIdentifier: 'com.mycompany.myapp',
    displayName: 'My App',
    version: '1.2.3',
    icon: 'src/app/AppIcon.icns',
    documentTypes: [{ extension: '.demo', name: 'My App Document' }],
    urlTypes: [{ scheme: 'myapp' }],
    background: false,
    codesign: false, // ad-hoc signing by default on macOS hosts; false skips it
  },
})
```

- When `outfile` ends in `.app`, a bundle is generated: `Contents/MacOS/<name>` is the executable, and `Contents/Info.plist` contains `CFBundleDocumentTypes`, `UTExportedTypeDeclarations` (UTIs exported automatically) and `CFBundleURLTypes`.
- A darwin `outfile` that is not `.app` stays a single-file Mach-O.
- On macOS hosts, `codesign --force --deep -s -` (ad-hoc) runs by default; cross-compiled artifacts are not signed, so they must be signed and notarized on a Mac before distribution (`codesign` + `notarytool`).
- Linux CI can also cross-compile macOS x64/ARM64 `.app` bundles (Bun downloads the same-version darwin runtime).

### Termux (Android)

When BunDesk detects a Termux environment (`$PREFIX` pointing at the `com.termux` data directory):

- windows are no longer Chromium `--app` but an Android VIEW intent (`am start` or `termux-open-url`) that opens the URL in the system browser;
- the app lifecycle, single instance, HTTP server and automatic updates behave as on regular platforms;
- `exitWithWindow` has no effect under Termux (the intent returns immediately).

Note: the Bun runtime must be able to execute inside Termux (a glibc proot environment, e.g. Debian/Ubuntu under `proot-distro`); there are no extra requirements on the browser side.

## Registering as a service

Because the app ships an API layer and can `serve`, it can be registered as a resident headless service: it starts automatically at boot/login, opens no window, and the API stays online. GUI interaction is forwarded to the service process via single-instance IPC, and `onSecondInstance` decides whether `launchWindow()` reconnects to the same server.

```bash
my-app install-service        # register and start now
my-app service-status         # show registration and running state
my-app uninstall-service      # stop and remove
```

| Platform | Mechanism | Notes |
| --- | --- | --- |
| Windows | HKCU Run key | starts at login, no administrator required; a true SCM service needs native `StartServiceCtrlDispatcher`, which Bun cannot provide |
| Linux | systemd user unit | `~/.config/systemd/user/<appId>.service`, `systemctl --user enable --now`; no root required |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/<appId>.plist`, `launchctl bootstrap gui/<uid>`; logs are written to the app data directory |
| Termux | termux-boot script | `~/.termux/boot/<appId>.sh`, executed by Termux:Boot at boot |

Conventions:

- The service runs as `"<exe>" serve --no-browser`, with the executable path fixed at registration time; the framework's atomic self-update replaces the file at the same path, so the service does not need re-registration;
- the `active` field of `service-status` is determined from the single-instance record (`instance.json` + PID liveness), consistently across platforms;
- `install-service` / `uninstall-service` support a `--dry-run` preview;
- the service uses `WorkingDirectory`/`RunAtLoad`/`Restart=on-failure`/`KeepAlive` to be restarted after crashes; relative paths inside the app should resolve against `process.execPath`, not cwd.

## System tray

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: { port: 0, routes: { '/': new Response('Hello') } },
  tray: {
    icon: 'src/app/tray.ico',   // Windows: .ico or executable path; defaults to the system icon
    tooltip: 'My App',
    menu: [
      { label: 'Open main window', onClick: (context) => context.launchWindow() },
      { separator: true },
      { label: 'Quit', onClick: (context) => context.stop() },
    ],
    onActivate: (context) => context.launchWindow(),  // left click
  },
})
```

- With a tray configured, closing the window does **not** exit by default (`exitWithWindow` defaults to false); the app stays resident in the tray, and you quit via `context.stop()` from the tray menu;
- interaction callbacks (`onActivate`, menu `onClick`) receive the same full `context` as actions;
- the tray icon can be updated at runtime: `context.tray?.update({ tooltip: '...', icon: '...' })`, and `context.tray?.destroy()` removes it.

Platform status:

| Platform | Status | Mechanism |
| --- | --- | --- |
| Windows | **Implemented** | pure `bun:ffi` against user32/shell32: `Shell_NotifyIconW` + hidden window + 50ms message pump, no native toolchain |
| Linux | **Implemented** | StatusNotifierItem over D-Bus: pure JS D-Bus client (EXTERNAL auth, wire codec) + com.canonical.dbusmenu; requires a session bus and a StatusNotifierItem-capable host (KDE/XFCE/GNOME + AppIndicator); unsupported daemons degrade to no tray |
| macOS | Not implemented | AppKit `NSStatusItem` via `objc_msgSend` FFI (needs NSApplication/run-loop cooperation; feasible but fragile) |
| Termux | Not supported | Android has no tray concept |

On Windows, newly registered icons may first appear in the overflow area (Windows default behavior); users can drag them into the main tray. `iconPresent()` returns false per spec for icons hidden in the overflow area.

## System notifications

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: { port: 0, routes: { '/': new Response('Hello') } },
  notifications: { aumid: 'MyCompany.MyApp' },   // optional: AppUserModelID the toast is attributed to
})

// anywhere in the app
await context.notify({
  title: 'Build finished',
  body: 'The release artifact has been generated',
})
```

Platform mechanisms (`context.notify` returns whether delivery succeeded):

| Platform | Mechanism | Click callback |
| --- | --- | --- |
| Windows | WinRT toast via the PowerShell bridge (`Windows.UI.Notifications`) | Not implemented (requires AUMID registration + activation handling) |
| Linux | `notify-send` (libnotify, `icon` via `-i`) | None |
| macOS | `osascript` display notification | None |
| Termux | `termux-notification` (termux-api) | None |

Known trade-offs:

- the classic `Shell_NotifyIcon` balloon is suppressed on Windows 10/11 (tested: `NIM_MODIFY` returns success but nothing appears on screen, and a WinForms control shows nothing either), so Windows uses toast;
- by default the toast shows "Windows PowerShell" as the source name; after configuring `{ aumid }` and creating a Start Menu shortcut with that AUMID, toasts appear under your app's name;
- click callbacks need toast activation (launch arguments + foreground activation), on the roadmap.

## Installed PWA windows

The `pwa` provider launches an already-installed Edge/Chrome/Brave/Chromium
web app by its Chromium app id:

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  // The installed PWA start URL must point at this stable origin.
  server: { port: 43123, routes: { '/': page } },
  window: {
    provider: 'pwa',
    pwa: {
      appId: 'abcdefghijklmnopabcdefghijklmnop',
      profileDirectory: 'Default',
      // Optional for known browsers; this is the browser user-data root,
      // not the individual profile directory.
      // userDataDir: 'C:/Users/me/AppData/Local/Microsoft/Edge/User Data',
    },
  },
})
```

- BunDesk launches Chromium with `--app-id`, `--user-data-dir`, and
  `--profile-directory`; it does not fall back to URL App Mode.
- The PWA must already be installed in that browser profile. BunDesk validates
  its `Web Applications/Manifest Resources/<appId>` directory before launch
  and reports a missing installation instead of silently opening a tab.
- Installation, the web app manifest, service worker, icons, scope, and
  `start_url` belong to the application. BunDesk does not mutate browser policy
  or profile databases to install ordinary PWAs.
- Use a fixed server origin. The installed PWA launches its manifest
  `start_url`; `window.path` and a newly selected dynamic port cannot retarget
  an installed app.
- `userDataDir` is inferred for standard Edge, Chrome, Brave, and Chromium
  installations on Windows, Linux, and macOS. Set it explicitly for portable
  or nonstandard browsers.
- A shared browser profile may hand the request to an already-running browser,
  so the returned subprocess tracks the launcher rather than the actual PWA
  window. Use `exitWithWindow: false` when the BunDesk backend must remain
  alive independently of that launcher.

CLI `--pwa` (or `--provider pwa`) selects this configured provider. Firefox and
Termux are not supported.

## WebView2 windows (Windows)

Besides launching the system browser in App Mode, a window can be hosted
in-process by WebView2 (the system WebView2 Runtime / Edge-unified runtime —
nothing is bundled):

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: {
    port: 0,
    routes: { '/': new Response('<h1>Hello</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  },
  window: {
    provider: 'webview',          // 'browser' (default), 'pwa', or 'webview'
    path: '/',
    width: 900,
    height: 640,
    title: 'My App',
    onMessage: (message) => console.log('page says:', message),
    onNavigateCompleted: ({ success, errorStatus }) => console.log('navigated:', success, errorStatus),
  },
})
```

- The page communicates with the app over `window.chrome.webview.postMessage`
  (messages arrive in `onMessage`); the window handle (`context.window`) adds
  `executeScript`, `postMessage` and `navigate` on top of the `Bun.Subprocess`
  surface.
- The WebView2 user-data folder defaults to `<appData>/WebView2`.
- Implementation: a header-free C shim (COM vtable layouts verified against the
  official WebView2.h) compiled at runtime by Bun's embedded TinyCC. The
  official WebView2Loader.dll is deliberately not used: the shim reads the
  runtime install path from the EdgeUpdate registry key and calls
  `CreateWebViewEnvironmentWithOptionsInternal` in
  `EmbeddedBrowserWebView.dll` directly. That export is undocumented but
  de-facto ABI-stable — it is the exact dependency the official loader uses
  (its env-creation path is GetProcAddress on this export plus a direct call),
  so a frozen binary fails identically either way — no native toolchain, no
  downloaded binaries, single-binary build preserved.
- Pages served by the app must set a real `content-type` (`text/html`); without
  it the page renders as plain text.

Window providers by platform (`provider: 'browser'` is the default everywhere;
it prefers Chromium App Mode and falls back to an isolated Firefox window):

The CLI can override the config with `--browser`, `--pwa`, or `--webview`
(equivalently `--provider browser|pwa|webview`). CLI `webview` is a
cross-platform abstraction: it maps to `webview` on Windows and `webkit` on
Linux; unsupported platforms fail with a clear error. `--no-browser` still
means no window at all. The `window.provider` config property uses the literal
provider names in the table.

| Platform | In-process provider | Status | Mechanism |
| --- | --- | --- | --- |
| Windows | `webview` (WebView2) | **Implemented** | C shim compiled by embedded TinyCC; direct call into the runtime's `EmbeddedBrowserWebView.dll` (no loader binary) |
| Linux | `webkit` (WebKitGTK) | **Implemented** | `webkit2gtk-4.1` C API shim compiled by embedded TinyCC (`run_javascript` → `executeScript`, `script-message-received` → `onMessage`); GTK3 and GTK4 webkit builds both supported (base detected at runtime); requires the WebKitGTK stack installed (e.g. `pacman -S webkit2gtk-4.1` / `apt install libwebkit2gtk-4.1-0`); DMA-BUF rendering is disabled by default on Wayland for GBM compatibility (set `WEBKIT_DISABLE_DMABUF_RENDERER=0` before launch to override); in WSLg set `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` (plus `LIBGL_ALWAYS_SOFTWARE=1` if the GPU init fails) |
| macOS | `wkwebview` (WKWebView) | Not implemented | `objc_msgSend` FFI shim; feasible but the most fragile (ObjC blocks, NSApplication run loop) |
| Termux | — | Not supported | Android has no shell-process WebView API; embedded WebView needs an APK. VIEW intent (`browser`) is the intended path |

In config, `window.provider = 'webview'` throws on non-Windows platforms;
Linux config uses `webkit`, while its CLI spelling remains the portable
`--webview`.

## Automatic updates

### Static release URL

For object storage, CDN or a plain HTTP server:

```ts
import { staticBinaryProvider } from 'bundesk'

const provider = staticBinaryProvider({
  binaryUrl: 'https://downloads.example/my-app.exe',
  changelogUrl: 'https://downloads.example/CHANGELOG.txt',
  version: '1.2.4',
})
```

The provider checks the current file via the `HEAD` ETag; it supports SHA-256 ETags, plain MD5, and object-storage ETags compatible with 16 MiB multipart uploads. During download it also verifies Content-Length, `X-Checksum-SHA256` / `Digest`, the optional descriptor SHA-256, and the `MZ` file header for Windows EXEs.

### GitHub Releases

```ts
import { githubReleaseProvider } from 'bundesk'

const provider = githubReleaseProvider({
  owner: 'OWNER',
  repository: 'REPOSITORY',
  assetName: 'my-app.exe',
})
```

The provider compares the current version against the release tag, selects the specified asset, and verifies the download with the GitHub asset digest (when present).

## Single-instance security model

BunDesk does not expose the instance-forwarding interface in app routes. The framework starts a separate IPC HTTP server bound to `127.0.0.1` only, and generates a 256-bit random token per primary instance. The token is written only to a permission-restricted file in the current user's app data directory; secondary instances must present the Bearer token to forward arguments. Locks/records left behind by a crash are cleaned up once the original PID is confirmed to have exited.

## Build configuration

Create `bundesk.config.ts` in the project root:

```ts
import { defineConfig } from 'bundesk'

export default defineConfig({
  entrypoint: 'server/main.ts',
  outfile: 'dist/my-app.exe',
  target: 'bun-windows-x64',
  minify: true,
  define: {
    __APP_VERSION__: JSON.stringify('1.2.3'),
  },
  windows: {
    console: 'detached',
    icon: 'src/app/icon.ico',
    title: 'My App',
    publisher: 'My Company',
    version: '1.2.3',
    description: 'My local desktop web app',
    copyright: 'Copyright (C) 2026 My Company',
  },
})
```

Build:

```bash
bunx bundesk
bunx bundesk --config build/bundesk.config.ts
bunx bundesk --target bun-windows-x64-baseline
```

The config file can export an array to produce artifacts for multiple platforms in one run. Your own Tailwind/Vite/Worker plugins are passed directly through the standard `plugins` option; BunDesk does not duplicate your app's build logic.

## Windows console modes

| `windows.console` | Behavior | Use case |
| --- | --- | --- |
| `detached` (default) | no console is allocated on double-click; inherits the existing terminal when launched from one | GUI and CLI at the same time |
| `hidden` | runs as a GUI program using Bun's `hideConsole` | GUI only |
| `inherit` | keeps Bun's default console behavior | CLI first |

`detached` is implemented via the Windows `consoleAllocationPolicy` manifest. BunDesk modifies a clean `bun.exe` before compiling, avoiding any rewrite of the PE file after the Bun payload has been appended.

## Cross-compiling the runtime

On native Windows with a matching architecture, the current `bun.exe` is reused by default. Linux cross-compilation or baseline/ARM64 builds download:

```text
https://github.com/oven-sh/bun/releases/download/bun-v<Bun.version>/<target>.zip
```

A custom mirror can be used via `runtime.downloadUrl`, and `runtime.sha256` pins the checksum of the extracted `bun.exe`.

## Platform support

| Feature | Windows | Linux | macOS | Termux (Android) |
| --- | --- | --- | --- | --- |
| HTTP server / lifecycle | Yes | Yes | Yes | Yes |
| Browser / in-process WebView window | Yes / Yes | Yes / Yes (WebKitGTK) | Yes / No | VIEW intent / No |
| Installed Chromium PWA | Yes | Yes | Yes | No |
| Secure single instance and argument forwarding | Yes | Yes | Yes | Yes |
| Single-file build / `.app` bundle | single-file EXE | single file | `.app` bundle | n/a |
| Cross-compilation | any platform → EXE | any platform → single file | Linux/macOS → `.app` | n/a |
| Atomic replacement of the current executable | Yes | low-level API available; no desktop release commitment in 0.1 | low-level API available; no desktop release commitment in 0.1 | low-level API available |
| File associations / launcher | Yes (HKCU) | Yes (XDG) | build-time Info.plist | No |
| Service registration (headless serve) | HKCU Run key | systemd user | launchd agent | termux-boot |
| System tray | Yes (Win32 FFI) | Yes (SNI D-Bus) | Planned (AppKit FFI) | No |
| System notifications | WinRT toast (PowerShell bridge) | notify-send | osascript | termux-notification |

The Windows console modes (`detached`/`hidden`/`inherit`) only apply on Windows; the `windows`/`runtime` build options require a `bun-windows-*` target, and the `macos` option requires a `bun-darwin-*` target with an `outfile` ending in `.app`.

## Roadmap

See the [application migration and performance benchmark plan](docs/migration-benchmark-plan.md) for the full proposal. Only the technology selection and experimental design are done so far; migration and performance data collection have not started.

Done (this round):

- macOS runtime support (browser candidates, data directory, darwin update asset) and `.app` bundle builds (Info.plist, UTI/document types, URL schemes, icon, ad-hoc codesign);
- Linux XDG file associations, desktop entries and mimeapps registration (`register`/`unregister`/`status`);
- Termux (Android) detection and VIEW intent windows;
- service registration (Windows Run key / systemd / launchd / termux-boot), the Windows system tray (pure Win32 FFI) and system notifications (WinRT toast bridge, notify-send, osascript, termux-notification).

To be evaluated:

- Round 1: draw.io Desktop (Electron), NextChat (Tauri), NeoHtop (Tauri), LLMPET (Electron), covering static-heavy, web-first, native-backend and small-but-real-backend (state machine + metering + permission) app types;
- Round 2: MarkText (Electron), Yaak (Tauri), widening the compatibility boundary for file systems, editors, databases, networking, plugins and secret/keychain;
- landing the macOS signing/notarization pipeline on real Mac CI;
- **Hermes Agent + Poly**: evaluate hosting Bun and RustPython in the same process via [Poly](https://github.com/liooil/poly), integrating [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s Python agent/runtime with the BunDesk desktop shell;
- **Oh My Pi + Poly**: evaluate wiring [Oh My Pi](https://github.com/can1357/oh-my-pi)'s Bun/TypeScript core directly into BunDesk, hosting the Python tool kernel via Poly.

## Development and verification

```bash
bun install
bun run typecheck
bun test
bun run pack:check
```

Test coverage: real Windows/Linux single-file builds and execution, macOS `.app` cross-compiled bundle structure (Mach-O, Info.plist), Windows PE metadata/manifest, real Chromium App Mode processes, secure single-instance forwarding, Linux XDG registration round trips, static update installation, the GitHub release provider, and Windows registry dry-runs.

## License

MIT
