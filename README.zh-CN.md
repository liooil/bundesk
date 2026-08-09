# BunDesk

> **English** · [中文](README.zh-CN.md)

**用 Bun 和系统浏览器，把本地 Web 应用变成启动快、构建快、容易调试的桌面应用。**

BunDesk 是一个面向 Bun 的桌面应用框架，而不只是 EXE 打包脚本。名称由 **Bun + Desktop** 组成。框架统一处理 HTTP server、浏览器窗口、单实例、自动升级、Windows 文件关联与开始菜单集成，同时保留底层组合式 API。

## 为什么是 BunDesk

### 构建很快

BunDesk 的正式构建是一次 `Bun.build({ compile })`：TypeScript、server、浏览器资源和 Bun runtime 直接生成单文件可执行程序。它不需要编译 Rust/C++ 桌面壳，也不复制一套 Chromium，因此避免了 Tauri 原生依赖编译和 Electron renderer/runtime 打包中最重的步骤。

实际耗时仍取决于应用规模、插件和网络缓存；建议在具体项目中记录 CI 基线。BunDesk 的框架测试会真实构建并运行 Windows/Linux 可执行文件，而不是只测试配置对象。
### 交付物是单个 binary

BunDesk 将 Bun runtime、server 和由入口导入的前端资源编进同一个平台可执行文件；发布时只需复制这一个 binary。Electron 即使提供单文件安装器，安装后通常仍会展开为包含 Electron/Chromium、`app.asar`、DLL、locale 和 resources 的应用目录。BunDesk 不携带浏览器目录，应用数据则按运行时约定保存在当前用户数据目录，不与发布物混放。

实际项目基准会同时记录发布文件数、解包/安装后总大小和压缩下载大小，避免只比较安装器表面的单文件形式。

### 调试直接

开发时应用就是普通 Bun HTTP server 和普通网页：

- server 代码直接由 Bun 运行，可使用现有 TypeScript 调试方式；
- UI 使用浏览器自带 DevTools，不经过自定义调试桥；
- `--no-browser` 可只启动 server，再用任意浏览器或 API 客户端调试；
- 应用 routes、Bun 插件、Vite/Tailwind 和 Worker 构建逻辑都留在应用仓库中。

### 支持交叉构建

可以在 Linux CI 上生成 Windows x64/ARM64 单文件 EXE。BunDesk 下载与构建 Bun **同版本**的 Windows runtime，先跨平台写入图标、版本资源和 manifest，再通过 `executablePath` 完成 Bun 编译。Windows 构建机不是必需条件。

> 当前产物是可直接分发的单文件 EXE。MSI、MSIX 或安装向导不是 0.1 版的产物格式。

### 不附带 Chromium

运行时优先使用系统已安装的 Microsoft Edge、Google Chrome 或 Chromium，并以 `--app=<url>` 打开独立应用窗口；未找到时使用隔离且可跟踪的 profile 启动 Firefox，最后才回退到系统 URL opener。每次选择或失败都会输出日志。收益是更小的发布物、更少的 renderer 更新负担和更短的打包链路。

## 与 Electron / Tauri 的定位

| | BunDesk | Electron | Tauri |
| --- | --- | --- | --- |
| 应用后端 | Bun | Node.js | Rust + 可选 sidecar |
| Renderer | 系统 Edge/Chrome/Chromium | 随应用附带 Chromium | 系统 WebView |
| 正式构建主链路 | Bun bundle + compile | JS bundle + Electron packaging | 前端构建 + Rust/native compile |
| Linux 构建 Windows 单文件 EXE | 支持 | 依赖目标打包配置 | 通常需要额外交叉工具链 |
| 调试 | Bun + 浏览器 DevTools | Electron DevTools | WebView DevTools + Rust 调试 |
| 原生能力 | Bun/Node API + Windows 集成模块 | Electron API | Tauri 插件/Rust |

BunDesk 适合“本地 HTTP 服务 + Web UI”的工具型桌面应用。需要深度原生 UI、系统级沙箱或随应用固定 Chromium 版本时，应选择更匹配的方案。

## 核心功能

