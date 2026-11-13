# LibreTV Mac

基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的 macOS 桌面应用。使用 **SwiftUI + WKWebView + 内置 Node.js**，安装后在每位用户自己的 Mac 上独立运行，使用者无需安装 Docker、Node.js、Homebrew 或开发工具。

桌面层提供原生窗口、保存路径、找源与并发调度、进程管理和内核更新；发现、直播、播放、历史、设置、下载、缓存及测活判定优先复用官方能力。

1.0.1 修正直播内容区：左侧桌面菜单始终保留，点击直播不会隐藏菜单。网页层隐藏官方顶栏，播放器与频道列表继续复用官方布局；在桌面内容区宽度 768–1023px 时沿用官方双栏显示，更窄窗口保留官方频道抽屉，原版模式的响应式布局不变。

> **当前交付：1.0.1 Local / build 5，仅 Apple Silicon。** 应用为 ad-hoc 签名，PKG 无 Installer 签名、未经 Apple 公证。它是本地安装测试包，不具有正式 Developer ID 分发信任；macOS 可能阻止安装或打开。不要把校验通过理解为已完成全新 Mac 的 Gatekeeper 验收。

## 下载与安装

- [1.0.1 发布页](https://github.com/zyonliu/LibreTV-Mac/releases/tag/v1.0.1)
- [Local PKG：LibreTV-Mac-1.0.1-Local-arm64.pkg](https://github.com/zyonliu/LibreTV-Mac/releases/download/v1.0.1/LibreTV-Mac-1.0.1-Local-arm64.pkg)

适用 Apple Silicon（M 系列芯片），最低构建目标 macOS 14.0。已在 macOS 27.2.1 / SDK 27.2 验证；尚未完成 macOS 14 实机、干净 Mac/VM、Intel 验收。新版系统使用原生玻璃工具栏，旧系统保留系统兼容外观。

1. 从上述发布页下载 Local PKG。
2. 退出正在运行的 LibreTV，双击 PKG，按 macOS 安装器完成安装。
3. 从“应用程序”打开 LibreTV；本地服务随应用启动，关闭主窗口即退出应用和自有后台任务。

安装目标固定为 `/Applications/LibreTV.app`，没有安装脚本、后台守护程序或外部运行时安装步骤。已有影片、导出文件和用户配置不随 app 替换。若系统阻止 Local 包，请查看系统给出的来源与安全提示；本项目不修改系统安全策略。

## 三个独立版本

| 层 | 1.0.1 初始交付 | 版本来源 |
| --- | --- | --- |
| macOS 桌面应用 / PKG | 1.0.1 / build 5 | `macos/Info.plist` |
| 初始官方内核 | 2.22.0 | 官方 Release；构建默认值来自 `package.json.version` |
| 内置 Node.js | 24.22.3 LTS | `scripts/runtime-config.json` |

**官方内核是可变的，不与桌面版号绑定。** `package.json` 的 2.22.0 不是桌面 PKG 版本，不能为发布桌面 1.0.1 把它改成 1.0.1。桌面增强层的 Next/Undici 依赖也不会覆盖已安装或未来更新的官方 Core。

## 桌面功能

| 功能 | 实现边界 |
| --- | --- |
| 原生外观 | 系统标题栏、红黄绿窗口按钮、SwiftUI toolbar 与侧栏；适配官方配色、浅色/深色及降低透明度 |
| 桌面 / 原版 | 保留官方内容 WebView，模式切换不另建一套播放器或数据配置 |
| 发现、直播、播放 | 加载官方页面；桌面模式隐藏重复导航，原版模式保留官方导航 |
| 原版设置、观看历史 | 在专属内容区嵌入实际官方面板，保留其组件和功能 |
| 下载 / 配置导出 | 官方入口、队列、解析与转封装，宿主提供保存目录、系统保存面板和文件写入能力 |
| 播放与下载缓存 | 官方控制开关、配额、淘汰与清理，宿主提供 CacheStorage 文件映射与目录 |
| 找源 | 支持关键词、GitHub 仓库 URL/短名、JSON/M3U 地址，读取 README 和根目录候选文件 |
| 批量测活 | 复用官方 API 与健康判定，桌面只做去重、并发调度、超时和结果展示 |
| 内核更新 | 官方 Release 检查、下载与 SHA 校验、隔离预检、数据备份、切换、失败恢复与回滚 |
| 退出回收 | 关主窗口退出应用，取消测活及下载写入，回收自己的网关、官方服务、增强服务与监督进程 |

源、订阅、观看历史、偏好设置在两种模式间共用同一份持久化 WebKit 数据。不会另维护一套 Swift 来源列表。文件保存前是否询问位置由桌面设置控制，业务开关与缓存策略在官方设置调整。

找源“发现结果”只显示尚未添加的候选。全选 8 项、其中 5 项可添加时，明确显示“8 项已选，其中 5 项可添加”和“添加已选可用项（5）”；添加成功即移出发现结果。关键词检索目前最多取 5 个 GitHub 仓库，不是全网爬虫。

### 测活队列

默认全局 **32** 个在途请求、每 hostname **3** 个，完成一个立即补位；单项桌面等待上限 **8 秒**。队列发完且只剩最后 2 项时，再等最多 **2.5 秒**后放弃尾部慢任务。暂停停止派发并保留已完成结果，继续处理剩余项；终止本轮取消在途及排队任务，失败/超时/取消项可重测。桌面超时不会伪装成官方健康失败。

找源与官方嵌入页访问后保留挂载，切换桌面/原版/设置 tab 不丢失本轮任务。列表每页最多 100 行，状态合并更新；原生传输只允许三条官方测活/解析 API，限制等待任务和响应大小，不为每个源创建进程。

1 万项均匀分布、32 并发时，平均每项 1 秒约 5 分 13 秒，全都等满 8 秒约 41 分 40 秒；这是计算值与模拟队列验证，不是公网实测承诺。同站点集中、服务限流和网络状况会降低吞吐。Node 堆有上限，但不等于整个进程 RSS 硬上限。

## 架构与数据位置

```text
LibreTV.app / SwiftUI
  ├─ 官方内容 WKWebView ─┐
  └─ 桌面增强 WKWebView ─┴─ 同一持久 WebsiteDataStore / IndexedDB / localStorage
                              │
                       127.0.0.1:17891 网关
                              ├─ 官方 Core（独立临时端口）
                              └─ Desktop 增强服务（独立临时端口）
       内置 Node.js + service-host 专属进程组监督
```

`Contents/Resources/Core` 原样保存官方 standalone，`Desktop` 保存独立编译的增强页面，`Runtime` 保存 Node 与监督/网关适配。固定 loopback origin 用于保持网页数据稳定，端口冲突会报错，不会静默换 origin。服务不监听局域网地址。

| 数据 | 默认位置 |
| --- | --- |
| 本机配置、随机会话凭据、日志 | `~/Library/Application Support/LibreTVMac/` |
| 可更新内核、更新下载、备份 | 上述目录的 `Cores/`、`Updates/`、`Backups/` |
| 影片下载 | `~/Downloads/LibreTV/` |
| 官方配置 / 数据源导出 | `~/Documents/LibreTV/Exports/` |
| 官方媒体缓存的磁盘文件 | `~/Library/Caches/LibreTV/Media/` |
| 历史、源、偏好 | macOS 管理的持久化 WebKit 数据存储 |

下载先写自己登记的 UUID `.part`，完成后原子发布，重名另取文件名。退出与崩溃恢复只处理登记的临时文件，不按扩展名遍历删除用户文件。缓存迁移校验受管理文件，失败保留原目录。卸载 app 不自动删除以上用户数据。

## 官方内核更新与兼容范围

在“设置 → 更新”检查官方 Release，下载并验证官方 SHA256SUMS、归档路径、链接和实际版本；隔离启动候选内核，检查状态接口、会话、导航和数据库契约，再备份数据并切换。正在下载时阻止更新和回滚。失败会恢复原内核引用，回滚前另保存当前快照。

当前预检契约为 **Next.js 15、Dexie schema 3 / IndexedDB 30**。已验证官方 **2.21.2 → 2.22.0**、回滚及损坏入口恢复。未来版本如果改变接口或数据格式，会阻止直接安装，需要先适配桌面层；不保证任意未知内核无条件兼容。

当前 2.22.0 少量下载、测活持久化与主题兼容修正位于网关响应层，受**版本、完整文件 SHA-256、唯一替换匹配**限制，标识 `official-2.22.0-desktop-compat-v7`。磁盘上的 Core 文件不修改。新版本不套用旧脚本替换；不能只更新 SHA 来跳过行为验证。

## 开发与构建

开发机需要 Xcode/Swift、Python 3、Git 与网络；使用者安装 PKG 时不需要这些工具。原生玻璃构建要求可链接 macOS 26+ SDK，本次使用 SDK 27.2。

```sh
git clone https://github.com/zyonliu/LibreTV-Mac.git
cd LibreTV-Mac
./scripts/build-macos.sh
open build/LibreTV.app
```

脚本下载固定版本 Node 和官方 Core，先验证 `scripts/upstream-lock.json` 中的归档 SHA，再解包/执行；执行 `npm ci --ignore-scripts`、桌面依赖审计、Web/Swift 编译、打包 app 和 ad-hoc 签名。重复构建保留上一份 app，避免构建失败先丢掉可用产物。

SwiftPM 显式使用 `--build-system native --sdk ...`，用于避开本机 Swift 6.4 默认后端错误记录 SDK 14.0 的行为。native 后端已有弃用提示，未来迁移需继续核验 Mach-O 的真实 linked SDK，不能只改 Info.plist 伪造系统能力。当前最低目标 14.0、linked SDK 27.2。

### 验证与 Local 打包

先取得隔离更新测试用的官方版本，然后启动媒体样本服务：

```sh
python3 scripts/fetch-test-cores.py
python3 tests/serve-media-fixture.py
```

另一终端在仓库根目录执行；媒体服务仅监听 `127.0.0.1:17995`：

```sh
LIBRETV_TEST_MEDIA_URL=http://127.0.0.1:17995/sample.m3u8 ./scripts/verify-macos.sh
./scripts/package-macos.sh
```

打包生成 `dist/LibreTV-Mac-1.0.1-Local-arm64.pkg`，并展开 PKG 比较载荷与已签名 app 的完整清单。重复打包前，仅删除脚本生成的 `build/pkg-stage`。要从展开的载荷执行原生测试，设置 `LIBRETV_TEST_RESOURCES` 指向其绝对 `Contents/Resources` 路径。

发布时将最终记录整理到 `dist/verification/`，完成签名、载荷、依赖与 SHA 校验。`python3 scripts/cleanup-session.py` 只清理明确生成物。`python3 scripts/create-handoff.py` 可生成内部会话交接 zip 与校验记录；本次按要求仅向 Release 上传 Local PKG，内部交接包和 SHA 清单不作为公开附件。

### 目录说明

| 目录 / 文件 | 内容 |
| --- | --- |
| `macos/Sources/LibreTVMac/` | SwiftUI、WebKit 桥、路径/文件管理、服务与更新 |
| `macos/Runtime/` | 网关、监督、精确版本兼容与传输保护 |
| `macos/Resources/desktop-bootstrap.js` | 官方页面宿主文件/缓存/导航能力 |
| `src/app/desktop/`、`src/components/desktop/`、`src/lib/desktop/` | 桌面增强 UI、找源与调度 |
| `scripts/` | 构建、核验、审计、打包与交接脚本 |
| `tests/`、`macos/Tests/` | 真实官方编译代码、服务生命周期与原生集成回归 |
| `docs/` | 实现说明、完整交接、验证、安全审计和原设计参考 |
| `docs/upstream-workflows/` | 原始上游发布工作流示例，停用自动 Docker/Core 发布 |

GitHub CI 仅执行 JavaScript 静态检查和单测；原生、真实服务和 PKG 验证仍由 macOS 脚本完成。桌面标签不会触发原始上游 Docker/standalone 发布流程。仓库保留上游 Web 源码用于追踪与兼容测试，发布 app 的 Core 来自原样官方 Release。

## 本轮验证与安全边界

2026-11-12 的桌面依赖检查：生产、开发、实际 Desktop 载荷以及 Node 官方安全库均为 **0 个已知漏洞命中**。已知受影响的 Undici 6.21.1 作为正对照被检出，该版本不在交付依赖中；网络错误或空元数据使门禁失败。

**按项目要求，不扫描、不升级、不修复官方 Core 依赖。** 官方 Core 只做来源 SHA、完整性和接口兼容验证，桌面审计结论不延伸至官方或未来内核。原生桥/目录/进程安全另有代码复核和回归，已知依赖数据库检查不能证明不存在未知漏洞。

已通过 622 项 Vitest、13 项 Node 回归、13 项 Swift 测试、连续 3 轮下载/更新一致性、PKG 展开后的原生回归与强杀回收。实际关闭主窗口后 5 个自有 PID 消失、3 个端口释放。HLS 的 TS 精确字节和 MP4 可播放性均验证。详情见 [验证报告](docs/VERIFICATION.md)；原始验证记录保留在本地 `dist/verification`。Release 仅上传 PKG。

当前不是 App Sandbox；路径每次使用检查可写性/挂载状态，未来沙盒分发需 security-scoped bookmarks。随机 HttpOnly 会话、同源/frame/方法检查、路径白名单、有界传输、官方 SSRF/TLS 防护与专属进程组回收均保留。未做所有公网源、全部编码、写满、外置卷断连、权限撤销或未来内核的全面保证。

## 文档与交接

- [新会话完整交接](docs/HANDOFF.md)：约束、实现地图、复现命令、更新边界与待验收范围。
- [实现说明](docs/IMPLEMENTATION.md)：共享数据、官方复用、队列与生命周期。
- [验证报告](docs/VERIFICATION.md)：测试结果、证据目录和 Local 签名边界。
- [桌面依赖审计](docs/SECURITY-AUDIT.md)：修复、检查范围与主要来源。
- [保留的官方 README](docs/UPSTREAM-README.zh-CN.md)。

## 许可与致谢

本项目沿用 [AGPL-3.0-or-later](LICENSE)，基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 源码与官方发行包。原始源码基点为 `dce5d6b9afb3fd9603b17a0912d62659921b5810`；桌面层为本仓库的增量实现。官方及 Node.js 许可随应用附带，其他依赖遵循各自许可。

LibreTV 是检索与播放工具，不提供影视内容。请仅访问、下载和分享你有权使用的内容。欢迎围绕桌面适配与可复现问题提交 Issue；涉及官方功能的问题也可查阅上游项目。
