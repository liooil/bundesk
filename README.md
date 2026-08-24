# BunDesk

> [中文](README.zh-CN.md) · **English**

**Turn local web apps into desktop applications that start fast, build fast and are easy to debug — with Bun and the system WebView/browser.**

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
- `--no-window` starts only the server, so you can debug with any browser or API client;
- app routes, Bun plugins, and Vite/Tailwind and Worker build logic all stay in the app repository.

### Cross-compilation support

Windows x64/ARM64 single-file EXEs can be produced on Linux CI. BunDesk downloads a Windows runtime of the **same version** as the building Bun, writes icon, version resources and manifest cross-platform first, then completes the Bun compile via `executablePath`. A Windows build machine is not required.

> The current artifact is a directly distributable single-file EXE. MSI, MSIX and installer wizards are not 0.1 artifact formats.

### No bundled Chromium

The application explicitly configures its window provider. It can use system WebViews—Windows WebView2, Linux WebKitGTK, or macOS WKWebView—or an Edge/Chrome/Chromium `--app=<url>` window, an isolated Firefox window, or the OS URL opener. The application also owns the fallback order, and every attempt or failure is logged. The payoff is smaller releases, less renderer update burden and a shorter packaging pipeline.

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
- low-level composable APIs such as `openDesktopWindow(...)`;
- in-process Windows WebView2, Linux WebKitGTK, and macOS WKWebView windows;
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

Requires Bun 1.4.0 or newer.

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
    provider: 'chromium-app',
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
my-app                         start the server and the configured concrete window provider
my-app --help                  print help generated from the config, then exit
my-app --version               print the application name and version, then exit
my-app --provider webview2     explicitly pin one concrete provider (disables configured fallback)
my-app --no-window             run without opening a window
my-app <file>                  start, or forward the file argument to the primary instance
my-app serve --no-window       start only the HTTP server
my-app register [--default]    register per-user file associations and a launcher
my-app unregister              undo the registration
my-app status                  show desktop integration status
my-app install-service         register as an auto-start service (headless serve)
my-app uninstall-service       remove the service registration
my-app service-status          show service status
my-app install-pwa             open the install URL and wait for browser confirmation
my-app install-pwa --policy    force-install through Edge/Chrome enterprise policy
my-app remove-pwa-policy       remove only this app's force-install policy entry
my-app upgrade [--force]       check for, install and restart after an upgrade
```

`-h` is equivalent to `--help`, and `-V` to `--version`. Use `cli.name`, `cli.description`, and `cli.options` to customize the displayed name, description, and application-specific options; framework commands are listed automatically.

`register` only writes `HKCU` and requires no administrator privileges. `--default` writes the per-user default ProgID for the extension, but does not bypass Windows' `UserChoice` protection.

## Example app

[`example-app/`](example-app/) is an interactive playground that configures
every BunDesk feature in one runnable app (not published in the npm package).
Its page is itself a fullstack route and links the live JSON endpoints:

- **fullstack page** (HTML import — HMR in dev, AOT in the binary) plus a PWA
  manifest, service worker, and generated PNG icons
- an app-owned **window provider policy**: `webview2` → Chromium → Firefox on
  Windows, `webkitgtk` → Chromium → Firefox on Linux, and `wkwebview` →
  Chromium → Firefox on macOS, plus `--provider` pinning for every concrete provider
- **provider matrix and window-handle facts** served from the composable API
  (`/api/providers`)
- **PWA installation**: `install-pwa`, `install-pwa --policy`,
  `remove-pwa-policy`, and `chromium-pwa` windows
- **single instance** with a second-instance handler that records forwarded
  `argv`, `cwd`, and PID in the page and reopens the window
- **updates**: GitHub Releases provider by default (`structuralUpdates` on),
  optional static-binary provider via `BUNDESK_EXAMPLE_UPDATE_URL`, a live
  check button, and the `upgrade` command
- **tray** (Windows + Linux), **notifications** through both the embedded
  window bridge and the HTTP API, **desktop integration**, **service
  registration**, **sticky port**, and the resolved **runtime environment**
- build configs for Windows metadata/icon/console modes, Linux, and macOS
  `.app` bundles with document/URL types and a generated `.icns` icon

```bash
cd example-app
bun run dev              # open the desktop window (dev environment, HMR active)
bun run smoke            # headless server/feature check, no window
bun run second-instance  # while dev is running: forward argv/cwd/PID to it
bun run help             # generated CLI help including PWA/update commands
bun run build            # build the executables for the current OS
bun run build:win        # force a Windows target
bun run build:macos      # force both macOS .app targets
```

Convenience npm scripts also exist for `serve`, `register`, `unregister`,
`status`, `service:install`, `service:uninstall`, `service:status`,
`pwa:install`, `pwa:policy`, `pwa:remove-policy`, and `upgrade`.

Playground tuning environment variables:

- `BUNDESK_EXAMPLE_PORT` — default port (`43123`); use `--port 0` for sticky
  random ports
- `BUNDESK_EXAMPLE_VERSION` — overrides the embedded app version (defaults
  to the framework `package.json` version at build time)
- `BUNDESK_EXAMPLE_DATA_DIR` — app data root (single-instance, sticky port,
  isolated browser/PWA profile)
- `BUNDESK_EXAMPLE_UPDATE_URL` — switch updates to a static binary URL
  (optionally `BUNDESK_EXAMPLE_UPDATE_VERSION` and
  `BUNDESK_EXAMPLE_UPDATE_CHANGELOG_URL`)
- `BUNDESK_EXAMPLE_CONSOLE` — `detached` (default), `hidden`, or `inherit`
  when building the Windows executable
- Windows cross-builds cache a downloaded Bun runtime in
  `example-app/.cache/bundesk-runtime` (configurable through the `runtime`
  field in `bundesk.config.ts`)

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
  openDesktopWindow,
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

### Unix socket mode

Set `server.unix` to run headlessly without a TCP listener. `server.port`,
`server.hostname`, sticky ports, and CLI `--port`/`--host` do not apply. Window
and PWA providers require a browser-loadable HTTP origin, so leave `window`
unset or set `window: false`:
```ts
const app = createDesktopApp({
  id: 'my-company.headless-app',
  server: {
    unix: '/run/my-app.sock',
    fetch: () => Response.json({ ok: true }),
  },
  window: false,
  singleInstance: {},
})

