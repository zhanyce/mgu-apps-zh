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
| [data/apps.json](data/apps.json) | 分类、中文名称与说明、原项目、对应源码、输入包和校验值 |
| [translations/](translations/) | 以应用 ID 保存的设置项译文，重建时同步更新车机文字、运行时词典并检查中文字形 |
| [data/tools.json](data/tools.json) | 运行组件、最低依赖版本和下载地址 |
| [packages/](packages/) · [icons/](icons/) | 本源发布的中文安装包和应用图标 |
| [tools/build.py](tools/build.py) | 校验输入包，整理界面资源，生成目录和应用索引 |

使用 Python 3.9 或更高版本。校验已下载的仓库可离线执行。

```sh
python3 tools/build.py check
```

修改商店分类、标题或组件说明后，用 `python3 tools/build.py index` 更新索引。修订已有设置项时，可参照 [暖机助手译文](translations/warmup.json) 填写车机字符串 ID、英文原文、设置键和新译文。修改应用界面或包内元数据，需要递增对应应用的 `version` 并重建。首次重建通过 curl 下载校验值匹配的输入包，后续复用本地缓存。

```sh
python3 tools/build.py rebuild
python3 tools/build.py check
```

菜单和运行时提示的修订保存在 [translations/menus/](translations/menus/)，按应用 ID 分文件维护。设置清单中的 `menuRevision` 为修订日期，并递增 `version`。构建时使用输入包自带的中文词典，再应用本源修订。选项只翻译显示名称，车机保存的选项值保持原样。

格鲁吉亚限速提示的 [中文字库](translations/fonts/) 使用 Noto Sans SC，覆盖原字库和菜单修订中的字符。字体文件的 SHA-256 记录在字库的 `source` 字段，字体许可随字库和安装包提供。

欢迎提交新应用和译文修订。新增应用请附原项目、可再分发的许可证、对应源码、适用的 iDrive 版本及运行依赖。反馈中文显示问题时，请注明应用 ID、版本、界面位置与车机型号。

## 来源与许可

本仓库原创的目录说明和构建工具使用 [MIT 许可证](LICENSE)。应用、字体和运行组件适用各自的许可证。中文界面沿用社区译文，界面和商店列表已移除翻译推广文字。作者信息、版权声明及第三方许可随包保留。[许可证目录](licenses/) · [中文发行包来源](https://github.com/JackieZ123430/MGU-CN-XIAOBAI)

每个重建包的 `SOURCE.json` 记录对应源码、修改说明、输入包地址和 SHA-256。Freedoom 所用 WebAssembly 引擎的对应源码和构建脚本也随仓库提供。[Doom 引擎源码](sources/doomgeneric.tar.gz)
