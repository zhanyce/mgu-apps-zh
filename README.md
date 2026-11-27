# MGU 中文应用源

面向 BMW iDrive 7 的免费 MGU Store 软件源。收录 73 款应用和 21 个运行组件，涵盖车辆仪表、诊断、座舱、导航与娱乐。可按用途浏览[应用目录](APPS.md)，每款应用都附原项目、源码和发行版本。

## 添加软件源

在已安装的 MGU Store 中打开 **设置 → 添加软件源（Add source）**，输入以下完整地址，保存后刷新列表。

```text
https://raw.githubusercontent.com/zhanyce/mgu-apps-zh/main/catalog.json
```

例如，搜索「暖机助手」可找到机油和冷却液温度应用，搜索「泊车距离」可找到泊车雷达显示应用。安装界面会列出所需的组件。没有安装商店的车机，请先查阅 [MGU Store 项目说明](https://github.com/robertnisipeanu/mgu-store)。

## 兼容性与版本

- 72 款中文应用标注为 ID7，MGU Store 本体沿用上游发布的 ID7 / ID8 包。HUD、柴油颗粒捕集器、空气悬架等功能还需要对应的车辆硬件。
- 中文包保留应用 ID，并使用独立的三段版本号。已安装同 ID 应用时，请在商店中核对来源和版本。
- Vizualyse 的车机前台使用简体中文，后台采用原项目发布的对应版本，手机管理页沿用上游语言。联网媒体服务沿用各自的账户与访问条件。
- 已在电脑上验证目录、安装包结构、版本、依赖和 SHA-256。实车上的文字显示、控制器响应和车型适配仍需按配置验证。

## 维护目录和译文

| 路径 | 内容 |
| --- | --- |
| [data/apps.json](data/apps.json) | 中文名称、原项目、上游版本和已验证的源码构建配置 |
| [translations/](translations/) | 按应用 ID 保存的菜单译文、设置译文、字库和源码补丁 |
| [data/tools.json](data/tools.json) | 运行组件、依赖、原项目提交及下载地址 |
| [packages/](packages/) · [icons/](icons/) | 本源发布的中文安装包和应用图标 |
| [tools/build.py](tools/build.py) | 构建已登记的源码项目，生成软件源目录并校验发行包 |

使用 Python 3.9 或更高版本。校验已下载的仓库可离线执行。

```sh
python3 tools/build.py check
```

`rebuild` 构建带 `sourceBuild` 的应用和组件。它按原项目的完整 Git 提交下载源码归档，校验大小和 SHA-256，后续使用 `.cache` 中的同一份归档。未迁移的应用继续用 `packages/` 中的已发布版本。重建运行组件需要 Node.js，已使用 Node.js 22 验证。

```sh
python3 tools/build.py rebuild
python3 tools/build.py check
```

单独重建西洋双陆棋可运行 `python3 tools/build.py rebuild --only dk_backgammon`。它使用原项目的 `mgu-app.json` 和源码，由本仓库的[译文与补丁](translations/source/)生成简体中文界面。`idrive7-renderd` 和 `mgu-inputgate` 使用原项目提交中的组件清单、预编译文件和 MGU Store 的标准组件打包工具，发布包的 SHA-256 与迁移前一致。

需要 BMW `oap-sdk` 的应用按各原项目的构建流程验证后再迁移。SDK 只放在有授权的构建环境，公开软件源发布按 MGU Store 规范生成的可分发包。

`upstreamVersion` 记录当前包对应的原项目版本，`version` 用于软件源更新。修改界面或包内元数据时递增 `version`。仅修改分类、标题或商店说明时，运行 `python3 tools/build.py index` 更新索引。

格鲁吉亚限速提示、仪表主题和 HUD 小组件的[中文字库](translations/fonts/)使用 Noto Sans SC。两款仪表应用在原字库上补入时区名称所需的汉字。字体文件的 SHA-256 记录在字库的 `source` 字段，字体许可随字库和安装包提供。

欢迎提交新应用和译文修订。新增应用请附原项目、可再分发的许可证、对应源码、适用的 iDrive 版本及运行依赖。反馈中文显示问题时，请注明应用 ID、版本、界面位置与车机型号。

## 来源与许可

新版本从各应用的原项目源码构建，译文由本仓库维护。暖机助手、制动测试等应用的历史发布包来自小白仓库的简体中文包。小白仓库供译文参考和历史来源核对。[小白仓库（MGU-CN-XIAOBAI）](https://github.com/JackieZ123430/MGU-CN-XIAOBAI) · [应用目录](APPS.md)

本仓库原创的目录说明和构建工具使用 [MIT 许可证](LICENSE)。应用、字体和运行组件适用各自的许可证。中文界面沿用社区译文，界面和商店列表已移除翻译推广文字。作者信息、版权声明及第三方许可随包保留。[许可证目录](licenses/)

应用安装包内的 `SOURCE.json` 记录对应源码、构建或修改说明以及输入校验值。Freedoom 所用 WebAssembly 引擎的对应源码和构建脚本也随仓库提供。[Doom 引擎源码](sources/doomgeneric.tar.gz)
