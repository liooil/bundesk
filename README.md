# bun-desktop-app

把 Bun 本地 Web 应用打成单文件桌面可执行程序。它封装 `Bun.build({ compile })`，并补上跨平台构建 Windows EXE 时最容易重复、出错的部分：图标、版本资源、可复现的 Bun runtime 下载，以及浏览器 App Mode 应用需要的控制台策略。

这个包只负责**构建**。HTTP server、Edge/Chrome `--app=<url>` 启动、单实例、自动升级和文件关联属于应用运行时，不在包内；不同应用对这些行为的要求差异很大，不应被打包器绑定。

## 设计边界

这个包专注于可复用的构建链路：

1. 保留应用自己的 Bun 插件、`define`、HTML/Worker 资源和 server entrypoint；
2. 统一 Bun 单文件编译、Windows runtime 获取、PE 资源修改、失败处理和 SHA-256 输出；
3. 默认下载与当前 Bun **同版本**的 GitHub Release，而不是不稳定的 `latest`；
4. 默认采用 `detached` 控制台策略：从资源管理器双击时不弹黑框，从已有终端启动时仍可输出日志。

## 安装

当前从 GitHub 安装：

```bash
bun add -d github:liooil/bun-desktop-app
```

包名 `bun-desktop-app` 已为以后发布 npm 保留同一使用方式：

```bash
bun add -d bun-desktop-app
```

要求 Bun 1.3.14 或更新版本。

## 配置

在项目根目录创建 `desktop-app.config.ts`：

```ts
import { defineConfig } from 'bun-desktop-app'

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

运行：

```bash
bunx bun-desktop-app
```

也可以显式指定配置和覆盖 target：

```bash
bunx bun-desktop-app --config build/desktop.config.ts
bunx bun-desktop-app --target bun-windows-x64-baseline
```

配置文件可以导出数组，一次生成多个平台产物：

```ts
import { defineConfig } from 'bun-desktop-app'

const shared = {
  entrypoint: 'server/main.ts',
  minify: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
  },
}

export default defineConfig([
  {
    ...shared,
    outfile: 'dist/my-app.exe',
    target: 'bun-windows-x64',
    windows: {
      console: 'detached',
      icon: 'favicon.ico',
      title: 'My App',
      version: '1.2.3',
    },
  },
  {
    ...shared,
    outfile: 'dist/my-app',
    target: 'bun-linux-x64',
  },
])
```

### 使用项目自己的 Bun 插件

插件保持在应用仓库中，通过标准 `plugins` 传入。例如 React/Tailwind 或 Worker URL 处理：

```ts
import tailwindPlugin from 'bun-plugin-tailwind'
import { defineConfig } from 'bun-desktop-app'
import { browserWorkerUrlPlugin } from './scripts/browser-worker-url-plugin'

export default defineConfig({
  entrypoint: 'server/main.ts',
  outfile: 'dist/my-app.exe',
  plugins: [tailwindPlugin, browserWorkerUrlPlugin()],
  define: {
    __BROWSER_WORKER_MANIFEST__: JSON.stringify(await buildWorkerManifest()),
  },
  windows: {
    icon: 'favicon.ico',
    title: 'My App',
    version: '1.2.3',
  },
})
```

## API

也可直接从构建脚本调用：

```ts
import { buildDesktopApp } from 'bun-desktop-app'

const output = await buildDesktopApp({
  entrypoint: 'server/main.ts',
  outfile: 'dist/my-app.exe',
  windows: {
    title: 'My App',
    version: '1.2.3',
  },
})

console.log(output.outfile, output.size, output.sha256)
```

构建失败会抛出 `DesktopBuildError`，不会像旧脚本一样只打印错误后以成功状态结束。

## Windows 控制台模式

| `windows.console` | 行为 | 适用场景 |
| --- | --- | --- |
| `detached`（默认） | 双击不分配控制台；从终端启动时继承终端 | 同时提供 GUI 和 CLI 的工具 |
| `hidden` | 使用 Bun 的 `hideConsole`，始终按 GUI 程序运行 | 纯 GUI 应用 |
| `inherit` | 保留 Bun 默认控制台行为 | CLI 或需要固定控制台窗口的程序 |

`detached` 通过 Windows 11 `consoleAllocationPolicy` manifest 实现。包先修改干净的 `bun.exe`，再把它传给 Bun 的 `executablePath`；不能在编译完成后重写 EXE，否则可能破坏 Bun 追加在 PE 文件后的应用 payload。

## Runtime 下载与自定义镜像

Windows 本机、架构一致且目标为标准 target 时，默认直接复用当前 `bun.exe`。交叉编译或 baseline/ARM64 构建会下载：

```text
https://github.com/oven-sh/bun/releases/download/bun-v<Bun.version>/<target>.zip
```

可显式覆盖，适合自定义镜像或固定校验：

```ts
runtime: {
  version: '1.3.14',
  downloadUrl: 'https://mirror.example/bun-windows-x64.zip',
  sha256: '<extracted-bun.exe-sha256>',
  cacheDir: '.cache/bun-desktop-app',
}
```

`sha256` 校验的是 ZIP 中解出的 `bun.exe`，不是 ZIP 文件。

## 迁移现有构建脚本

现有应用通常只需：

1. 安装此包；
2. 把原构建脚本中的项目参数移到 `desktop-app.config.ts`；
3. 保留项目特有的插件和构建前资源生成；
4. 将 `build:win` 改为 `bun-desktop-app`；
5. 删除仅供旧打包脚本使用的 PE、ZIP 和 XML 处理依赖。

## 开发

```bash
bun install
bun run typecheck
bun test
bun run pack:check
```

Windows 集成测试会真实生成并运行一个 EXE，然后读取其 manifest 和版本资源；非 Windows 环境跳过该平台测试。

## License

MIT
