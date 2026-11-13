# LibreTV Mac 本地版

独立工程：`LibreTV-Mac/`（仓库根目录）。SwiftUI + WKWebView + 内置 Node.js；目标用户不需要 Docker、Homebrew、Node 或开发工具。当前构建为 Apple Silicon、macOS 14+、本机 ad-hoc 签名，尚未做 Developer ID 公证或 Intel/全新 Mac 分发验收。

## 官方优先

发现、直播、播放直接加载官方 Release 的页面。桌面模式与原版模式共用同一个官方内容 WebView，模式切换只改变外壳导航，不另建播放器或下载队列。桌面模式隐藏重复的官方顶栏，原版模式保留。SwiftUI 外壳读取官方 CSS 配色。

1.0.1 起，明确保留左侧桌面菜单，进入直播不能隐藏菜单。网页层继续隐藏官方顶栏；桌面内容宽度 768–1023px 时，以宿主 CSS 适配官方直播的双栏显示，避免菜单占宽后提前进入频道抽屉。选择器受桌面模式和官方频道列表标记限制，不复制直播组件；更窄窗口与原版模式仍使用官方响应式行为，Core 文件保持原样。

历史页和原版设置通过同源 iframe 加载实际官方页面，打开对应官方面板后只展示面板内容，隐藏其他模块。没有复制实现官方历史/设置组件。历史中的播放链接交给内容 WebView 打开。增强层只维护目录选择、窗口偏好、找源和更新。

下载仍使用官方的入口、任务列表、IndexedDB 记录、中转设置、解析、下载及转封装流程。缓存开关、时长、额度、淘汰、清理由官方控制。桌面设置仅增加目录和系统保存选择，已移除重复的缓存额度/清理控件。

`desktop-bootstrap.js` 提供宿主浏览器能力：

- 标准 `showSaveFilePicker` 映射到系统目录选择和有界分块写盘；普通链接/blob 由 WKDownloadDelegate 保存。
- 官方 `libretv-video-v1`、`libretv-dl-v1` CacheStorage 桶映射到指定目录的文件。官方仍通过 put/match/delete/keys 管理缓存。宿主不另做 LRU 或调整官方额度，仅检查实际磁盘空间（保留 32 MiB）并限制单次 HTTP 分片输入。
- 统一主题、宿主导航和文件接口；已知结构的中断下载记录在重开时标为暂停，避免误报仍在运行。

## 官方 2.22.0 下载兼容补丁

实际短 HLS 测试复现了上游并发游标越界；源码还存在暂停后重新选择文件但不恢复控制器、全局单保存目标串用等问题。`macos/Runtime/official-compat.cjs` 对已验证的 2.22.0 下载脚本提供版本与 SHA-256 双重限定的少量精确替换。

补丁在网关响应层应用，不修改磁盘上的 Core，不复制下载引擎。它继续使用官方函数和界面，仅修正越界、恢复、保存目标归属及取消/失败清理。脚本内容不匹配时拒绝套用；未来其他版本不会套用此补丁，需要重新验证其官方行为。网关会标识实际启用的补丁，资源查询参数避免旧 WebKit 脚本缓存遮盖修正。对应回归测试直接执行补丁前后的官方函数，验证原始失败及修正后的结果。

## 进程与数据

应用内结构：

- `Resources/Core`：原样保存的官方 standalone Release。
- `Resources/Desktop`：独立编译的增强设置页面和磁盘存储接口。
- `Runtime/node`：从 nodejs.org 下载并校验的 Node 24.22.3。
- `service-host.cjs`：监督进程，监测原生父进程消失并终止专属进程组。
- `gateway.cjs`：稳定的 loopback origin；官方与增强后端使用私有临时端口。

网关 `/`、`/watch`、`/live`、普通 `/api/*`、`/_next/*` 来自官方。`/desktop*`、`/api/desktop/*`、`/desktop-assets/*` 来自增强服务。服务只监听 127.0.0.1；稳定 origin 保留网页数据，端口冲突报错，不自动换源。原生、官方和增强设置共用 WKWebsiteDataStore/IndexedDB/localStorage；不另维护一份 Swift 数据源配置。

关闭主窗口或退出应用时保存状态、关闭下载、终止监督进程及其网关/官方/增强后端。监督进程处理原生父进程被强制终止的情况；超时对自有进程组发送 SIGKILL，不按名字终止其他 Node。

下载先写 UUID `.part`，完成后原子发布；重名自动换名，不覆盖影片。登记自己创建的临时文件，正常退出清理，异常退出后下次启动恢复清理。未登记文件和已完成影片不受影响。缓存目录迁移只复制并校验受管理文件；失败/取消保留原目录。旧目录保留以供恢复，不递归删除用户目录。

默认目录：

