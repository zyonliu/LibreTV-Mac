# LibreTV Mac 1.0.0 Local

SwiftUI + WKWebView + 内置 Node.js，在每位用户自己的 Mac 上独立运行。无需安装 Docker、Node.js、Homebrew 或开发工具。

## 安装

下载本页附件 `LibreTV-Mac-1.0.0-Local-arm64.pkg`，退出正在运行的 LibreTV，使用 macOS 安装器安装到 `/Applications/LibreTV.app`。

- Apple Silicon（M 系列）；最低构建目标 macOS 14.0。
- 已在 macOS 27.2.1 / SDK 27.2 验证，尚未完成最低系统实机或干净 Mac/VM 验收。
- **Local 包：应用 ad-hoc 签名、PKG 未签名、未经 Apple 公证。** macOS 可能阻止安装或打开，不具备正式 Developer ID 分发信任。

## 本版内容

- 原生窗口、系统玻璃工具栏、侧栏、Apple 开关与官方主题同步。
- 发现、直播、播放、设置、历史、下载、缓存及测活判定复用官方能力。
- 桌面与原版共用源、订阅、历史及偏好；宿主提供影片、导出与媒体缓存目录。
- 找源测活默认 32 并发、每站点 3、完成立即补位；支持暂停、继续、终止、重测和尾部慢任务放弃，切换页面保留任务。
- 添加按钮区分已选总数与可添加数，成功添加移出发现结果。
- 关闭主窗口即退出应用，回收自有本地服务及全部测活任务。
- 官方 Core 保持原样，可独立更新并预检、备份、失败恢复和回滚。初始 2.22.0，已验证 2.21.2 → 2.22.0；未知未来内核需满足接口/数据库契约。

桌面版本 1.0.0 / build 4，内置 Node 24.22.3。桌面版号、Node 与可变官方内核分别维护。

## 验证

桌面生产/开发依赖、实际 Desktop 载荷及 Node 官方安全库检查均为 0 个已知漏洞命中。按项目要求，官方 Core 不纳入漏洞扫描与依赖修复，只验证来源 SHA、原样文件和接口兼容。

已通过 622 项 Vitest、13 项 Node 回归、13 项 Swift 测试、连续 3 轮下载/升级一致性、PKG 展开后的 13 项原生回归与真实服务强杀回收。HLS TS 字节、MP4 可播放性、缓存与升级回滚均验证。1.0.0 实际关窗后 5 个自有 PID 消失，3 个端口释放；签名完整性、SDK、架构、官方文件和 4,200 项载荷清单核验通过。

[完整源码与 README](https://github.com/zyonliu/LibreTV-Mac/tree/v1.0.0) · [验证说明](https://github.com/zyonliu/LibreTV-Mac/blob/v1.0.0/docs/VERIFICATION.md) · [桌面依赖审计](https://github.com/zyonliu/LibreTV-Mac/blob/v1.0.0/docs/SECURITY-AUDIT.md)

按交付要求，本页仅挂载 Local PKG，内部会话交接包与 SHA 清单不作为附件。项目沿用 AGPL-3.0-or-later，基于 LibreSpark/LibreTV；使用内容需具备相应权利。
