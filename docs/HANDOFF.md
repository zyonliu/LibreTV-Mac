# 新会话交接：LibreTV Mac

先阅读本文件、IMPLEMENTATION.md 和 VERIFICATION.md，再修改代码。

## 工程与状态

仓库：https://github.com/zyonliu/LibreTV-Mac；桌面发布标签 `v1.0.0`。原始上游：https://github.com/LibreSpark/LibreTV；上游源码基点 `dce5d6b9afb3fd9603b17a0912d62659921b5810`。始终在本仓库根目录执行命令。发布源码和本地交接记录同版本；按最终交付要求，GitHub Release 仅上传 Local PKG，会话交接 zip 和 SHA 清单留在本地。精确源码提交见本地 dist/verification/source-publication.json。zip 不含 .git、node_modules、生成物、用户配置或凭据。

桌面版 1.0.0/build 4，初始捆绑官方 2.22.0，内置 Node 24.22.3。交付 `LibreTV-Mac-1.0.0-Local-arm64.pkg`；继续采用用户明确选择的 Local、ad-hoc app、无 Installer 签名/公证。2026-11-12 已恢复联网并修复桌面依赖，当前结果见 VERIFICATION.md 与 verification/security/summary.json；早先“网络失败未完成”的记录已由本轮结论替代。

**最新用户明确限定：官方包不管，只扫描我们的代码；LibreTV 内核是可变的。** 审计/修复仅覆盖桌面工程生产与开发依赖、实际 Desktop 载荷、原生桥/Runtime 和内置 Node。不得扫描或改写 Core 的 node_modules，不得把桌面 Next/PostCSS 版本推给官方包。Core 仅验证官方归档完整性与接口兼容，保持可独立替换、升级和回滚。

## 不可丢失的用户要求

1. 每人自己的 Mac 独立运行，安装者无需 Docker、Node、Homebrew、开发工具；技术栈 SwiftUI + WKWebView + 内置 Node。
2. 官方优先，复用发现/直播/播放/历史/设置/下载/缓存/测活判定；桌面只增加导航、路径、找源、并发调度和更新，减少重复实现。
3. 桌面与原版源、订阅、历史、设置共用。历史与原版设置在自己的内容区显示真实官方面板，隐藏其他模块，不在发现/直播弹出替代面板。
4. 桌面隐藏重复官方顶栏，原版保留；外壳颜色随官方，布尔项使用 Apple 开关，多行选择仍为复选框。侧栏收起图标反向且可稳定点击。
5. 下载/导出/缓存路径由宿主提供；引擎、开关、配额、淘汰策略归官方，不另造下载器或缓存策略。
6. 测活快速补位，32 全局、每 hostname 3、单项 8 秒；末尾 2 项再等最多 2.5 秒。暂停/继续/终止/重测与跨页保留任务。资源有界，不为每源开进程。
7. 关主窗口即退出软件、本地内核和全部测活，正常/强杀都回收专属组；不能全局 pkill Node。
8. 可添加数和选中总数分开，已添加移出发现结果，重复搜索也排除已添加。
9. 官方内核后续可更新，原样 Core、预检/备份/恢复/回滚，未知未来版本必须验证，不能保证无条件兼容。
10. 原生玻璃参考是用户给出的 Finder。保留系统窗口按钮/toolbar，不绘制假红黄绿、不改官方源码仿造。

## 实现地图

| 路径（相对项目） | 职责 |
| --- | --- |
| macos/Sources/LibreTVMac/LibreTVMacApp.swift | 原生窗口/toolbar/侧栏/关窗退出 |
| WebContainer.swift | 两个保留 WebView、共享数据、桥接、主题、导航 |
| ServiceManager.swift、Runtime/service-host.cjs | 服务生命周期、父 PID 监测、专属组回收 |
| Runtime/gateway.cjs | 稳定 loopback origin；官方/增强后端私有端口；响应适配 |
| Runtime/official-compat.cjs | 2.22.0 精确 SHA 下载/测活持久化/主题适配，标识 v7 |
| Runtime/official-limits.cjs | 测活上游断连取消、8MiB 响应上限，不改判定 |
| OfficialProbeTransport.swift | 32 连接、64 等待、4MiB，限制三条官方 API |
| Downloads.swift、Preferences.swift | 保存路径、流、WKDownload、part ledger、缓存迁移 |
| CoreInstaller/CorePreflight/LocalUpdateManager.swift | 官方 SHA/归档/运行/DB/API 预检，备份、回滚 |
| macos/Resources/desktop-bootstrap.js | 文件 API、CacheStorage 文件映射、主题和面板适配 |
| src/components/desktop、src/lib/desktop、src/app/api/desktop | 设置/找源/队列/更新/磁盘与同源接口 |
| tests、macos/Tests | 官方编译代码回归、实际服务/下载/升级、资源边界 |
| scripts | build/package/audit/verify/fetch-test-cores/create-handoff/cleanup |
| docs/ui-reference.html | 用户原设计，不能作为垃圾删除 |

表中 Swift 文件未写完整目录时均位于 `macos/Sources/LibreTVMac/`；Runtime 位于 `macos/Runtime/`。

