# BunDesk 应用迁移与性能基准计划

状态：**仅完成选型与实验设计，尚未执行迁移、原项目构建或性能测量。**

## 目标

用真实、知名、开源的 Electron/Tauri 应用回答三个问题：

1. 哪类桌面应用适合迁移到 BunDesk，迁移成本来自哪里；
2. BunDesk 在干净构建、增量构建、启动和内存方面的实际差异；
3. BunDesk 单 binary 交付相对 Electron/Tauri 安装器及安装目录的真实体积和文件数量差异。

不使用 hello-world 或框架自带 demo 作为结论依据。测试夹具可以使用本地服务，但迁移应用本身不得以 mock、空实现或静态截图替代真实功能。

## 候选应用

星数为 2026-08-05 选型时的近似值，只用于说明项目规模和知名度，不作为性能结论。

### 第一轮：覆盖三种架构

| 应用 | 原框架 | 规模 | 许可证 | 选择原因 | BunDesk 迁移验收流程 |
| --- | --- | ---: | --- | --- | --- |
| [draw.io Desktop](https://github.com/jgraph/drawio-desktop) | Electron | 约 62k stars | Apache-2.0 | 大型离线 Web 编辑器；资源多，Electron shell 负责文件、菜单、更新和安全策略 | 离线启动；新建并编辑图形；保存、重新打开、导出；重启后恢复；确认无非预期外连 |
| [NextChat](https://github.com/ChatGPTNextWeb/NextChat) | Tauri | 约 88k stars | MIT | Web-first 的 React/Next.js 应用；适合测量“薄桌面壳”迁移 | 创建会话；修改设置；连接本地 SSE 兼容模型服务并完成流式响应；重启后保留会话 |
| [NeoHtop](https://github.com/Abdenasser/neohtop) | Tauri | 约 9k stars | MIT | Rust 后端不是薄壳；可检验 Tauri command 到 Bun HTTP/runtime API 的真实迁移成本 | 展示并刷新真实进程；搜索和排序；启动一次性子进程并结束它；权限错误可见且不误报成功 |
| [LLMPET](https://github.com/myunwang/LLMPET) | Electron | 约 78 stars | MIT | 状态机/计量/权限/进程对账后端为纯 Node 自研；已内置 127.0.0.1 HTTP server + Claude hook POST，与 BunDesk server/action 模型同构；`preload.js` 的 contextBridge 是唯一前后端契约，是 Electron 桥层评估的直接样本；托盘/单实例/权限气泡/终端聚焦（user32）均为 BunDesk 已有面 | 桌宠随 agent 状态变表情（thinking/working/waiting/happy）；授权气泡 allow/deny 一键；token 计量与花费面板；托盘/皮肤/语言切换；Claude 钩子合并写入且卸载可逆；Codex rollout 只读监听与会话恢复；多实例防护 |

第一轮不只选择最容易迁移的 Web wrapper：draw.io 覆盖 Electron/static-heavy，NextChat 覆盖 Tauri/web-first，NeoHtop 覆盖 Tauri/native-backend，LLMPET 覆盖 Electron/small-but-real-backend（状态机 + 计量 + 权限决策），并检验「透明置顶宠物窗口」这类原生窗口需求。

> **LLMPET 与桥层的关系**：LLMPET 的 renderer 契约（contextBridge 暴露的授权/计量 API）正是「有界 Electron 桥」的适用样本——若桥层（`ipcMain.handle` → action、renderer polyfill）获批实施，LLMPET 迁移同时作为桥的验证目标；若桥层不做，LLMPET 以纯改写路径迁移，两者必须作为不同 `variant` 单列，不得混入同一数字。桌面宠物窗口（透明、置顶、可拖动）在系统浏览器 `--app` 模型下不可直接满足，属于预期能力缺口，验收时按「完成迁移」第 5 条如实记录。

### 第二轮：扩大兼容性边界

| 应用 | 原框架 | 规模 | 重点 |
| --- | --- | ---: | --- |
| [MarkText](https://github.com/marktext/marktext) | Electron | 约 56k stars | 文件系统、菜单、剪贴板、窗口状态和 Markdown 编辑器集成 |
| [Yaak](https://github.com/mountain-loop/yaak) | Tauri | 约 19k stars | 数据库、HTTP/gRPC/WebSocket、插件、secret/keychain 等复杂原生后端 |

第二轮只在第一轮暴露出的通用能力已经进入 BunDesk 后启动，避免为每个应用复制私有 bridge。

## 后续 Poly 集成

这两项不进入第一轮 Electron/Tauri 横向基准；它们用于检验 BunDesk 与 [Poly](https://github.com/liooil/poly) 的纵向集成：

1. **[Hermes Agent](https://github.com/NousResearch/hermes-agent) + Poly + BunDesk**
   - Poly 在同一进程承载 Bun 与 RustPython；
   - 先建立 Python 包/原生 wheel 兼容清单；
   - 再确定 TUI、gateway 和 Web UI 哪一层进入桌面窗口；
   - 验证 agent、tool、session、升级和单文件发布，不以 Python sidecar 作为最终方案。
2. **[Oh My Pi](https://github.com/can1357/oh-my-pi) + Poly + BunDesk**
   - Bun/TypeScript 主体直接运行；
   - Python 工具内核迁入 Poly；
   - 保留 Rust 原生组件和浏览器、LSP、DAP 等受管子进程；
   - 验证 CLI/TUI 与桌面窗口共存、会话恢复、升级及 Windows/Linux 单文件构建。

启动这两项前，Poly 至少需要可复现的跨语言模块加载、依赖锁定和应用构建能力；当前 prototype 的低层 JSON bridge 不作为完成标准。

## “完成迁移”的定义

每个应用必须满足：

1. 固定上游 commit、版本、依赖锁文件和许可证；
2. 保留上游 renderer 和业务逻辑，主要替换 Electron/Tauri shell 与 native bridge；
3. 上表验收流程全部通过；
4. 原应用和 BunDesk 版本使用同一份业务数据及本地测试服务；
5. 不支持的能力必须记为失败或明确的兼容性缺口，不能静默移出比较范围；
6. 迁移以可审查 patch、adapter 和构建脚本保存，不复制无关的上游源码历史；
7. 不使用品牌名暗示迁移版本获得上游官方认可。

## 每个应用的执行步骤

1. **冻结基线**：记录上游 URL、commit、release、license、原始构建命令和产物格式。
2. **构建原版**：按上游 release 配置生成 unsigned release；保留完整日志和构建环境快照。
3. **建立能力映射**：逐项列出 Electron IPC/Tauri commands、文件系统、菜单、窗口、更新、keychain、网络和原生依赖。
4. **迁移桌面壳**：将可复用能力实现到 BunDesk；应用专属业务逻辑留在 adapter，不污染框架 API。
5. **功能验证**：使用真实浏览器窗口驱动上表核心流程；记录截图、请求日志和生成文件校验值。
6. **性能测量**：同一机器、同一电源模式、同一 commit，交替测量原版和 BunDesk 版。
7. **发布结果**：提交原始 JSON、环境信息、汇总表、失败记录和复现命令；先公开数据，再写结论。

## 性能指标

### 构建

每个场景至少运行 5 次，报告中位数及最小/最大值，不只挑最快一次：

- `dependency_install_ms`：空依赖目录安装时间，单独报告，不混入打包时间；
- `clean_build_ms`：删除项目 build output 和本项目编译缓存后的 release 构建；包管理器下载缓存保留；
- `noop_rebuild_ms`：不修改源码立即重建；
- `incremental_build_ms`：修改一个固定 renderer 文件后重建，再恢复文件；
- `peak_process_tree_rss_bytes`：构建命令及其子进程的峰值工作集；
- `exit_code` 和完整 stdout/stderr。

Rust `target`、Next/Vite/Svelte 缓存和 Electron/Tauri 输出目录的清理规则必须写入每个应用的基准配置，不能临时手工决定。

### 发布物

同时记录“下载文件”和“安装/解包后的真实布局”：

- 下载产物数量与压缩大小；
- 安装或解包后的文件数量、目录数量、总字节数；
- 主 executable 大小；
- 是否真正单 binary；
- SHA-256；
- 是否携带 Chromium/WebView/runtime/sidecar；
- 用户数据目录不计入发布物，但单独注明首次运行产生的数据。

Electron 的 NSIS/MSI 安装器即使表面是一个文件，也必须测量安装后的 Electron/Chromium、`app.asar`、DLL、locale 和 resources 目录。BunDesk 只有在 runtime、server 和前端资源均嵌入 executable、运行时不依赖同目录 sidecar 时才标记为单 binary。macOS 交付物是 `.app` bundle（Contents/MacOS 单可执行文件 + Info.plist + 可选 Resources/icns），按 bundle 布局测量并单列，不与 Windows/Linux 单 binary 混在一个数字里。系统已有的 Edge/Chrome/Chromium 不计入 BunDesk 发布体积，但必须作为运行前置条件披露。

### 运行时

- `cold_start_to_ready_ms`：清空应用进程后，从 spawn 到首个可交互 UI 标记；
- `warm_start_to_ready_ms`：OS 文件缓存已热时的同一指标；
- `idle_process_tree_rss_bytes`：窗口 ready 后稳定 10 秒的整个进程树工作集；
- 后台进程数量；
- 首次启动新增磁盘字节；
- 核心流程耗时及失败率。

窗口 ready 使用应用内确定性标记或浏览器自动化观察真实 DOM；不能用“进程已创建”代替可交互。

## 公平性约束

- Windows x64 是第一主平台；Linux 原生构建、Linux → Windows x64 交叉构建和 macOS `.app`（含跨平台交叉构建）单列，不与 Windows 本机构建混在一个数字里。
- 固定 Bun、Node、Rust、Electron、Tauri 和包管理器版本。
- 使用 release 模式、相同 renderer 资源和等价 minify/source-map 配置。
- code signing、notarization、上传和网络下载不计入核心 build time；若原脚本无法拆分则额外报告总流水线时间。
- API 测试连接统一的本地 fixture server，避免公网模型延迟污染结果；fixture 只替代外部服务，不替代应用行为。
- 每轮记录 CPU、内存、OS build、磁盘类型、电源模式和 commit；机器配置变化后结果不得直接合并。

## 结果格式

每次测量写入机器可读 JSON，至少包含：

```json
{
  "schemaVersion": 1,
  "app": "drawio",
  "variant": "upstream-electron",
  "upstreamCommit": "<sha>",
  "platform": "windows-x64",
  "toolVersions": {},
  "scenario": "clean-build",
  "samples": [],
  "artifact": {
    "downloadBytes": 0,
    "installedBytes": 0,
    "files": 0,
    "directories": 0,
    "singleBinary": false,
    "sha256": ""
  },
  "functionalChecks": []
}
```

汇总报告必须链接原始 JSON 和失败日志。没有完成核心流程的版本可以展示迁移发现，但不得进入“性能胜出”排名。

## 阶段顺序

1. 固化通用测量器和 JSON schema；
2. 完成 draw.io 原版与 BunDesk 迁移；
3. 完成 NextChat 原版与 BunDesk 迁移；
4. 完成 NeoHtop 原版与 BunDesk 迁移；
5. 完成 LLMPET 原版与 BunDesk 迁移（Electron 桥层若获批，以其验证桥的边界）；
6. 根据四轮迁移提炼 BunDesk 通用 static asset、native bridge 和测试能力；
7. 进入 MarkText、Yaak；
8. Poly 达到前置条件后，依次验证 Oh My Pi 和 Hermes Agent。
