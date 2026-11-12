import SwiftUI
import AppKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    static var service: ServiceManager?
    static var browser: BrowserModel?
    private var terminating = false
    private var readyToTerminate = false
    func applicationDidFinishLaunching(_ notification: Notification) { NSApp.setActivationPolicy(.regular); NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if readyToTerminate { return .terminateNow }
        guard !terminating else { return .terminateCancel }
        terminating = true
        let finish: @MainActor () -> Void = { [weak self] in
            guard let self, !self.readyToTerminate else { return }
            self.readyToTerminate = true
            sender.terminate(nil)
        }
        Task { @MainActor in await Self.browser?.prepareForShutdown(); finish() }
        Task { @MainActor in try? await Task.sleep(for: .seconds(2)); finish() }
        // Return to the main loop before awaiting WebKit. terminateLater can nest an AppKit
        // loop inside a dispatch callback and prevent both MainActor cleanup and its deadline.
        return .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) { Self.browser?.reset(); DownloadManager.shared.shutdown(); Self.service?.stop() }
}

@main struct LibreTVMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var service: ServiceManager
    @StateObject private var browser: BrowserModel
    init() { let service = ServiceManager(); let browser = BrowserModel(service: service); _service = StateObject(wrappedValue: service); _browser = StateObject(wrappedValue: browser); AppDelegate.service = service; AppDelegate.browser = browser; LocalUpdateManager.shared.installer = CoreInstaller(service: service, browser: browser) }
    var body: some Scene {
        Window("LibreTV", id: "main") {
            MainWindow(service: service, browser: browser).frame(minWidth: 680, minHeight: 540)
        }
        .defaultSize(width: 1160, height: 800)
        .windowResizability(.automatic)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(after: .newItem) { Button("打开媒体地址…") { browser.openMedia() }.keyboardShortcut("o", modifiers: .command).disabled(!service.ready) }
            CommandGroup(after: .toolbar) {
                Button("下载管理") { Task { try? await browser.showDownloads() } }.keyboardShortcut("j", modifiers: [.command, .shift]).disabled(!service.ready)
                Button("返回") { browser.command("back") }.keyboardShortcut("[", modifiers: .command).disabled(!browser.canBack)
                Button("前进") { browser.command("forward") }.keyboardShortcut("]", modifiers: .command).disabled(!browser.canForward)
                Button("主页") { browser.command("home") }.keyboardShortcut("h", modifiers: [.command, .shift]).disabled(!service.ready)
                Button("搜索") { browser.command("search") }.keyboardShortcut("k", modifiers: .command).disabled(!service.ready)
            }
        }
    }
}

struct OfficialColors {
    let values: [String:String]
    let dark: Bool
    func color(_ name: String, _ light: String, _ night: String) -> Color {
        let rgb = (values[name] ?? (dark ? night : light)).split(separator:" ").compactMap { Double($0) }
        guard rgb.count == 3 else { return .primary }
        return Color(red:rgb[0]/255,green:rgb[1]/255,blue:rgb[2]/255)
    }
    var page: Color { color("page","246 247 249","11 16 26") }
    var surface: Color { color("surface","255 255 255","20 28 41") }
    var line: Color { color("line","224 227 232","34 48 69") }
    var text: Color { color("content","26 26 26","230 242 255") }
    var muted: Color { color("muted","95 99 104","133 153 178") }
    var accent: Color { color("accent","37 99 235","0 184 230") }
    var hover: Color { color("hover","233 236 240","29 42 61") }
}

final class MainWindowHostView: NSView {
    var onClose: () -> Void = { RunLoop.main.perform { NSApp.terminate(nil) } }
    private var closeObserver: NSObjectProtocol?
    private weak var observedWindow: NSWindow?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window !== observedWindow else { return }
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        observedWindow = window
        guard let window else { closeObserver = nil; return }
        window.setFrameUsingName("LibreTVMainWindow")
        window.setFrameAutosaveName("LibreTVMainWindow")
        window.isMovableByWindowBackground = false
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        closeObserver = NotificationCenter.default.addObserver(forName:NSWindow.willCloseNotification,object:window,queue:.main) { [weak self] _ in self?.onClose() }
    }
    deinit { if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) } }
}
struct WindowAccessor: NSViewRepresentable {
    var color: Color = Color(nsColor:.windowBackgroundColor)
    func makeNSView(context: Context) -> NSView { MainWindowHostView() }
    func updateNSView(_ nsView: NSView, context: Context) { nsView.window?.backgroundColor = NSColor(color) }
}