| 内容 | 位置 |
| --- | --- |
| 本机配置、日志、随机凭据 | `~/Library/Application Support/LibreTVMac/` |
| 可更新内核、选择引用 | 上述目录的 `Cores/`、`current-core.json` |
| 更新下载、数据备份 | 上述目录的 `Updates/`、`Backups/` |
| 影片下载 | `~/Downloads/LibreTV/` |
| 官方配置、数据源导出 | `~/Documents/LibreTV/Exports/` |
| 媒体缓存文件 | `~/Library/Caches/LibreTV/Media/` |
| 观看历史、源、偏好 | macOS 管理的持久化 WebKit 数据存储 |

当前未启用 App Sandbox；选择的路径使用时检查可写性和外置卷状态。沙盒分发需要另行实现 security-scoped bookmarks。

## 官方内核更新

使用官方 GitHub Releases 的精确 standalone 文件和 SHA256SUMS。下载支持暂停/继续，校验归档安全路径/链接、实际版本、运行结构，并隔离启动候选内核验证状态接口、登录会话、数据库及官方菜单入口。接受普通官方发布包，不要求它包含桌面自定义文件。

当前适配范围为 Next.js 15、Dexie schema 3（IndexedDB version 30）。不兼容的候选阻止安装；已知版本的兼容脚本还须通过 SHA-256 匹配。不能承诺未知未来版本无条件可用。

安装前备份全部 Dexie 表和相关 localStorage，使用独立内核目录切换引用。启动失败恢复原引用与服务，并保留此前可用的回退记录。回退前另外保存当前数据快照；恢复失败尝试返回回退前的内核和数据。正在下载时阻止更新/回退。实际隔离测试使用官方 2.21.2 → 2.22.0，以及回退和损坏服务入口的失败恢复；不接触用户配置。

## 构建与验证

```sh
npm ci
./scripts/build-macos.sh
open build/LibreTV.app
npm run lint
npm test
node --test tests/service-lifecycle.test.mjs tests/gateway.test.mjs tests/official-compat.test.mjs
LIBRETV_TEST_PROJECT="$PWD" swift test --package-path macos
```

完整 HLS 集成测试另启动 `python3 tests/serve-media-fixture.py`，设置 `LIBRETV_TEST_MEDIA_URL=http://127.0.0.1:17995/sample.m3u8`。测试使用临时配置、独立 UserDefaults、非持久 WebKit 数据存储，不操作用户来源和历史。

当前实际结果与未覆盖范围见 [VERIFICATION.md](VERIFICATION.md)。

## 大批量测活

找源页仅调度官方的点播测活、直播列表解析和订阅解析，不另做一套可用性判断。相同类型、规范化地址先去重；按站点轮转取任务，默认全局 32、每个 hostname 3 个在途，完成一个立即补位。单项桌面等待上限 8 秒；队列派发完且最后只剩 2 项时，再给 2.5 秒收尾。桌面超时/收尾取消不写成官方健康失败；官方自身返回的失败仍按官方模型记录。健康记录按 150ms 合并写入，页面结果按 100ms 合并，列表每页最多 100 行。

暂停停止派发，保留正在完成的结果；继续仅处理剩余项。终止本轮取消在途、清空待派发任务并保留已完成结果。失败、超时、放弃与取消项可重测；列表筛选不改变本轮总进度。关闭主窗口取消原生请求并终止全部自有服务进程，不留后台测活。

找源组件和官方嵌入页首次访问后保持挂载，切换设置类别、桌面/原版模式不会销毁任务。官方 2.22.0 点播批量测活 hook 的卸载取消问题使用单独、SHA256 限定的响应适配保存进度和订阅者；任务仍使用官方 API 和健康记录函数，Core 发布文件保持原样。官方直播页面的频道分片批量测活属于另一条上游功能，未把它改为桌面调度器。

为避免 WKWebView HTTP/1.1 同 origin 连接数限制，桌面提供仅限本机 `/api/source/test`、`/api/live/playlist`、`/api/source-list` 的原生传输通道，仍把请求交给官方服务器。URLSession 上限 32 个连接，原生等待任务硬上限 64，单响应最多 4MiB；拒绝重定向和外部 URL，保留官方身份验证与 SSRF 检查。它不负责解析源或判定测活结果，也不创建每源独立进程。

1 万项、12 并发：平均 1 秒约 14 分钟，全部等满 8 秒约 111 分钟。32 并发：对应约 5 分 13 秒和 41 分 40 秒。这是均匀分布的计算值，不是公网测试结果；同一站点占比高时受每站点 3 并发限制。末尾收尾策略只减少尾部等待，不能消除整批慢源的总成本。

找源输入支持关键词、GitHub 仓库链接、仓库短名、直接 JSON/M3U 地址；读取 README 与根目录。当前关键词检索最多 5 个仓库，并非全 GitHub 爬取。下载兼容适配还修复 MP4 的起始时间戳与 mdhd 未知时长，确保短样本被 AVFoundation 识别为实际时长；所有适配依版本及完整文件 SHA256 放行。