const session = await app.start()
const response = await fetch('http://localhost/status', { unix: session.unix })
```

`context.unix` is the real endpoint; `context.url` uses the descriptive
`http+unix:` scheme and is intentionally not fetchable. With single-instance
mode enabled, secondary launches use `POST /second-instance` on this same
socket, including bearer-token authentication, so BunDesk opens no auxiliary
loopback TCP listener.

Bun's native `routes` table—including imported HTML bundles—works on unix
listeners. Bun 1.4 also routes Unix-socket requests correctly when
`HTTP_PROXY` or `HTTPS_PROXY` causes `fetch(url, { unix })` to emit an
absolute-form request target. BunDesk's authenticated single-instance IPC is
registered in that same native routes table.

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
  window: { provider: 'chromium-app' },
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
an earlier Bun 1.3.14 check, `bun-plugin-tailwind@0.1.2` emitted a Tailwind
4.1.14 banner even with `tailwindcss@4.3.3` installed. Keep the CLI watcher
when exact compiler-version parity is required.

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

Verified on Bun 1.4.0: dev responses carry `sourceMappingURL` and the HMR
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

- The service runs as `"<exe>" serve --no-window`, with the executable path fixed at registration time; the framework's atomic self-update replaces the file at the same path, so the service does not need re-registration;
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

## PWA installation and windows

The concrete `chromium-pwa` provider launches an Edge/Chrome/Brave/Chromium
web app by its Chromium app id. BunDesk can also assist the initial installation:

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  // A PWA needs a stable origin. Do not use a dynamic port here.
  server: { port: 43123, routes: { '/': page } },
  window: {
    provider: 'chromium-pwa',
    exitWithWindow: false,
    preferred: 'edge',
    pwa: {
      appId: 'abcdefghijklmnopabcdefghijklmnop',
      profileDirectory: 'Default',
      // Defaults to the running app URL. Use this for an externally hosted PWA.
      // installUrl: 'https://app.example.com/',
      installTimeoutMs: 300_000,
      policy: {
        createDesktopShortcut: true,
        customName: 'My App',
      },
      // Optional for known browsers; this is the browser user-data root,
      // not the individual profile directory.
      // userDataDir: 'C:/Users/me/AppData/Local/Microsoft/Edge/User Data',
    },
  },
})
```