struct MainWindow: View {
    @ObservedObject var service: ServiceManager
    @ObservedObject var browser: BrowserModel
    @ObservedObject var prefs = DesktopPreferences.shared
    @State private var showingDiagnostics = false
    @Environment(\.colorScheme) private var scheme
    private var colors: OfficialColors { OfficialColors(values:browser.officialPalette,dark:scheme == .dark) }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
              if service.ready && browser.mode == "desktop" { NativeSidebar(browser: browser); colors.line.frame(width:1) }
              ZStack {
                if service.ready {
                    ForEach(["desktop", "original"], id: \.self) { mode in
                        // Keep both navigation stacks alive, sharing one persistent WebsiteDataStore.
                        WebContainer(web: browser.view(for: mode)).opacity((mode == "desktop") == browser.showingSettings ? 1 : 0).allowsHitTesting((mode == "desktop") == browser.showingSettings).accessibilityHidden((mode == "desktop") != browser.showingSettings)
                    }
                    if let error = browser.pageFailure { ContentUnavailableView { Label("页面暂时无法显示", systemImage: "exclamationmark.triangle") } description: { Text(error) } actions: { Button("重新载入") { browser.current?.reload(); browser.pageFailure = nil } }.background(Color(nsColor: .windowBackgroundColor)) }
                } else { startup }
              }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            colors.line.frame(height:1)
            HStack { Text(service.failure == nil ? service.phase : "服务未就绪"); Spacer(); Text(service.ready ? "本地内核 \(service.version) · 数据保存在此 Mac" : "LibreTV Mac") }.font(.system(size: 11)).foregroundStyle(colors.muted).padding(.horizontal, 16).frame(height: 28).background(colors.surface)
        }
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                if browser.current?.url?.path != "/watch" {
                    navigationButton("chevron.left", "返回 · ⌘[", "back", disabled: !browser.canBack)
                    navigationButton("chevron.right", "前进 · ⌘]", "forward", disabled: !browser.canForward)
                    navigationButton("house", "当前模式主页", "home", disabled: !service.ready)
                }
            }
            locationToolbar
            ToolbarItem(placement: .primaryAction) {
                Picker("页面模式", selection: Binding(get: { browser.mode }, set: { next in Task { await browser.switchMode(next) } })) {
                    Text("桌面版").tag("desktop")
                    Text("原版").tag("original")
                }.pickerStyle(.segmented).labelsHidden().frame(width: 170).disabled(!service.ready)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await browser.cycleAppearance() } } label: {
                    Image(systemName: prefs.appearance == "dark" ? "moon" : prefs.appearance == "light" ? "sun.max" : "circle.lefthalf.filled")
                }.help("切换外观").accessibilityLabel("切换外观")
            }
        }
        .foregroundStyle(colors.text).tint(colors.accent).background(WindowAccessor(color:colors.surface))
        .preferredColorScheme(prefs.appearance == "system" ? nil : prefs.appearance == "dark" ? .dark : .light)
        .task { AppDelegate.service = service; AppDelegate.browser = browser; LocalUpdateManager.shared.installer = CoreInstaller(service: service, browser: browser); await service.start(); LocalUpdateManager.shared.currentVersion = service.version; if prefs.read()["checkOnLaunch"] as? Bool == true { try? await LocalUpdateManager.shared.check() } }
        .sheet(isPresented: $showingDiagnostics) { VStack(alignment: .leading, spacing: 16) { Text("诊断详情").font(.headline); ScrollView { Text(service.diagnostics()).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }; HStack { Button("复制诊断") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(service.diagnostics(), forType: .string) }; Spacer(); Button("完成") { showingDiagnostics = false }.keyboardShortcut(.defaultAction) } }.padding(24).frame(width: 620, height: 440) }
    }
    private var locationLabel: some View {
        Text(service.ready ? browser.location : service.phase)
            .font(.system(size: 13, weight: .medium)).foregroundStyle(colors.muted).lineLimit(1)
    }
    @ToolbarContentBuilder private var locationToolbar: some ToolbarContent {
        if #available(macOS 26.0, *) {
            ToolbarItem(placement: .principal) { locationLabel }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { locationLabel }
        }
    }
    private var startup: some View {
        VStack(spacing: 18) {
            if let icon = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("icon.png")) { Image(nsImage: icon).resizable().frame(width: 80, height: 80) }
            Text("LibreTV").font(.system(size: 28, weight: .semibold))
            if let error = service.failure { Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460); HStack { Button("重新启动") { browser.reset(); Task { await service.restart() } }.buttonStyle(.borderedProminent); Button("诊断详情") { showingDiagnostics = true } } }
            else { ProgressView().controlSize(.small); Text(service.phase).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
    }
    private func navigationButton(_ icon: String, _ label: String, _ action: String, disabled: Bool) -> some View { Button { browser.command(action) } label: { Image(systemName: icon).frame(width: 24, height: 24) }.disabled(disabled).help(label).accessibilityLabel(label) }
}

