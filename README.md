# MGU 中文应用源

面向 BMW iDrive 7 的免费 MGU Store 软件源。[应用目录](APPS.md)收录 77 款应用，其中 76 款可由 MGU Store 在车机上从源码构建。RAM 麦克风校准目前仅有历史安装包。

## 添加软件源

在 MGU Store 打开 **设置 → 添加软件源（Add source）**，输入以下 GitHub 分支地址。

```text
https://github.com/zhanyce/mgu-apps-zh/tree/main
```

选择应用后，商店会读取该应用的源码。需要 BMW `oap-sdk` 时，商店会使用车机已有的 SDK，再构建和安装。安装需要车机能够访问 GitHub。

部分应用依赖渲染器、Python、媒体后台等运行组件。商店里缺少依赖时，可用同一个入口添加配套运行组件源。

```text
https://raw.githubusercontent.com/zhanyce/mgu-apps-zh/main/runtime/catalog.json
```

旧的 [catalog.json](https://raw.githubusercontent.com/zhanyce/mgu-apps-zh/main/catalog.json) 继续提供已发布的版本，包含 RAM 麦克风校准。后续应用更新发布到 GitHub 源码源。

### Cockpit+ 全屏仪表地图

主源提供 Cockpit+ 驾驶舱增强和全屏地图配套组件。安装时还需要原项目发布的专用渲染器 `cluster-render 2.9.6` 和地图组件 `waze-on-cluster 2.9.2`。专用运行组件源适用于准备安装 Cockpit+ 的车辆。

```text
https://raw.githubusercontent.com/zhanyce/mgu-apps-zh/main/runtime/cockpit-plus/catalog.json
```

专用组件与通用版本共用组件 ID。车机已安装渲染器或仪表地图时，安装前请核对商店显示的运行组件版本及来源。[Cockpit+ 上游说明](https://github.com/Hyperionism/idrive7-cockpit-plus)

## 兼容性

- 中文应用面向 ID7。MGU Store 本体沿用上游的 ID7 和 ID8 兼容范围。HUD、柴油颗粒捕集器、空气悬架等功能需要对应的车辆硬件。
- 同一应用沿用既有应用 ID。安装或更新前可在 MGU Store 中核对来源与版本。
- 浏览器和 Freedoom 首次构建需要下载原项目指定的文件，构建脚本会校验 SHA-256。部分后台服务及手机管理页沿用原项目语言。
- 源码清单、构建输出和 MGU Store 打包格式已在电脑上验证。车机安装、运行和车型适配待实车验证。

## 维护

| 路径 | 内容 |
| --- | --- |
| [mgu-repo.json](mgu-repo.json) | MGU Store 源码入口、构建方式和运行依赖 |
| [sources/projects/](sources/projects/) | 按原项目归档的源码，`SOURCE.json` 记录原项目提交和归档 SHA-256 |
| [sources/zh/](sources/zh/) | 共用简体中文词条和字库 |
| 各应用的 `store-source.json` 或 `mgu-app.json` | 源码版本、中文译文或车机链接所需的模块 |
| [runtime/catalog.json](runtime/catalog.json) | 配套运行组件的版本、下载地址和 SHA-256 |
| [data/source-exceptions.json](data/source-exceptions.json) | 仅提供历史安装包的应用及原因 |

更新应用时固定到原项目的完整 Git 提交，维护中文界面用词，并核对它需要的运行组件。应用使用独立的三段版本号。更新源码或译文时提高相应版本，再更新目录和检查清单。

```sh
python3 tools/build.py index
python3 tools/build.py check
python3 tools/check_source_repo.py
```

欢迎提交新应用和译文修订。新增应用请附原项目、源码许可证、适用的 iDrive 版本和所需的运行组件。反馈显示问题时，请注明应用 ID、版本、界面位置和车机型号。

## 来源与许可

应用从各原项目的源码构建，保留上游版权和许可证。已在原项目合入的社区译文与本仓库维护的译文一起使用。暖机助手和制动测试等历史安装包可追溯到小白仓库，该仓库也供历史来源核对。[小白仓库（MGU-CN-XIAOBAI）](https://github.com/JackieZ123430/MGU-CN-XIAOBAI)

本仓库原创的目录说明和构建工具采用 MIT 许可证。应用、字体和运行组件适用各自的许可证。公开源码包含构建所需的代码、配置和可分发资源。BMW 原厂 SDK 由车机提供。[构建工具许可证](LICENSE) · [上游许可证目录](licenses/)

Cockpit+ 源码保留 GPL-3.0 许可证。仪表布局、仪表中央数据和仪表信息叠加沿用上游的 PolyForm Noncommercial 1.0.0 许可证，供非商业使用，源码和安装包均保留上游许可及署名。[Cockpit+ 许可证](sources/projects/Hyperionism--idrive7-cockpit-plus/LICENSE) · [仪表应用许可证](sources/projects/eroobeeroo--idrive7-cluster-info/LICENSE)

Freedoom 使用的 WebAssembly 引擎及其构建脚本对应的源码随仓库提供。[Doom 引擎源码](sources/doomgeneric.tar.gz)
