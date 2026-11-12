# LibreTV Mac 1.0.0 / build 4 验证

日期：2026-11-12。Apple Silicon、macOS 27.2.1、Xcode/SDK 27.2；内置 Node 24.22.3。初始捆绑官方内核 2.22.0，Core 可独立替换与升级。

## 范围与结果

**严格按用户最新要求：官方包不管，只扫描我们的代码；LibreTV 内核是可变的。** 本轮审计/修复仅覆盖桌面生产/开发依赖、实际 Desktop 载荷、原生增强代码及内置 Node。官方 Core 不纳入漏洞扫描，不修改其代码、依赖或配置。官方文件 SHA 和跨版本兼容回归属于完整性/兼容性检查，不等于对官方包的漏洞审计。

上述范围内，联网依赖审计为 0，构建、回归、签名完整性和安装载荷校验通过。原始证据位于本地 dist/verification。按最终交付要求，公开 Release 仅挂载 Local PKG，内部会话交接包和 SHA 清单不上传。所有“0”指检查时数据库中已知、命中所查版本的漏洞，不能外推到排除范围或未知漏洞。

## 检查清单

| 检查 | 结果 | verification 内证据 |
| --- | --- | --- |
| npm audit 全部开发/生产依赖 | 0 个已知漏洞 | security/npm-all.json |
| npm audit --omit=dev | 0 个已知漏洞 | security/npm-production.json |
| 实际 Desktop 依赖及 Node 内嵌 Undici | 25 份有版本元数据的包，0 命中 | security/shipped-desktop-audit.json |
| Node 官方安全数据库 / darwin / 生命周期 | 0 命中，仍在支持期 | security/node-runtime.json |
| 已知受影响版本正对照 | 成功检出 Undici 6.21.1；该对照不在交付依赖中 | security/shipped-desktop-audit.json |
| lockfile、实际载荷锁文件 | 字节一致；审计记录 SHA | security/summary.json |
| npm ci --ignore-scripts、依赖树、TypeScript、ESLint | 通过 | release-build.log、dependency-tree.json、release-tests.log |
| Vitest | 45 文件、622 项通过，0 跳过 | release-tests.log |
| Node 回归 | 13 项通过 | release-tests.log |
| Swift XCTest | 13 项通过 | release-tests.log |
| 下载/缓存/升级/回滚一致性 | 连续 3 轮通过，失败即停止 | download-consistency-1/2/3.log |
| PKG 展开资源完整 Swift 回归 | 13 项通过 | pkg-tests.log |
| PKG 实际服务强杀回收 | 通过 | pkg-lifecycle.log |
| codesign strict、arm64、最低系统、SDK、系统动态库 | 通过 | build/integrity.json |
| 官方文件完整性 | 2,068 文件保持官方原样 | build/integrity.json、upstream.json |
| PKG 载荷与已签名 app | 4,200 文件/链接清单一致 | pkg-payload/integrity.json |
| 实际主窗口关闭 | 5 个自有 PID 消失，3 个端口释放 | window-close.json |

发布验证启用严格联网用例，公网 SSRF 正向测试使用 npm 公共健康端点；网络失败会让检查失败，不再以跳过代替通过。原有阻断私网、DNS Rebinding 与连接池复用防护仍验证。

## 功能回归与收尾

隔离 UserDefaults、临时目录及非持久 WebKit，不增删用户真实源、历史或影片：

- 官方 2.21.2 → 2.22.0、原版模式回滚、坏入口启动失败后恢复。桌面依赖版本不参与选择或改写官方 Core。
- 桌面/原版共用配置与缓存，官方设置/历史保留 iframe；主题跨页面同步且文档 UUID 不变。
- 120 项测活保持 32 并发、100 行分页，暂停/继续、跨 tab/模式保留任务；1 万项模拟队列回归通过。
- 选中总数与可添加数区分，成功添加移出发现列表，重复搜索仍排除已添加。
- 官方 Blob JSON 导出、文件精确字节、原子发布、重名保护、只清登记 part 文件与崩溃恢复。
- Apple HLS 三分片 TS 与源拼接一致；MP4 由 AVFoundation 验证可播放，时长 18±0.5 秒。
- 原生 32 连接、取消、路径白名单、响应上限和专属进程组回收。

外壳 reset 现在明确卸载旧网页、移除其桥和脚本，避免切换内核后旧上下文继续运行。新回归保留旧 WebView 引用，验证其 JS 标记确实消失。没有修改官方 Core。

下载进度观察改为当前页原生 IndexedDB 只读事务，并在事务提交后读取结果；不再在下载过程中反复调用会 flush 设置、读取全部表的完整备份。测试也等待任务完成回调收尾。完整备份/恢复仍在独立的更新测试中验证，没有删除失败断言、修改官方引擎或用延时掩盖状态。

## 安装与签名边界

用户选择 Local：app ad-hoc 签名，PKG 无 Installer 签名、未公证。签名完整性通过不等于 Apple 分发信任。Gatekeeper 原始评估另存 gatekeeper-app.txt，不能将本机覆盖状态当成干净 Mac 验收。

PKG 固定安装 /Applications/LibreTV.app，arm64，最低构建目标 macOS 14.0，BundleIsRelocatable=false。无安装脚本、守护程序或外部运行时安装步骤。展开后重新验证签名、SHA，并从载荷跑真实链路；未执行系统范围实际安装。

尚未完成干净 Mac/VM、macOS 14 实机、Intel、Developer ID/公证验收；未覆盖全部公网源/编码、外置卷断连、写满和权限撤销。未知未来内核仍须符合当前 API/DB 契约；可以独立更新，不保证任意不兼容新版本免适配。清理仅针对生成物，用户数据保持保留。