struct NativeSidebar: View {
    @ObservedObject var browser: BrowserModel
    @AppStorage("sidebarCollapsed") private var collapsed = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    private var colors: OfficialColors { OfficialColors(values:browser.officialPalette,dark:scheme == .dark) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if !collapsed { Text("资料库").font(.caption).foregroundStyle(.secondary); Spacer() }
                Button { collapsed.toggle() } label: {
                    HStack(spacing: 2) { Rectangle().frame(width: 2, height: 12); Image(systemName: collapsed ? "chevron.right" : "chevron.left").font(.system(size: 9, weight: .semibold)) }
                        .frame(width: 20, height: 16).overlay(RoundedRectangle(cornerRadius: 2).stroke(lineWidth: 1.4)).frame(width: 36, height: 36).background(Color.clear).contentShape(Rectangle())
                }.buttonStyle(.plain).help(collapsed ? "展开侧栏" : "收起侧栏").accessibilityLabel(collapsed ? "展开侧栏" : "收起侧栏")
            }.padding(.bottom, 8)
            row("发现", "safari", selected: !browser.showingSettings && browser.current?.url?.path == "/") { await browser.showOfficial(path: "") }
            row("直播", "antenna.radiowaves.left.and.right", selected: !browser.showingSettings && browser.current?.url?.path == "/live") { await browser.showOfficial(path: "live") }
            row("历史", "clock.arrow.circlepath", selected: browser.location == "历史") { await browser.showSettings(view: "history") }
            Spacer()
            row("主题", "paintpalette", selected: browser.location == "主题") { await browser.showSettings(view: "theme") }
            row("设置", "slider.horizontal.3", selected: browser.showingSettings && browser.location != "主题" && browser.location != "历史") { await browser.showSettings() }
            if !collapsed { Text("Mac 桌面版 · 本地运行").font(.system(size: 10)).foregroundStyle(.secondary).padding(.top, 14) }
        }.padding(12).frame(width: collapsed ? 64 : 176).foregroundStyle(colors.text)
            .background {
                if reduceTransparency || contrast == .increased { colors.surface }
                else { Rectangle().fill(.regularMaterial) }
            }
    }
    private func row(_ title: String, _ icon: String, selected: Bool = false, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            HStack(spacing: 10) { Image(systemName: icon).frame(width: 24); if !collapsed { Text(title); Spacer(minLength: 0) } }
                .font(.system(size: 13)).padding(.horizontal, 8).frame(height: 36).frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(selected ? colors.accent : colors.text).background(selected ? colors.hover : .clear, in: RoundedRectangle(cornerRadius: 9)).contentShape(Rectangle())
        }.buttonStyle(.plain).help(title).accessibilityLabel(title).accessibilityAddTraits(selected ? .isSelected : [])
    }
}