- `createDesktopApp(...)` 一体化托管 server、窗口和生命周期；
- **cli + api + gui 三层**：action 注册一次，自动获得 `my-app <name>` CLI、`POST /api/actions/<name>` API 和 `/__bundesk/actions` 控制台页；
- `launchAppWindow(...)` 等组合式底层 API；
- Edge/Chrome/Chromium `--app=<url>` 独立窗口（macOS 含 Brave），Termux 走 Android VIEW intent；
- 带随机 256-bit token 的 loopback IPC 单实例；
- 次实例把 `argv`、`cwd` 和 PID 转发给主实例回调，action 结果可回传；
- 静态二进制 URL/ETag/SHA-256 和 GitHub Releases 两种升级 provider；
- 下载校验、原子替换、失败回滚、重启和旧版本清理；
- 系统通知（Windows WinRT toast，经 PowerShell 桥；Linux notify-send / macOS osascript / Termux termux-notification）；
- 系统托盘（Windows 已实现：纯 bun:ffi 调 Win32；Linux 已实现：StatusNotifierItem over D-Bus 纯 JS 客户端；均无原生编译）；
- 服务注册（headless `serve` 常驻）：Windows HKCU Run key、Linux systemd user unit、macOS launchd LaunchAgent、Termux boot 脚本；
- Windows 当前用户文件关联、默认打开方式和开始菜单快捷方式；
- Linux XDG 文件关联、desktop entry 和 mimeapps 注册（register/unregister/status）；
- macOS `.app` 打包：Info.plist、UTI/文档类型、URL scheme、图标与 ad-hoc codesign；
- Windows `detached` / `hidden` / `inherit` 三种控制台策略；
- Linux 交叉构建 Windows x64、baseline x64 和 ARM64，以及 macOS x64/ARM64 `.app`；
- 构建结果大小与 SHA-256 输出。

## 安装

```bash
bun add -d github:liooil/bundesk
```

包名 `bundesk` 可直接用于 Bun：

```ts
import { createDesktopApp, defineConfig } from 'bundesk'
```

要求 Bun 1.3.14 或更新版本。

## 运行时快速开始

应用 entrypoint：

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

框架保留以下应用命令：

```text
my-app                         启动 server 和浏览器窗口
my-app --help                  显示根据配置与 actions 生成的帮助并退出
my-app --version               显示应用名称和版本并退出
my-app --browser               强制使用系统浏览器 provider
my-app --webview               强制使用当前平台的进程内 WebView
my-app --provider browser      显式选择 browser（也可设为 webview）
my-app <file>                  启动或把文件参数转发给主实例
my-app serve --no-browser      只启动 HTTP server
my-app register [--default]    注册当前用户文件关联和 launcher
my-app unregister              取消注册
my-app status                  查看桌面集成状态
my-app install-service         注册为开机自启服务（headless serve）
my-app uninstall-service       移除服务注册
my-app service-status          查看服务状态
my-app upgrade [--force]       检查、安装升级并重启
```

`-h` 等价于 `--help`，`-V` 等价于 `--version`。可用 `cli.name`、`cli.description` 和 `cli.options` 定制帮助中显示的名称、说明和应用专属选项；框架命令与 actions 会自动列出。

`register` 只写 `HKCU`，不要求管理员权限。`--default` 写当前用户的扩展名默认 ProgID，但不会绕过 Windows 的 `UserChoice` 保护。

## 示例应用

[`example-app/`](example-app/) 是可运行的功能展示应用,由 CI 流水线打包为各平台可执行文件(不随 npm 包发布)。它展示:

- **全栈页面**(HTML import 路由——开发时热更新,编译产物 AOT)
- **窗口 provider**:Windows 用 `webview`、Linux 用 `webkit`、其他平台 `browser`——运行时按 `process.platform` 选择
- **三层 actions**:`example-app greet --name World`(cli)、`POST /api/actions/greet`(api)、自动生成的 console 页(gui)
- **托盘**(Windows + Linux)、**通知**、**单实例**、**桌面集成**(`register` / `unregister` / `status`)、解析出的**运行环境**(`context.env`)
- 供 CI 无头验证的 `--smoke` 模式(服务 + actions,不开窗口)

