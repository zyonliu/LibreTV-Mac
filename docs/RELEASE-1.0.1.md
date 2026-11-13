# LibreTV Mac 1.0.1 Local

修正桌面模式直播与原版布局不一致的问题。左侧桌面菜单始终保留，点击直播不会隐藏菜单；网页层隐藏官方顶栏，播放器、右侧频道列表及其操作继续复用官方页面。桌面内容宽度 768–1023px 时显示官方双栏，避免菜单占宽后提前进入频道抽屉；更窄窗口保留官方抽屉，原版模式不变。

官方 Core、直播源码、播放器和频道列表没有改写，适配只位于宿主样式层。官方内核仍可独立更新，并执行来源校验、兼容预检、备份与失败恢复。初始 Core 2.22.0，与桌面版本 1.0.1/build 5 分开维护。

下载附件 `LibreTV-Mac-1.0.1-Local-arm64.pkg`，退出正在运行的 LibreTV 后安装。Apple Silicon，最低构建目标 macOS 14.0。沿用 Local 交付：应用 ad-hoc 签名，PKG 未签名、未经 Apple 公证。

[源码和安装说明](https://github.com/zyonliu/LibreTV-Mac/tree/v1.0.1) · [本次布局验证](https://github.com/zyonliu/LibreTV-Mac/blob/v1.0.1/docs/LIVE-LAYOUT-1.0.1.md)

Release 仅上传 Local PKG；会话交接包与 SHA 清单只保留本地。