Core、Desktop、Runtime 在 app 的 Contents/Resources 内独立保存。固定 origin 127.0.0.1:17891，端口冲突报错，不随意换端口导致网页数据丢失。原版内容共用一个 WebView；增强设置为另一保留 WebView，同一持久 WebsiteDataStore/IndexedDB/localStorage。

精确适配三份官方 chunk：354 下载、312 设置/主题、app/layout 另一份主题；当前 `official-2.22.0-desktop-compat-v7`。版本/SHA/唯一替换必须同时匹配；Core 磁盘原样。不能只改 SHA 绕过变更。新版本先检验浏览器 API 契约，未知版本不套旧补丁。

主题不重载：原生广播到根/增强/iframe；序号丢旧请求；palette 标 appearance；官方两份 ThemeProvider 都同步 native/storage 事件。测试检查 iframe UUID 保留、根按钮状态正确。只改 CSS 会留下旧 React 主题状态，不能删这些回归。

## 数据、安全与退出

默认路径：`~/Library/Application Support/LibreTVMac`（配置、随机凭据、日志、Cores/Updates/Backups），`~/Downloads/LibreTV`，`~/Documents/LibreTV/Exports`，`~/Library/Caches/LibreTV/Media`。历史/源/偏好为 WebKit 持久存储。不要删除用户配置来“修复”主题或更新。

当前非 App Sandbox，目录每次使用检查可写性/挂载状态；沙盒正式版尚需 security-scoped bookmarks。原生桥只信任应用 UI 文档，API/proxy HTML 不得写文件；增强 HTTP API 随机 HttpOnly cookie + 同源校验；保留官方 SSRF/TLS 检查。

MainWindowHostView 真正挂到窗口后注册 willClose；首次 terminateCancel 返回事件循环，异步清理或 2 秒截止后 terminateNow。不要换回 terminateLater，曾导致嵌套主循环挂住。service-host 检测父 PID，专属组 TERM→900ms KILL，不按名字杀进程。UUID part 只清理 ledger 已登记项，不动影片或未知文件。

## 复现命令

开发机需要 Xcode、Python 3、网络；安装用户不需要开发环境。本次只交付 arm64。

```sh
cd /path/to/LibreTV-Mac
./scripts/build-macos.sh
python3 scripts/fetch-test-cores.py
python3 tests/serve-media-fixture.py
# 另一终端：fixture 仅监听 127.0.0.1:17995
LIBRETV_TEST_MEDIA_URL=http://127.0.0.1:17995/sample.m3u8 ./scripts/verify-macos.sh
./scripts/package-macos.sh
```

首次 build 获取 Node、npm ci、官方 standalone，校验 scripts/upstream-lock.json。重复 package 前仅删除本工具生成的 build/pkg-stage。PKG 安装 /Applications/LibreTV.app，关闭 BundleIsRelocatable，避免更新工作区测试 app。

SDK：本机 Swift 6.4 默认 swiftbuild 后端曾产生 `minos 14.0 / sdk 14.0`，导致没有新玻璃。脚本显式 SDK + native backend，最终 `minos 14.0 / sdk 27.2`；native backend deprecated，迁移后务必查 LC_BUILD_VERSION。不能仅改 Info.plist 或手改 Mach-O 假装链接新版 SDK。

PKG 展开后设置 `LIBRETV_TEST_RESOURCES=/绝对路径/Contents/Resources`，可从载荷跑 Swift 和 real-service 测试。下载测试临时挂当前 WebView；不要同时挂已退役的升级前页面，否则两版本会争用下载记录。不可改用用户持久数据来跑隔离测试。

重建交付：复制最终日志到 dist/verification，更新验证文档；cleanup-session.py 清明确生成物，create-handoff.py 生成源码/证据包和 SHA256SUMS；最后在 dist 跑 `shasum -a 256 -c SHA256SUMS`。改程序/签名/zip 后都需重算 SHA。

## 待办和范围

- 每次桌面发布都运行 scripts/audit-desktop.mjs。门禁包含生产/开发 npm audit、Desktop 实际版本查询、Node 官方安全数据库和已知漏洞正对照；官方 Core 排除在漏洞扫描之外，不能把本轮桌面 0 漏洞结论延伸为对任意官方内核的安全保证。
- 本机 Gatekeeper 原本 security disabled，spctl accepted 不能代表新 Mac，未改该设置。证书有效身份 0；Local 是用户明确选择。
- 正式分发补 Developer ID Application/Installer、公证/staple、干净 Mac/VM、macOS 14 实机与 Intel（如需）。本轮没有这些验收。
- 未覆盖全部公网源/编码/外置卷/写满场景。1 万任务模拟吞吐不等于公网实测；32 并发均匀 1 秒约 5分13秒、8秒约41分40秒，同站点更慢，堆上限不是 RSS 上限。
- 更新兼容范围 Next.js 15、schema 3/IndexedDB30、实际 API/导航。2026-11-12 查询官方最新仍为 2.22.0；用户当前内核未在本轮更换。桌面 Next 15.5.29 不等于官方内核版本，不能据此锁死或改写可变 Core。
- 清理后 .next、macos/.build、旧 app、PKG staging 不保留；保留 node_modules、已校验官方/Node 缓存、媒体样本、最终 app、dist 和全部用户数据。清单见 cleanup.json。