```bash
cd example-app
bun run dev        # 打开桌面窗口(dev 环境,HMR 生效)
bun run smoke      # 无头检查:服务 + actions,不开窗口
bun run build      # 构建当前平台的产物
bun run build:win  # 强制 Windows 目标
```

CI(`.github/workflows/ci.yml`)在各平台原生 runner 上构建(Windows x64、Linux x64、macOS arm64 + x64),并对源码与编译产物分别做冒烟测试。

## 组合式 API

不使用一体化入口时，可以单独组合：

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

这些模块与 `createDesktopApp` 使用同一实现，不存在第二套行为。

## cli + api + gui 三层

BunDesk 的核心理念之一：**一个 app 由 cli、api、gui 三层构成，同一功能可以在三层都有**。注册一次 action，框架自动把它暴露到三层，handler 只在应用进程里跑一次：

| 层 | 入口 |
| --- | --- |
| CLI | `my-app <name> --arg value ...` |
| API | `POST /api/actions/<name>`，JSON body 传命名参数；`GET /api/actions` 返回 schema |
| GUI | `/__bundesk/actions` 生成的控制台页，按 schema 渲染表单并调用同一 API |

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: { port: 0, routes: { '/': new Response('Hello') } },
  actions: [{
    name: 'export',
    description: 'Export the current document',
    args: [
      { name: 'format', type: 'string', default: 'json' },
      { name: 'pretty', type: 'boolean', default: true },
    ],
    async handler(args, context) {
      // 同一实现：CLI、API、GUI 都走到这里
      return { exported: true, format: args.format, pretty: args.pretty }
    },
  }],
})
```

三种调用等价：

```bash
my-app export --format csv --pretty=false
curl -X POST http://127.0.0.1:PORT/api/actions/export \
  -H 'content-type: application/json' -d '{"format":"csv","pretty":false}'