### Interactive installation

```bash
my-app install-pwa
```

BunDesk starts the configured server, opens the install URL in the selected
browser profile, and waits for the user to accept the browser's native install
prompt. Installation completion is detected from the profile filesystem; the
command does not poll with a fixed sleep and returns immediately if the PWA is
already installed. If another app instance owns the server, the command is
forwarded to that primary instance and its result is returned.

### Enterprise policy installation

```bash
my-app install-pwa --policy
my-app install-pwa --policy --dry-run
my-app remove-pwa-policy
```

On Windows, policy mode merges this URL into the current user's mandatory
`WebAppInstallForceList` registry policy for Microsoft Edge or Google Chrome.
It preserves unrelated entries, asks the browser to refresh the selected
profile, and waits until the configured `appId` appears. Because this is a
mandatory policy, affected users cannot uninstall the PWA while the entry
remains active.

If a machine-level `WebAppInstallForceList` already contains this URL, BunDesk
uses it without adding a user policy. If the machine policy contains a
different list, BunDesk refuses to shadow it and directs deployment back to
the administrator.

`remove-pwa-policy` removes only the matching URL and preserves other
current-user entries. It refuses to remove a machine-enforced entry. Removing
the requirement does not uninstall an existing PWA. Automatic policy mutation is deliberately
Windows-only. Chrome supports the same policy on Linux and macOS, and Edge
supports it on macOS, but those systems require administrator-managed policy
files or configuration profiles; BunDesk does not attempt privilege elevation.

