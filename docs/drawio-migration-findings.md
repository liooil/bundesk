# draw.io 迁移与发布体积实验结论

状态：**原型与首轮量化完成，生产等价迁移尚未完成。**

基准日期：2026-08-24。上游固定为
[draw.io Desktop v31.3.2](https://github.com/jgraph/drawio-desktop/releases/tag/v31.3.2)，
commit `c52df06`，Electron `42.9.3`。应用改造、原始 JSON 和复现脚本保存在独立的
`bundesk-drawio` 仓库，本文只记录对 BunDesk 的决策结论，避免在两个仓库维护两份测量事实。

## 结论

draw.io 迁移是 **Conditional Go**，主要收益是终端磁盘与分发体积，不是开发速度。

- 完成资源嵌入后，Windows/macOS 单应用安装占用预计减少
  **324.9–370.4 MB（72.8%–74.1%）**；Linux AppImage 单文件减少
  **94.3 MB（55.9%）**。
- 使用与官方包相同的压缩机制后，BunDesk 下载产物预计为
  **73.6–80.1 MB**，相对官方包减少 **43.9%–55.9%**。此前把未压缩
  BunDesk payload 与压缩后的官方安装器直接比较所得的“Windows 只小约 2.5%”
  结论无效。
- 达到生产等价预计共需 **26–46 人日**，其中尚需 **20–36 人日**；推荐的月度
  跟版维护还需 **18–36 人日/年**。第一年合计为 **44–82 人日**。
- 高频构建情景下，构建加速扣除当前 Linux 启动退化后只净省约 **2.9 小时/年**，
  不能单独覆盖维护一个上游 fork 的成本。

只有在磁盘或下载流量是明确 KPI，且 bridge、打包、签名和三平台回归能力能被多个
BunDesk 产品复用时，才应继续生产化。若只是迁移 draw.io 单品或追求更快构建，应停在
原型阶段。

本文中的 MB、GB 和 TB 均为十进制单位；只有标为 MiB 的内存数据使用二进制单位。

## 同款压缩实验

### 下载产物

| 平台和官方对照 | 官方下载包 | BunDesk 未压缩 payload | 同款压缩后 | 相对官方减少 |
| --- | ---: | ---: | ---: | ---: |
| Windows x64 NSIS | 141.8 MB | 138.3 MB | 79.6 MB | 62.2 MB / 43.9% |
| Linux x64 AppImage | 168.8 MB | 114.7 MB | 74.5 MB | 94.3 MB / 55.9% |
| macOS arm64 ZIP | 155.6 MB | 113.4 MB | 73.6 MB | 82.1 MB / 52.7% |
| macOS arm64 DMG | 161.5 MB | 113.4 MB | 74.2–80.1 MB | 81.4–87.3 MB / 50.4%–54.1% |

三个 payload 都由实测宿主加同一份 `48,865,112` byte renderer archive 组成；最终把
renderer 嵌入可执行文件的链路尚未完成，因此这里仍是压缩投影，不是已签名 release。

使用的机制与上游一致：

- Windows：NSIS 内层 `app-64.7z`，`LZMA2:20 + BCJ`、1 MiB dictionary、
  non-solid，再计入实测 NSIS wrapper 开销；
- Linux：AppImage 12.0.1 runtime，ZLIB SquashFS、128 KiB block，并包含兼容库和
  embedded blockmap；
- macOS ZIP：app-builder-lib 的 Deflate level 7；
- macOS DMG：官方使用 UDZO/zlib。Linux 不能运行 `hdiutil`，因此以同款 1 MiB 分块
  zlib level 9 数据和官方 DMG-vs-ZIP 差值给出范围。

单次压缩约耗时 Windows 4.4 秒、Linux 3.8 秒、macOS ZIP 18.1 秒。它只影响 release
流水线，不应进入日常增量构建热路径。

### 安装占用

| 平台/安装形态 | Electron | BunDesk | 每应用减少 |
| --- | ---: | ---: | ---: |
| Windows x64，NSIS 安装后 | 508.7 MB | 138.3 MB | 370.4 MB / 72.8% |
| Linux x64，AppImage 单文件 | 168.8 MB | 74.5 MB | 94.3 MB / 55.9% |
| Linux x64，解包/系统包参考 | 468.6 MB | 114.7 MB | 353.9 MB / 75.5% |
| macOS arm64，复制 `.app` 后 | 438.4 MB | 113.4 MB | 324.9 MB / 74.1% |

Windows/macOS 的外层压缩只减少下载量，安装后仍恢复为原始 payload；安装占用的收益
来自不再随应用携带 Electron/Chromium。Linux AppImage 则直接以压缩的单文件运行，
所以同一个 74.5 MB 同时是下载大小和常驻文件大小。Linux 的 468.6 MB 只适用于
deb/rpm 或主动解包部署，不能当成默认 AppImage 安装占用。

若十个产品都达到 draw.io 同量级的节省，每台设备可累计减少：

| 平台 | 十个产品/设备 | 一千台设备 |
| --- | ---: | ---: |
| Windows x64 | 3.70 GB | 3.70 TB |
| Linux x64，AppImage | 0.94 GB | 0.94 TB |
| Linux x64，解包部署 | 3.54 GB | 3.54 TB |
| macOS arm64 | 3.25 GB | 3.25 TB |

这只是按 draw.io 体量外推的容量情景，不是所有 BunDesk 应用的固定收益。按一千台设备、
每月一次完整包下载计算，全年下载流量上界可减少约 Windows 0.75 TB、Linux 1.13 TB、
macOS ZIP 0.98 TB；启用 blockmap/differential update 后，日常更新收益通常会低于这个
完整包上界。

## BunDesk 的发行设计结论

压缩应是**可选发行层**，不能改变 `bun build --compile` 产生的原始应用，也不能让默认
开发流程依赖 electron-builder。具体 CLI/API 另行设计，但产物语义应遵循下表：

| 平台 | 保留的规范产物 | 可选压缩发行物 | 单文件语义 |
| --- | --- | --- | --- |
| Windows | 可直接运行的 portable 单 EXE | NSIS/LZMA2 安装器 EXE | 下载包仍是一个文件，但它是安装器；安装后主应用仍为单 EXE |
| Linux | 可直接运行的原始单文件 | AppImage/SquashFS | AppImage 本身可直接运行，同时满足压缩和单文件 |
| macOS | `.app` bundle | ZIP 或签名/公证后的 DMG | 保持 macOS bundle 语义，不宣称为单 binary |

由此得到五项框架要求：

1. Windows 同时提供 raw portable EXE 和可选压缩安装器，不能用安装器替代 portable
   模式后仍称两者语义相同。
2. release 报告必须同时给出 `raw payload`、`download artifact` 和 `installed layout`，
   禁止再次比较未压缩文件与压缩安装器。
3. 压缩器只包装确定性构建结果；签名前验证解包、资源校验值和启动 smoke，签名后再验证
   产物完整性。
4. renderer 资源嵌入应先独立完成。外层压缩不能证明运行时能从 executable 内加载资源。
5. 平台打包器适合放在可复用的 release adapter/CI 层；不应把应用专属的
   electron-builder 配置复制进 BunDesk 核心。

## 成本、运行时与维护

| 维度 | 首轮结果 | 对决策的含义 |
| --- | --- | --- |
| 生产等价改造 | 26–46 人日，其中剩余 20–36 | 先做风险消除阶段，不按“画布能打开”估算完成度 |
| 月度合批跟版 | 18–36 人日/年，中位 27 | 只有多产品复用平台能力才能摊薄 |
| host-only package | 8.989 秒 → 0.206 秒，43.7× | 倍率高，但绝对时间小 |
| renderer 变化后的 package | 8.989 秒 → 至少 2.216 秒，至多 4.1× | 仍需计入 renderer 构建 |
| Linux 画布可用 | 2.627 秒 → 6.334 秒，慢 2.41× | 生产化前必须优化 |
| Linux 进程树 RSS | 954,260 KiB → 767,716 KiB | 少 182.2 MiB / 19.5% |

上游近三个月样本中，12 次相邻稳定版本升级有 9 次修改 Electron main/preload、11 次
修改 renderer 的 `ElectronApp.js`。action 名称相对稳定不代表 renderer 语义稳定，因此
维护预算必须包含 upstream diff、adapter 修正、测试更新和三平台验收。

## 尚未证明的部分

- renderer archive 尚未真正嵌入 BunDesk executable；当前压缩输入是宿主与 archive 的
  组合 fixture。
- Windows/macOS 尚未在真实目标系统完成运行、签名、公证和升级验收。
- macOS DMG 是校准范围，必须在 macOS CI 用 `hdiutil` 生成最终数据。
- 三个平台的压缩容器均通过 `7za test`；Linux AppImage smoke 仍显式使用外部 pinned
  renderer，只证明容器和宿主可运行。
- 官方 draw.io CI 会裁剪 renderer，而 BunDesk fixture 未做相同裁剪；当前比较对
  BunDesk 偏保守，但最终 release 必须重新测量。
- Linux 首屏启动仍比 Electron 慢 3.707 秒，Windows/macOS 还没有同口径运行数据。

`external-Bun` 完全不在本次收益模型中。它仍属于独立实验分支，未合入 BunDesk；本文
所有多产品数据都假设每个产品继续携带自己的 Bun runtime。发布压缩与 runtime 共享是
两个正交问题，不能用其中一个的投影替另一个记收益。

## 下一阶段门槛

先投入 **7–13 人日**完成 hidden renderer export（4–8 人日）和真实资源嵌入/签名骨架
（3–5 人日）。只有同时满足以下条件才进入剩余生产化工作：

1. 三平台最终产物不超过上述预测的 110%，Windows/macOS 可正常签名；
2. export、未保存关闭、文件关联和升级路径有可重复验收；
3. Linux 画布可用时间降到 Electron 基线 +1 秒以内；
4. 明确采用月度或季度跟版 SLA，不承诺逐版同步；
5. 用真实设备数、产品数、工程人日成本和磁盘/流量价值验证第一年及稳态 ROI。

## 数据来源与复现

独立仓库基线：`bundesk-drawio@bef22bf`。

- 汇总报告：`docs/cost-benefit.md`
- 成本与运行数据：`benchmarks/cost-benefit-2026-08-24.json`
- 压缩原始数据：`benchmarks/compression-2026-08-24.json`
- 压缩复现脚本：`scripts/measure-compression.ts`

在该仓库本地生成物存在时运行：

```sh
bun run measure:cost
bun run measure:cost:check
bun run measure:compression
bun run measure:compression:check
```

跨机器复测应新增带日期的 JSON 快照，不覆盖本次数据。生产签名产物完成后，应以最终
release 重新跑同一套口径，并把这里的“投影”更新为“实测”。