# 浏览器打开 http://127.0.0.1:PORT/__bundesk/actions
```

行为约定：

- CLI 调用 `my-app <action>` 时，首个参数匹配注册的 action 名即进入 action 模式，之后的 `--flag value` 全部作为 action 参数（框架命令如 `serve`/`register` 优先）。
- 单实例运行中时，CLI action 通过 loopback IPC 转发给主实例执行，**结果 JSON 原样回传**打印；未运行时则就地启动、执行、退出。
- action 结果必须是 JSON 可序列化的（IPC 与 API 都走 JSON）。
- handler 收到完整 `context`（server、url、window、updater、actions、launchWindow、stop），action 也可以调用 `context.actions.call(...)` 组合其他 action。
- `server` 配置使用 `routes` 时，框架自动合并 `/api/actions`、`/api/actions/:name`、`/__bundesk/actions` 三个保留路径；使用 `fetch` 兜底且没有 `routes` 时不会自动挂载，但 `context.actions` 与 CLI 层不受影响。actions API 默认随 server 绑定（默认 127.0.0.1），请勿在无鉴权时把 hostname 暴露到 0.0.0.0。
- action 名必须是 kebab-case，且不能与框架命令（`serve`、`register`、`unregister`、`status`、`upgrade`）重名。

## 运行环境（development / production）

框架解析应用环境并以 `context.env`（`'development' | 'production'`）暴露。该模式只填充**默认值**——任何显式配置的行为始终优先。

解析优先级（从高到低）：

1. 命令行：`my-app --mode=production`（或 `--mode production`）
2. `BUNDESK_ENV` 环境变量——框架专用覆盖项，应用如需保留 `NODE_ENV` 给自己用，可独立钉住它
3. `NODE_ENV` 环境变量（标准）
4. 默认：**打包后的单二进制为 production，bun 宿主运行为 development**

```ts
onReady: (context) => {
  if (context.env === 'production') {
    // 精简日志、关闭调试端点、……
  }
}
```

当前该模式驱动：

- `Bun.serve({ development })` —— 默认 `context.env === 'development'`（渲染错误页、上下文异常）。在 `server` 选项中显式设置 `development: false` 可无视模式钉死。

非 `development`/`production` 的值永远不会被框架消费：命令行 `--mode=staging` 仍是应用的参数，`NODE_ENV=staging` 也仍可被应用读取——框架只认这两个标准值。

## 全栈页面（HTML imports）

Bun 的打包器可以直接从 HTML 文件提供完整前端管线：import 一个 `.html` 文件并作为路由传入——Bun 会自动打包其中所有 `<script>` 与 `<link>` 标签（TypeScript/TSX/JSX/CSS），把标记重写为哈希资源 URL 并提供。

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

无需自定义前端打包脚本——页面资源属于应用的构建图（`bundesk` 编译时以 AOT 方式产出同一批资源）。

### dev 与 prod 行为

该管线由运行环境切换（见上节）：框架的 `development` 默认值正是 Bun 全栈服务器使用的开关。

| 特性 | dev（`bun server/main.ts`） | prod（编译二进制） |
| --- | --- | --- |
| 资源打包 | 每次请求重新打包 | 缓存（dev 关闭时）/ AOT manifest（编译） |
| Source map | ✅ | ❌ |
| 压缩 | ❌ | ✅ |
| 热模块替换 | ✅（WebSocket 运行时织入客户端） | ❌ |
| 错误详情 | 详细 | 精简 |

已在 bun 1.3.14 实测：dev 响应带 `sourceMappingURL` 与 HMR 客户端；编译单二进制输出压缩后的 `chunk-<hash>.js/css`。

### 开发循环

开发时桌面窗口（webview/webkit）加载 dev server，前端改动直接热更进已打开的窗口——无需重启应用：

```bash
bun server/main.ts          # 窗口打开，HMR 生效
# 修改 src/dashboard.html 或其脚本 → 窗口就地更新
```

在 `server` 选项中加 `development: { console: true }`，可把页面 console.log 经 HMR 连接回显到终端。

## 平台集成

### Linux：XDG 文件关联与 launcher

`register` / `unregister` / `status` 在 Linux 上写入 XDG 标准位置，全部为当前用户级：

- MIME 包：`~/.local/share/mime/packages/<appId>.xml`（扩展名 → `application/x-<progId>`），随后尽力刷新 `update-mime-database`；
- desktop entry：`~/.local/share/applications/<appId>.desktop`（`Exec="<exe>" %F`、`MimeType=`）；
- 默认关联：`~/.config/mimeapps.list` 的 `[Added Associations]`（`--default` 时写入 `[Default Applications]`）。

```bash
my-app register [--default]
my-app unregister
my-app status
```

没有 `update-mime-database` 时注册仍然成功，只是 MIME 缓存不刷新。

### macOS：构建期 `.app` 打包

macOS 没有运行期注册：文件关联、URL scheme 和图标在构建时写进 bundle 的 `Info.plist`，`register`/`status` 命令返回明确的 unsupported 说明。

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
    codesign: false, // 默认在 macOS 主机上做 ad-hoc 签名；false 跳过
  },
})
```

- `outfile` 以 `.app` 结尾时生成 bundle：`Contents/MacOS/<name>` 为可执行文件，`Contents/Info.plist` 含 `CFBundleDocumentTypes`、`UTExportedTypeDeclarations`（自动导出 UTI）和 `CFBundleURLTypes`。
- 非 `.app` 的 darwin `outfile` 保持单文件 Mach-O 形态。
- 在 macOS 主机上默认执行 `codesign --force --deep -s -`（ad-hoc）；交叉构建产物不会签名，分发前必须在 Mac 上签名并公证（`codesign` + `notarytool`）。
- Linux CI 同样可以交叉构建 macOS x64/ARM64 `.app`（Bun 下载同版本 darwin runtime）。

### Termux（Android）

BunDesk 检测到 Termux 环境（`$PREFIX` 指向 `com.termux` 数据目录）时：

- 窗口不再是 Chromium `--app`，而是 Android VIEW intent（`am start` 或 `termux-open-url`），由系统浏览器打开 URL；
- 应用生命周期、单实例、HTTP server、自动升级与普通平台一致；
- `exitWithWindow` 在 Termux 下不生效（intent 立即返回）。