官方服务器的测活入口另有纯传输保护：客户端断连时中止上游 fetch，单次上游响应超过 8MiB 停止读取；普通播放和媒体代理不受此大小限制。官方进程 V8 堆上限 768MiB、附加服务 512MiB，避免无限增大堆；这不是整个进程 RSS 的硬限制。下载状态写入按任务串行，防止迟到的 progress 将 completed 覆盖回 downloading。

主窗口由 MainWindowHostView 在 viewDidMoveToWindow 时注册 willClose。首次终止请求暂时返回 terminateCancel，让事件循环继续执行 WebKit/文件清理；完成或 2 秒截止后再 terminateNow。不使用会在主 dispatch 回调中进入嵌套等待的 terminateLater。窗口实际关闭后已验证 5 个自有进程全部消失、公共端口释放。

## 原生外观与主题

原生外观：标题栏、红黄绿按钮、导航、模式选择与主题按钮使用系统窗口/SwiftUI toolbar。链接 macOS 27.2 SDK，最低系统 14.0，macOS 26+ 自动使用原生 Liquid Glass。位置标题不加玻璃背景；侧栏 regularMaterial 在降低透明度/增强对比度时退回不透明背景。本机 Swift 6.4 默认 swiftbuild 后端曾误记 linked SDK 为 14.0，脚本改为显式 SDK + SwiftPM native 后端，审计最终 Mach-O 要求 SDK >=26。native 后端有 deprecated 提示，未来迁移时必须继续核验 linked SDK。

主题无重载同步：宿主广播到保留的内容 WebView、增强页及官方设置/历史 iframe；序号丢弃过时偏好，palette 带 appearance 标记，避免跨主题色值串用。官方 2.22.0 在 settings chunk 和 app layout chunk 各有一份 ThemeProvider，两处均使用精确 SHA 响应适配，当前标识 `official-2.22.0-desktop-compat-v7`。磁盘 Core 未修改。

原生桥只注入同源 `/`、`/live`、`/watch`、`/about`、`/desktop` 文档，接收消息时再次检查主 frame 或指定官方面板、URL 和参数。API/proxy HTML 无宿主文件权限；发布构建关闭 WebView inspection。

## 找源列表与批量添加

“发现结果”只展示当前官方共享配置中尚未添加的候选地址，计数遵循同一规则。单项或批量添加成功后立即移出发现列表，重新检索也会排除这些地址；失败、未测及未添加的项目保留。判断始终从官方共享源配置派生，不另外保存一套“已添加”标记。

全选 8 项、其中 5 项检测通过时，选择栏显示“8 项已选，其中 5 项可添加”，操作为“添加已选可用项（5）”。数字表示符合条件的已选候选项目，订阅按地址计数，不表示订阅展开后的源总数。窄窗口的批量操作栏允许换行。

内核升级继续使用现有“检查 → 下载校验 → 隔离兼容预检 → 备份并安装”链路。官方 2026-11-11 查询结果仍为 2.22.0；本轮没有给用户安装不同版本。新版本如改变数据结构、接口或需要新的脚本适配，应先更新桌面程序，不能把已验证的 2.21.2 → 2.22.0 升级结果理解成任意未来版本的保证。


## 桌面依赖安全发布（1.0.0）

按用户 2026-11-12 指令，官方 Core 不纳入依赖漏洞扫描、升级或修复；它是可变内核。扫描只覆盖桌面项目的生产/开发依赖、实际 Desktop 载荷、原生增强代码和内置 Node。Core 只做官方 SHA 与兼容性预检，桌面修复不修改其任何文件。

增强层使用 Next 15.5.29、Undici 6.29.1、PostCSS 8.5.32，测试工具使用 Vitest 5.1.0/Vite 8.3.8，Node 24.22.3。PostCSS/source-map-js 的 overrides 仅作用于本桌面工程构建；ESLint 插件/解析器固定兼容 ESLint 9 的 8.72.2，并将其 typescript-estree 所用 minimatch 指向已修复的 11.x。不能把这些 overrides 应用到官方 Core。未来上游工具链完成依赖升级后可移除对应覆盖，但须重新审计和回归。

runtime-config.json 集中维护桌面 Node 版本，应用版本来自 Info.plist，官方版本来自独立 Core；三者不绑定。构建总是 npm ci --ignore-scripts，避免 node_modules 与 lockfile 不一致。打包前 audit-desktop.mjs 要求生产/开发审计为 0，扫描实际 Desktop/node_modules 与 Node 内嵌 Undici，并从 Node 官方数据库检查 darwin 运行时；不会遍历 Core。请求加入已知受影响版本作为正对照，防止把空/错误响应误判为扫描通过。

Desktop 内保存构建 lockfile，打包门禁验证它与源锁文件完全相同。审计原始响应、时间、范围和 lock SHA 均进入交接包。联网正向 SSRF 用例在发布严格模式下失败即失败，不允许跳过；默认使用 npm 公共健康端点作真实公网测试。