See the official
[Microsoft Edge `WebAppInstallForceList` policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/webappinstallforcelist)
and [Google Chrome policy list](https://chromeenterprise.google/policies/#WebAppInstallForceList).

### Launch behavior and constraints

- BunDesk launches an installed app with `--app-id`, `--user-data-dir`, and
  `--profile-directory`; it does not fall back to URL App Mode.
- Installation is confirmed by
  `Web Applications/Manifest Resources/<appId>`. A mismatched configured
  `appId` causes installation to time out with an explicit error.
- The application still owns its Web App Manifest, Service Worker, icons,
  scope, and `start_url`.
- Use a fixed server origin. The installed PWA launches its manifest
  `start_url`; `window.path` or a newly selected dynamic port cannot retarget
  an installed app.
- `userDataDir` is inferred for standard Edge, Chrome, Brave, and Chromium
  installations on Windows, Linux, and macOS. Set it explicitly for portable
  or nonstandard browsers.
- A shared browser profile may hand a launch request to an already-running
  browser. The returned subprocess then tracks the launcher, not the PWA
  window; use `exitWithWindow: false` so the backend remains alive.
- Interactive installation and launching support Edge, Chrome, Brave, and
  Chromium. Automated policy installation supports Edge and Chrome on Windows.
  Firefox and Termux are not supported.

CLI `--provider chromium-pwa` pins the installed-PWA window provider; it does
not run the installation command or select another provider.

## Concrete window providers and explicit fallback

BunDesk never maps a platform to a provider, never appends an implicit
fallback, and has no default provider. Omitting `window` opens no window.
The app names one concrete implementation:

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: {
    port: 0,
    routes: {
      '/': new Response('<h1>Hello</h1>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    },
  },
  window: {
    provider: 'webview2',
    fallback: [
      { provider: 'chromium-app', on: ['unsupported', 'unavailable'] },
      { provider: 'firefox-window', on: ['unsupported', 'unavailable'] },
    ],
    path: '/',
    width: 900,
    height: 640,
    title: 'My App',
    onMessage: (message) => console.log('page says:', message),
  },
})
```

The application owns every decision here: the primary provider, fallback
providers, their order, and the failure classes that permit each fallback.
Without `fallback`, provider failure is final. `--provider <id>` explicitly
pins one provider and disables the configured fallback chain; `--no-window`
opens none.

Available concrete IDs:

| Provider | Mechanism | Window-close observation |
| --- | --- | --- |
| `webview2` | Windows in-process WebView2 | Yes |
| `webkitgtk` | Linux in-process WebKitGTK | Yes |
| `wkwebview` | macOS in-process WKWebView | Yes |
| `chromium-app` | Isolated Chromium `--app=<url>` process | Yes, for the managed process |
| `chromium-pwa` | Installed Chromium app id | No; the process may only be the launcher |
| `firefox-window` | Isolated Firefox profile/window process | Yes, for the managed process |
| `system-browser` | OS URL opener | No |
| `android-view-intent` | Termux Android VIEW intent | No; the process is only the dispatcher |

`webview2`, `webkitgtk`, and `wkwebview` expose `navigate`, `executeScript`, `postMessage`,
navigation readiness, and page-to-host messages. Pages must send a real
`content-type: text/html` response. `webview2` uses the system WebView2 Runtime
and a header-free C shim compiled by Bun's embedded TinyCC. It deliberately
bypasses `WebView2Loader.dll`, discovers the Edge-unified runtime, and directly
calls the undocumented `CreateWebViewEnvironmentWithOptionsInternal` export.
`webkitgtk` requires the WebKit2GTK 4.1 stack and a desktop display. `wkwebview`
uses the AppKit and WebKit frameworks built into macOS. Bun compiles a
header-free C shim at runtime, which drives the native window through the
Objective-C runtime, so no browser installation or separately distributed
native helper is required. `userDataDir` is accepted for API parity but public
WKWebView APIs do not expose an arbitrary profile path.

The returned `DesktopWindowHandle` is discriminated by `provider` and `kind`.
It exposes `ready`, `closed`, `lifecycle`, `capabilities`, `close()`, and the
full `attempts` trace. Embedded handles additionally expose the script,
message, and navigation methods. `ready` records concrete evidence:
`navigation-completed`, `process-started`, or `launch-dispatched`.

Use the fact APIs without triggering a framework choice:

```ts
const report = await inspectWindowProvider('webview2')
const releaseEvidence = getWindowProviderMatrix()
```

`report` separates target compatibility, current-machine availability, release
verification, capabilities, and structured diagnostics. The release matrix is
evidence only; neither API selects or substitutes a provider.

Current embedded-provider evidence:

| Provider | Target | Implementation | Verification |
| --- | --- | --- | --- |
| `webview2` | Windows x64 | Implemented | Experimental; native create/navigation/script/message/close smoke passed |
| `webview2` | Windows arm64 | Not implemented | Current implementation needs runtime TinyCC, unavailable in the tested compiled Bun runtime |
| `webkitgtk` | Linux x64 | Implemented | Native WSLg create/navigation/script/message/close smoke passed |
| `webkitgtk` | Linux arm64 | Implemented | Unverified |
| `wkwebview` | macOS arm64 | Implemented | Native create/navigation/script/bidirectional-message/close smoke passed |
| `wkwebview` | macOS x64 | Implemented | Unverified |

`exitWithWindow: true` is rejected when the selected provider cannot observe
the actual window closing. Set it to `false` for `chromium-pwa`,
`system-browser`, and `android-view-intent`.

## Automatic updates

### Static release URL

For object storage, CDN or a plain HTTP server:

```ts
import { staticBinaryProvider } from 'bundesk'

const provider = staticBinaryProvider({
  binaryUrl: 'https://downloads.example/my-app.exe',
  changelogUrl: 'https://downloads.example/CHANGELOG.txt',
  version: '1.2.4',
  structuralUpdates: true,
})
```

The provider checks the current file via the `HEAD` ETag; it supports SHA-256 ETags, plain MD5, and object-storage ETags compatible with 16 MiB multipart uploads. During download it also verifies Content-Length, `X-Checksum-SHA256` / `Digest`, the optional descriptor SHA-256, and the `MZ` file header for Windows EXEs.

### GitHub Releases

```ts
import { githubReleaseProvider } from 'bundesk'

const provider = githubReleaseProvider({
  owner: 'OWNER',
  repository: 'REPOSITORY',
  structuralUpdates: true,
  assetName: 'my-app.exe',
})
```

The provider compares the current version against the release tag, selects the specified asset, and verifies the download with the GitHub asset digest (when present).

### Index-free section-level Range updates

Set `structuralUpdates: true` on the update provider. The release executable
is not modified: BunDesk publishes no embedded index, JSON sidecar, or
old-version-specific delta. The same normally built and signed executable is
both the download and the update source.

At update time, BunDesk uses HTTP Range requests to parse the remote
PE/ELF/Mach-O headers and section table. A target runtime section is copied
optimistically from the installed executable when its container identity,
section name/index, and size match. Headers, signatures, platform resources,
gaps, and the complete `.bun` section are always downloaded. BunDesk stores no
per-module hashes; any bundled JS, CSS, HTML, or shim change therefore
downloads the complete `.bun` section. Large mutable assets should use an
application-level update mechanism instead of the compiled Bun graph.

Layout equality is deliberately only a reuse hint, not a trust decision.
Trusted release metadata must provide the final artifact SHA-256. BunDesk
reconstructs a temporary executable, verifies its complete size and SHA-256,
and installs it only when both match. If a Bun runtime changed without changing
a section's name or size, the optimistic reconstruction fails the digest check
and the default `fallbackToFull` path downloads the complete artifact. A server
without exact `206 Partial Content`, stable `Content-Range`,
`Accept-Encoding: identity`, or immutable ETag also takes that fallback.

This design gives normal app-only releases the main benefit—reusing the large
Bun runtime—with zero publishing metadata and zero executable mutation. A
runtime-changing release can cost one partial attempt followed by a full
download; set `fallbackToFull: false` only when that tradeoff is unacceptable.

For macOS, this mode describes the Mach-O executable. A complete `.app`
updater must still account for `Info.plist`, resources, and the bundle
signature; do not point the executable updater at a ZIP of the app bundle.


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
| Browser / in-process WebView window | Yes / Yes | Yes / Yes (WebKitGTK) | Yes / Yes (WKWebView) | VIEW intent / No |
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

See the [application migration and performance benchmark plan](docs/migration-benchmark-plan.md) for the full proposal. The first draw.io prototype and size/compression study are complete; see the [draw.io migration findings](docs/drawio-migration-findings.md). Production parity, embedded resources, signed Windows/macOS releases, and full cross-platform acceptance remain incomplete.

Done (this round):

- macOS runtime support (browser candidates, data directory, darwin update asset) and `.app` bundle builds (Info.plist, UTI/document types, URL schemes, icon, ad-hoc codesign);
- Linux XDG file associations, desktop entries and mimeapps registration (`register`/`unregister`/`status`);
- Termux (Android) detection and VIEW intent windows;
- service registration (Windows Run key / systemd / launchd / termux-boot), the Windows system tray (pure Win32 FFI) and system notifications (WinRT toast bridge, notify-send, osascript, termux-notification).
- a standalone draw.io prototype, Linux build/startup/memory measurements, and same-mechanism release compression projections for Windows, Linux, and macOS.

To be evaluated:

- completing draw.io's export, deterministic resource embedding/signing, startup optimization, and three-platform acceptance gates;
- the remaining Round 1 apps: NextChat (Tauri), NeoHtop (Tauri), and LLMPET (Electron), covering web-first, native-backend, and small-but-real-backend (state machine + metering + permission) app types;
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

Test coverage: real Windows/Linux single-file builds and execution, macOS `.app` cross-compiled bundle structure (Mach-O, Info.plist) and native WKWebView smoke, Windows PE metadata/manifest, real Chromium App Mode processes, secure single-instance forwarding, Linux XDG registration round trips, static update installation, the GitHub release provider, and Windows registry dry-runs.

## License

MIT