注意：Bun 运行时需能在 Termux 中执行（glibc proot 环境，如 `proot-distro` 内的 Debian/Ubuntu），浏览器侧无额外要求。

## 注册为服务

因为 app 自带 API 层并能 `serve`，它可以作为常驻 headless 服务注册：开机/登录自动启动、不弹窗口、API 一直在线。GUI 交互通过单实例 IPC 转发到服务进程，由 `onSecondInstance` 决定 `launchWindow()` 连回同一 server。

```bash
my-app install-service        # 注册并立即启动
my-app service-status         # 查看注册与运行状态
my-app uninstall-service      # 停止并移除
```

| 平台 | 机制 | 说明 |
| --- | --- | --- |
| Windows | HKCU Run key | 登录自启，无需管理员；真正的 SCM 服务需要原生 `StartServiceCtrlDispatcher`，Bun 无法提供 |
| Linux | systemd user unit | `~/.config/systemd/user/<appId>.service`，`systemctl --user enable --now`；无需 root |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/<appId>.plist`，`launchctl bootstrap gui/<uid>`；日志写入应用数据目录 |
| Termux | termux-boot 脚本 | `~/.termux/boot/<appId>.sh`，由 Termux:Boot 在开机时执行 |

约定：

- 服务以 `"<exe>" serve --no-browser` 运行，注册时固化可执行文件路径；框架的原子自升级在同一路径替换文件，服务无需重新注册；
- `service-status` 的 `active` 字段通过单实例记录（`instance.json` + PID 存活）判断，跨平台一致；
- `install-service` / `uninstall-service` 支持 `--dry-run` 预览；
- 服务使用 `WorkingDirectory`/`RunAtLoad`/`Restart=on-failure`/`KeepAlive` 保证崩溃拉起，应用内的相对路径应基于 `process.execPath` 解析而非 cwd。

## 系统托盘

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: { port: 0, routes: { '/': new Response('Hello') } },
  tray: {
    icon: 'src/app/tray.ico',   // Windows：.ico 或可执行文件路径；默认系统图标
    tooltip: 'My App',
    menu: [
      { label: '打开主窗口', onClick: (context) => context.launchWindow() },
      { separator: true },
      { label: '退出', onClick: (context) => context.stop() },
    ],
    onActivate: (context) => context.launchWindow(),  // 左键点击
  },
})
```

- 配置托盘后，关闭窗口默认**不退出**（`exitWithWindow` 默认为 false），应用驻留托盘；托盘菜单里调用 `context.stop()` 退出；
- 交互回调（`onActivate`、菜单 `onClick`）与 action 一样拿到完整 `context`；
- 托盘图标可运行期更新：`context.tray?.update({ tooltip: '...', icon: '...' })`，`context.tray?.destroy()` 移除。

平台现状：

| 平台 | 状态 | 机制 |
| --- | --- | --- |
| Windows | **已实现** | 纯 `bun:ffi` 调 user32/shell32：`Shell_NotifyIconW` + 隐藏窗口 + 50ms 消息泵，无原生工具链 |
| macOS | 未实现 | AppKit `NSStatusItem` 经 `objc_msgSend` FFI（需 NSApplication/run-loop 配合，可行但脆弱） |
| Linux | **已实现** | StatusNotifierItem over D-Bus：纯 JS D-Bus 客户端（EXTERNAL 认证、wire 编解码）+ com.canonical.dbusmenu；需 session bus 与支持 SNI 的宿主（KDE/XFCE/GNOME + AppIndicator）；不支持的 daemon 优雅降级为无托盘 |
| Termux | 不支持 | Android 无托盘概念 |

Windows 上新注册的图标可能先出现在溢出区（Windows 默认行为），用户拖到主托盘即可；`iconPresent()` 探测对溢出区隐藏图标按文档返回 false。

## 系统通知

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: { port: 0, routes: { '/': new Response('Hello') } },
  notifications: { aumid: 'MyCompany.MyApp' },   // 可选：toast 归属的 AppUserModelID
})

// 应用内任意位置
await context.notify({
  title: '构建完成',
  body: 'release 产物已生成',
})
```

平台机制（`context.notify` 返回是否投递成功）：

| 平台 | 机制 | 点击回调 |
| --- | --- | --- |
| Windows | WinRT toast，经 PowerShell 桥（`Windows.UI.Notifications`） | 未实现（需 AUMID 注册 + activation 处理） |
| Linux | `notify-send`（libnotify，`icon` 走 `-i`） | 无 |
| macOS | `osascript` display notification | 无 |
| Termux | `termux-notification`（termux-api） | 无 |

已知取舍：

- 经典 `Shell_NotifyIcon` 气泡在 Windows 10/11 已被抑制（实测 `NIM_MODIFY` 返回成功但屏幕无任何显示，WinForms 对照同样不显示），所以 Windows 走 toast；
- 默认 toast 以 "Windows PowerShell" 为来源名；配置 `{ aumid }` 并以该 AUMID 创建开始菜单快捷方式后，toast 以你的应用名义出现；
- 点击回调需要 toast activation（启动参数 + 前台激活），列入 roadmap。

## WebView2 窗口（Windows）

除了用系统浏览器打开 App Mode 窗口外，窗口也可以由 WebView2 进程内托管（使用系统 WebView2 Runtime / Edge 统一运行时，不捆绑任何东西）：

```ts
const app = createDesktopApp({
  id: 'my-company.my-app',
  server: {
    port: 0,
    routes: { '/': new Response('<h1>Hello</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  },
  window: {
    provider: 'webview',          // 'browser'（默认）或 'webview'
    path: '/',
    width: 900,
    height: 640,
    title: 'My App',
    onMessage: (message) => console.log('page says:', message),
    onNavigateCompleted: ({ success, errorStatus }) => console.log('navigated:', success, errorStatus),
  },
})
```

- 页面通过 `window.chrome.webview.postMessage` 与应用通信（消息到达 `onMessage`）；窗口句柄（`context.window`）在 `Bun.Subprocess` 表面之上额外提供 `executeScript`、`postMessage` 与 `navigate`。
- WebView2 用户数据目录默认为 `<appData>/WebView2`。
- 实现：无头文件 C shim（COM vtable 布局对照官方 WebView2.h 校验）由 Bun 内嵌 TinyCC 运行时编译。刻意不使用官方 WebView2Loader.dll：shim 从 EdgeUpdate 注册表键读取运行时安装路径，直接调用 `EmbeddedBrowserWebView.dll` 的 `CreateWebViewEnvironmentWithOptionsInternal` 导出。该导出非文档化但事实上 ABI 稳定——它正是官方 loader 自身依赖的同一导出（loader 的环境创建路径就是 GetProcAddress 此导出加一次直调），冻结的二进制无论内嵌 loader 还是本 shim，失败方式完全相同——无原生工具链、无下载二进制，单二进制构建保留。
- 应用提供的页面必须设置真实的 `content-type`（`text/html`）；否则页面按纯文本渲染。

各平台窗口 provider（`provider: 'browser'` 为默认，全平台可用；优先使用 Chromium App Mode，未找到时回退到隔离的 Firefox 窗口）：

CLI 可用 `--browser` / `--webview`（或 `--provider browser|webview`）覆盖配置。CLI 的 `webview` 是跨平台抽象：Windows 映射为 `webview`，Linux 映射为 `webkit`；不支持进程内 WebView 的平台会直接报错。`--no-browser` 仍表示不打开任何窗口。配置文件中的 `window.provider` 使用下表的原始 provider 名称。

| 平台 | 进程内 provider | 状态 | 机制 |
| --- | --- | --- | --- |
| Windows | `webview`（WebView2） | **已实现** | 内嵌 TinyCC 编译的 C shim；直调运行时 `EmbeddedBrowserWebView.dll`（无 loader 二进制） |
| Linux | `webkit`（WebKitGTK） | **已实现** | `webkit2gtk-4.1` C API shim，内嵌 TinyCC 编译（`run_javascript` → `executeScript`，`script-message-received` → `onMessage`）；GTK3/GTK4 两种 webkit 构建均支持（运行时探测底座）；需系统装有 WebKitGTK 栈（如 `pacman -S webkit2gtk-4.1` / `apt install libwebkit2gtk-4.1-0`）；Wayland 下默认禁用 DMA-BUF renderer 以兼容 GBM（启动前设 `WEBKIT_DISABLE_DMABUF_RENDERER=0` 可覆盖）；WSLg 下需设 `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`（GPU 初始化失败时再加 `LIBGL_ALWAYS_SOFTWARE=1`） |
| macOS | `wkwebview`（WKWebView） | 未实现 | `objc_msgSend` FFI shim；可行但最脆弱（ObjC block、NSApplication run loop） |
| Termux | — | 不支持 | Android 无 shell 进程可用的 WebView API；嵌入式 WebView 需构建 APK。VIEW intent（`browser`）是既定路径 |

非 Windows 平台在配置中设置 `window.provider = 'webview'` 会抛错；Linux 配置应使用 `webkit`，但 CLI 仍使用统一的 `--webview`。

## 自动升级

### 静态发布地址

适合对象存储、CDN 或普通 HTTP server：

```ts
import { staticBinaryProvider } from 'bundesk'

const provider = staticBinaryProvider({
  binaryUrl: 'https://downloads.example/my-app.exe',
  changelogUrl: 'https://downloads.example/CHANGELOG.txt',
  version: '1.2.4',
})
```

provider 使用 `HEAD` 的 ETag 检查当前文件；支持 SHA-256 ETag、普通 MD5 和兼容 16 MiB 分片的对象存储 ETag。下载阶段还会校验 Content-Length、`X-Checksum-SHA256` / `Digest`、可选 descriptor SHA-256，以及 Windows EXE 的 `MZ` 文件头。

### GitHub Releases

```ts
import { githubReleaseProvider } from 'bundesk'

const provider = githubReleaseProvider({
  owner: 'OWNER',
  repository: 'REPOSITORY',
  assetName: 'my-app.exe',
})
```

provider 比较当前版本与 release tag，选择指定 asset，并使用 GitHub asset digest（存在时）校验下载。

## 单实例安全模型

BunDesk 不把实例转发接口暴露在应用 routes 中。框架单独启动只绑定 `127.0.0.1` 的 IPC HTTP server，并为每次主实例生成 256-bit 随机 token。token 只写入当前用户应用数据目录的权限受限文件；次实例必须携带 Bearer token 才能转发参数。崩溃留下的 lock/record 会在确认原 PID 已退出后清理。

## 构建配置

在项目根目录创建 `bundesk.config.ts`：

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

构建：

```bash
bunx bundesk
bunx bundesk --config build/bundesk.config.ts
bunx bundesk --target bun-windows-x64-baseline
```

配置文件可以导出数组，一次生成多个平台产物。应用自己的 Tailwind/Vite/Worker 插件直接通过标准 `plugins` 传入，BunDesk 不复制应用构建逻辑。

## Windows 控制台模式

| `windows.console` | 行为 | 场景 |
| --- | --- | --- |
| `detached`（默认） | 双击不分配控制台；终端启动时继承现有终端 | 同时提供 GUI 和 CLI |
| `hidden` | 使用 Bun `hideConsole`，按 GUI 程序运行 | 纯 GUI |
| `inherit` | 保留 Bun 默认控制台行为 | CLI 优先 |

`detached` 通过 Windows `consoleAllocationPolicy` manifest 实现。BunDesk 先修改干净的 `bun.exe` 再编译，避免在 Bun payload 已追加后重写 PE 文件。

## 交叉构建 runtime

Windows 本机且架构一致时，默认复用当前 `bun.exe`。Linux 交叉构建或 baseline/ARM64 构建会下载：

```text
https://github.com/oven-sh/bun/releases/download/bun-v<Bun.version>/<target>.zip
```

可通过 `runtime.downloadUrl` 使用自定义镜像，通过 `runtime.sha256` 固定解压后 `bun.exe` 的校验值。

## 平台范围

| 功能 | Windows | Linux | macOS | Termux (Android) |
| --- | --- | --- | --- | --- |
| HTTP server / 生命周期 | 支持 | 支持 | 支持 | 支持 |
| 浏览器 / 进程内 WebView 窗口 | 支持 / 支持 | 支持 / 支持（WebKitGTK） | 支持 / 不支持 | VIEW intent / 不支持 |
| 安全单实例与参数转发 | 支持 | 支持 | 支持 | 支持 |
| 单文件构建 / `.app` bundle | 单文件 EXE | 单文件 | `.app` bundle | n/a |
| 交叉构建 | 任意平台 → EXE | 任意平台 → 单文件 | Linux/macOS → `.app` | n/a |
| 自动替换当前可执行文件 | 支持 | 底层 API 可用，0.1 不作桌面发布承诺 | 底层 API 可用，0.1 不作桌面发布承诺 | 底层 API 可用 |
| 文件关联 / launcher | 支持（HKCU） | 支持（XDG） | 构建期 Info.plist | 不支持 |
| 服务注册（headless serve） | HKCU Run key | systemd user | launchd agent | termux-boot |
| 系统托盘 | 支持（Win32 FFI） | 支持（SNI D-Bus） | 计划（AppKit FFI） | 不支持 |
| 系统通知 | WinRT toast（PowerShell 桥） | notify-send | osascript | termux-notification |

Windows 控制台模式（`detached`/`hidden`/`inherit`）仅 Windows 有效；`windows`/`runtime` 构建选项要求 `bun-windows-*` 目标，`macos` 选项要求 `bun-darwin-*` 目标且 `outfile` 以 `.app` 结尾。

## Roadmap

完整方案见 [应用迁移与性能基准计划](docs/migration-benchmark-plan.md)。当前只完成选型和实验设计，尚未开始迁移或采集性能数据。

已完成（本轮）：

- macOS 运行时支持（浏览器候选、数据目录、darwin 升级 asset）与 `.app` bundle 构建（Info.plist、UTI/文档类型、URL scheme、图标、ad-hoc codesign）；
- Linux XDG 文件关联、desktop entry、mimeapps 注册（`register`/`unregister`/`status`）；
- Termux（Android）检测与 VIEW intent 窗口；
- **cli + api + gui 三层 action 注册表**（CLI 转发结果回传、`/api/actions`、`/__bundesk/actions` 控制台页）；
- 服务注册（Windows Run key / systemd / launchd / termux-boot）、Windows 系统托盘（纯 Win32 FFI）与系统通知（WinRT toast 桥、notify-send、osascript、termux-notification）。

待评估：

- 第一轮：draw.io Desktop（Electron）、NextChat（Tauri）、NeoHtop（Tauri）、LLMPET（Electron），覆盖 static-heavy、web-first、native-backend 和 small-but-real-backend（状态机 + 计量 + 权限）四类应用；
- 第二轮：MarkText（Electron）、Yaak（Tauri），扩大文件系统、编辑器、数据库、网络、插件和 secret/keychain 的兼容性边界；
- macOS 签名/公证流水线在真实 Mac CI 上的落地；
- **Hermes Agent + Poly**：评估以 [Poly](https://github.com/liooil/poly) 在同一进程中承载 Bun 与 RustPython，将 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 Python agent/runtime 与 BunDesk 桌面壳整合；
- **Oh My Pi + Poly**：评估将 [Oh My Pi](https://github.com/can1357/oh-my-pi) 的 Bun/TypeScript 主体直接接入 BunDesk，并通过 Poly 承载 Python 工具内核。

## 开发与验证

```bash
bun install
bun run typecheck
bun test
bun run pack:check
```

测试覆盖：真实 Windows/Linux 单文件构建与执行、macOS `.app` 交叉构建结构（Mach-O、Info.plist）、Windows PE metadata/manifest、真实 Chromium App Mode 进程、安全单实例转发、action 三层的 API/CLI/转发结果回传、Linux XDG 注册往返、静态升级安装、GitHub release provider，以及 Windows 注册表 dry-run。

## License

MIT
