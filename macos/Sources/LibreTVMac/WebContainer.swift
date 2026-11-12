import AppKit
import SwiftUI
import WebKit

@MainActor final class BrowserModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    @Published var mode: String = UserDefaults.standard.string(forKey: "homeMode") ?? "desktop"
    @Published var canBack = false
    @Published var canForward = false
    @Published var location = "发现"
    @Published var pageFailure: String?
    @Published var showingSettings = false
    @Published var officialPalette: [String: String] = [:]
    private var paletteAppearance: String?
    var service: ServiceManager
    private var views: [String: WKWebView] = [:]
    private var explicitPlayback = Set<ObjectIdentifier>()
    let probeTransport = OfficialProbeTransport()
    let downloads: DownloadManager
    private let dataStore: WKWebsiteDataStore
    private var observations: [NSKeyValueObservation] = []
    var current: WKWebView? { views[showingSettings ? "desktop" : "original"] }
    init(service: ServiceManager, dataStore: WKWebsiteDataStore? = nil, downloads: DownloadManager? = nil) { self.service = service; self.dataStore = dataStore ?? .default(); self.downloads = downloads ?? .shared; super.init(); mode = service.prefs.defaults.string(forKey: "homeMode") ?? "desktop" }
    func view(for mode: String) -> WKWebView {
        if let existing = views[mode] { return existing }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "desktop")
        let trustedOrigin = String(data:(try? JSONEncoder().encode(service.baseURL?.absoluteString ?? "")) ?? Data(),encoding:.utf8) ?? "\"\""
        let source = """
        (() => {
          const trustedOrigin = \(trustedOrigin);
          if (!trustedOrigin || location.origin !== new URL(trustedOrigin).origin || !['/','/live','/watch','/about','/desktop'].includes(location.pathname)) return;
          const call = (method, params = {}) => window.webkit.messageHandlers.desktop.postMessage({version:1,method,params});
          Object.defineProperty(window, 'libreTVDesktop', {value:Object.freeze({version:1,call}), writable:false});
          const update = () => call('navigation.changed', {url:location.href, title:document.title}).catch(()=>{});
          for (const key of ['pushState','replaceState']) { const original=history[key]; history[key]=function(...args){const result=original.apply(this,args); queueMicrotask(update); return result;}; }
          addEventListener('popstate', update); addEventListener('load', update);
          addEventListener('keydown', e => {if(e.metaKey && ['[',']','k'].includes(e.key)){ e.preventDefault(); call('navigation.command',{action:e.key==='['?'back':e.key===']'?'forward':'search'}).catch(()=>{});}});
          window.__ltPause = async () => { document.querySelectorAll('video,audio').forEach(v=>v.pause()); window.dispatchEvent(new Event('libretv:desktop-pause')); await new Promise(r=>setTimeout(r,100)); };
        })();
        """
        let additions = (try? String(contentsOf: service.resources.appendingPathComponent("desktop-bootstrap.js"), encoding: .utf8)) ?? ""
        configuration.userContentController.addUserScript(WKUserScript(source: source + "\n" + additions, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        let web = WKWebView(frame: .zero, configuration: configuration); web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true; web.isInspectable = _isDebugAssertConfiguration()
        web.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 LibreTVDesktop/1"
        views[mode] = web
        observations.append(web.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.refreshNavigation() } })
        observations.append(web.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.refreshNavigation() } })
        Task { @MainActor in
            guard let base = service.baseURL, let cookie = service.cookie else { return }
            await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
            if let desktopCookie = service.desktopCookie { await web.configuration.websiteDataStore.httpCookieStore.setCookie(desktopCookie) }
            if web.url == nil { web.load(URLRequest(url: base.appendingPathComponent(mode == "desktop" ? "desktop" : ""))) }
        }
        return web
    }
    func reset() {
        probeTransport.cancelAll()
        for web in views.values {
            web.stopLoading()
            web.navigationDelegate = nil; web.uiDelegate = nil
            web.configuration.userContentController.removeScriptMessageHandler(forName: "desktop", contentWorld: .page)
            web.configuration.userContentController.removeAllUserScripts()
            // stopLoading does not stop an already loaded document's JS or DB observers.
            // Explicitly retire it before another official core shares the same origin.
            web.loadHTMLString("", baseURL: nil)
        }
        observations.removeAll(); views.removeAll(); explicitPlayback.removeAll()
        canBack = false; canForward = false; pageFailure = nil
    }
    func switchMode(_ next: String) async {
        guard ["desktop", "original"].contains(next) else { return }
        mode = next; service.prefs.defaults.set(next, forKey: "homeMode")
        for web in views.values { _ = try? await web.callAsyncJavaScript("document.documentElement.dataset.desktopMode=mode;", arguments:["mode":next], in:nil, contentWorld:.page) }
        if next == "original", showingSettings { await showOfficial() }
        refreshNavigation()
    }
    func showSettings(view: String = "settings", tab: String = "desktop") async {
        if !showingSettings { _ = try? await current?.evaluateJavaScript("window.__ltPause?.()") }
        showingSettings = true
        guard let base = service.baseURL else { return }
        var parts = URLComponents(url: base.appendingPathComponent("desktop"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name:"view",value:view),URLQueryItem(name:"tab",value:tab)]
        let web = self.view(for:"desktop")
        if web.url != parts.url {
            if (try? await web.evaluateJavaScript("typeof window.__ltDesktopNavigate === 'function'")) as? Bool == true {
                _ = try? await web.callAsyncJavaScript("window.__ltDesktopNavigate(url);", arguments:["url":parts.url!.absoluteString], in:nil, contentWorld:.page)
            } else { web.load(URLRequest(url:parts.url!)) }
        }
        refreshNavigation()
    }
    func showDownloads() async throws {
        if showingSettings { await showOfficial() }
        _ = try await view(for:"original").evaluateJavaScript("window.dispatchEvent(new Event('libretv:show-download-manager'))")
    }
    func showOfficial(path: String? = nil, panel: String? = nil) async {
        let wasSettings = showingSettings
        showingSettings = false
        let web = view(for:"original")
        if wasSettings { explicitPlayback.insert(ObjectIdentifier(web)) }
        if let path, let base = service.baseURL { web.load(URLRequest(url:base.appendingPathComponent(path))) }
        refreshNavigation()
        _ = try? await web.evaluateJavaScript("window.dispatchEvent(new Event('libretv:desktop-resume'))")
        guard let panel, ["history","settings","downloads"].contains(panel) else { return }
        if web.url?.path == "/watch", let base = service.baseURL { _ = try? await web.evaluateJavaScript("window.__ltPause?.()"); web.load(URLRequest(url:base)) }
        let label = panel == "history" ? "观看历史" : panel == "settings" ? "设置" : "下载管理"
        for _ in 0..<80 {
            if (try? await web.callAsyncJavaScript("const button=document.querySelector('button[aria-label=\"'+label+'\"]'); if(!button)return false; button.click(); return true;", arguments:["label":label], in:nil, contentWorld:.page)) as? Bool == true { return }
            try? await Task.sleep(for:.milliseconds(100))
        }
        pageFailure = "当前官方版本没有提供此入口，请使用官方页面中的菜单。"
    }
    func appearanceChanged() async {
        officialPalette = [:]; paletteAppearance = nil
        for web in views.values { _ = try? await web.evaluateJavaScript("window.dispatchEvent(new Event('libretv:desktop-preferences'))") }
    }
    func cycleAppearance() async {
        let prefs = service.prefs
        prefs.appearance = prefs.appearance == "light" ? "dark" : prefs.appearance == "dark" ? "system" : "light"
        await appearanceChanged()
    }
    func refreshNavigation() {
        canBack = showingSettings || (current?.canGoBack ?? false); canForward = current?.canGoForward ?? false
        guard let url = current?.url else { return }
        if url.path == "/watch" { location = "播放" }
        else if url.path == "/desktop" {
            let query = URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems ?? []
            let view = query.first{$0.name == "view"}?.value ?? "settings"
            let tab = query.first{$0.name == "tab"}?.value ?? "desktop"
            location = view == "history" ? "历史" : view == "theme" ? "主题" : "设置 / " + (["original":"原版设置","desktop":"桌面版设置","sources":"找源","updates":"更新"][tab] ?? "设置")
        } else { location = (mode == "original" ? "原版 / " : "") + (url.path == "/live" ? "直播" : url.path == "/about" ? "关于" : "发现") }
    }
    func command(_ action: String) {
        guard let web = current else { return }
        Task { @MainActor in
            // Dialogs and menus own the first Back action. Keep their own focus restoration behavior.
            let closed = (try? await web.evaluateJavaScript("(() => { const open=!!document.querySelector('[role=dialog],[role=alertdialog],[aria-haspopup][aria-expanded=true]'); if(open) (document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return open; })()")) as? Bool ?? false
            if closed && action == "back" { return }
            if action == "search" { if showingSettings { await showOfficial() }; _ = try? await web.evaluateJavaScript("window.dispatchEvent(new Event('libretv:focus-search')); document.querySelector('input[type=search],input[placeholder*=影片],input[placeholder*=搜索]')?.focus()") }
            else { _ = try? await web.evaluateJavaScript("window.__ltPause?.()"); if action == "back" { if showingSettings && web.backForwardList.backItem?.url.path != "/desktop" { await showOfficial() } else if web.canGoBack { web.goBack() } }; if action == "forward", web.canGoForward { web.goForward() }; if action == "home" { await showOfficial(path: "") } }
        }
    }
    func prepareForShutdown() async {
        probeTransport.cancelAll()
        for web in views.values {
            _ = try? await web.callAsyncJavaScript("window.dispatchEvent(new Event('libretv:desktop-terminate')); await window.__ltPause?.(); window.dispatchEvent(new Event('pagehide')); if(window.__ltPauseDownloads) await window.__ltPauseDownloads(); return true;", arguments: [:], in: nil, contentWorld: .page)
        }
    }
    func openMedia() {
        let alert = NSAlert(); alert.messageText = "打开媒体地址"; alert.informativeText = "输入 HLS 或其他可播放的 HTTP(S) 媒体地址。"; alert.addButton(withTitle: "打开"); alert.addButton(withTitle: "取消")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 26)); field.placeholderString = "https://…/index.m3u8"; alert.accessoryView = field
        guard alert.runModal() == .alertFirstButtonReturn, let media = URL(string: field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)), ["http","https"].contains(media.scheme ?? ""), media.user == nil, media.password == nil, let base = service.baseURL else { return }
        Task { @MainActor in
            _ = try? await current?.evaluateJavaScript("window.__ltPause?.()")
            showingSettings = false
            let web = view(for:"original")
            var components = URLComponents(url: base.appendingPathComponent("watch"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "url", value: media.absoluteString), URLQueryItem(name: "title", value: "媒体播放"), URLQueryItem(name: "source", value: "direct"), URLQueryItem(name: "sourceUrl", value: media.absoluteString)]
            explicitPlayback.remove(ObjectIdentifier(web)); if let url = components.url { web.load(URLRequest(url: url)) }
        }
    }
    func trusted(_ url: URL?) -> Bool { guard let url, url.user == nil, url.password == nil, let base = service.baseURL else { return false }; return url.scheme == base.scheme && url.host == base.host && url.port == base.port }
    func trustedDocument(_ url: URL?) -> Bool {
        guard let url, trusted(url) else { return false }
        return ["/","/live","/watch","/about","/desktop"].contains(url.path)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let panel = URLComponents(url:message.frameInfo.request.url ?? URL(string:"about:blank")!,resolvingAgainstBaseURL:false)?.queryItems?.first{$0.name == "desktopPanel"}?.value
        guard trustedDocument(message.frameInfo.request.url), (message.frameInfo.isMainFrame || (message.frameInfo.request.url?.path == "/" && ["history","settings"].contains(panel ?? ""))), let data = message.body as? [String: Any], data["version"] as? Int == 1, let method = data["method"] as? String else { replyHandler(nil, "拒绝不受信页面的桌面请求"); return }
        let params = data["params"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do {
                let result: Any
                switch method {
                case "official.probe":
                    guard let base = service.baseURL else { throw DesktopError("官方服务未启动") }
                    result = try await probeTransport.request(id: params["id"] as? String ?? "", path: params["path"] as? String ?? "", method: params["method"] as? String ?? "GET", body: params["body"] as? String, base: base, cookies: [service.cookie, service.desktopCookie].compactMap { $0 })
                case "official.probe.cancel": probeTransport.cancel(params["id"] as? String ?? ""); result = true
                case "media.canPlay":
                    let active = message.webView === current
                    if active, params["userGesture"] as? Bool == true, let web = message.webView { explicitPlayback.remove(ObjectIdentifier(web)) }
                    result = active && !(message.webView.map { explicitPlayback.contains(ObjectIdentifier($0)) } ?? true)
                case "navigation.changed":
                    if message.webView === current { refreshNavigation() }; result = true
                case "official.open": await showOfficial(panel: params["panel"] as? String ?? "settings"); result = true
                case "official.navigate":
                    guard let value = params["url"] as? String, let url = URL(string:value), trusted(url), url.path == "/watch" else { throw DesktopError("拒绝打开非官方播放地址") }
                    await showOfficial(); explicitPlayback.remove(ObjectIdentifier(view(for:"original"))); current?.load(URLRequest(url:url)); result = true
                case "navigation.command": command(params["action"] as? String ?? ""); result = true
                case "ui.palette":
                    let allowed = Set(["page","surface","surface-raised","line","content","muted","faint","accent","accent-hover","hover","chip","on-accent","danger","success","warning"])
                    if message.webView === views["original"], params["appearance"] as? String == service.prefs.appearance,
                       let resolved = params["resolved"] as? String, ["light","dark"].contains(resolved),
                       service.prefs.appearance == "system" || resolved == service.prefs.appearance,
                       let colors = params["colors"] as? [String:String] {
                        officialPalette = colors.filter { key,value in
                            let rgb = value.split(separator:" ").compactMap { Int($0) }
                            return allowed.contains(key) && rgb.count == 3 && rgb.allSatisfy { (0...255).contains($0) }
                        }
                        paletteAppearance = resolved
                        _ = try? await views["desktop"]?.evaluateJavaScript("window.dispatchEvent(new Event('libretv:desktop-preferences'))")
                    }
                    result = true
                case "preferences.get": var snapshot = service.prefs.snapshot(activeDownloads: downloads.activeCount); snapshot["hostMode"] = mode; snapshot["palette"] = officialPalette; snapshot["paletteAppearance"] = paletteAppearance; result = snapshot
                case "preferences.set":
                    let prefs = service.prefs; let oldAppearance = prefs.appearance
                    if let appearance = params["appearance"] as? String, ["system","light","dark"].contains(appearance) { prefs.appearance = appearance }
                    var patch: [String: Any] = [:]
                    if let ask = params["askEachTime"] as? Bool { patch["askEachTime"] = ask }
                    if let check = params["checkOnLaunch"] as? Bool { patch["checkOnLaunch"] = check }
                    if !patch.isEmpty { try prefs.patch(patch) }; if oldAppearance != prefs.appearance { await appearanceChanged() } else { for web in views.values { _ = try? await web.evaluateJavaScript("window.dispatchEvent(new Event('libretv:desktop-preferences'))") } }; result = prefs.snapshot(activeDownloads: downloads.activeCount)
                case "directory.choose": result = try await service.prefs.choose(params["kind"] as? String ?? "", reset: params["reset"] as? Bool ?? false, activeDownloads: downloads.activeCount)
                case "directory.reveal": try service.prefs.reveal(params["kind"] as? String ?? "download"); result = true
                case "directory.cancel": var config = service.prefs.read(); config.removeValue(forKey:"pendingCacheDirectory"); try service.prefs.write(config); result = true
                case "download.begin": result = try await downloads.begin(params["filename"] as? String ?? "download")
                case "download.write": try downloads.append(params["id"] as? String ?? "", base64: params["data"] as? String ?? ""); result = true
                case "download.close": result = try downloads.finish(params["id"] as? String ?? "")
                case "download.abort": downloads.abort(params["id"] as? String ?? ""); result = true
                case "service.restart":
                    guard downloads.activeCount == 0 else { throw DesktopError("请先完成或取消正在保存的文件，再重启服务。") }
                    result = true
                    DispatchQueue.main.async { Task { @MainActor in await self.prepareForShutdown(); self.reset(); await self.service.restart() } }
                case "service.diagnostics": result = service.diagnostics()
                case "service.logs": NSWorkspace.shared.open(service.prefs.support); result = true
                case "update.status": result = LocalUpdateManager.shared.snapshot()
                case "update.check": try await LocalUpdateManager.shared.check(); result = LocalUpdateManager.shared.snapshot()
                case "update.download": LocalUpdateManager.shared.download(); result = LocalUpdateManager.shared.snapshot()
                case "update.install": try await LocalUpdateManager.shared.install(); result = LocalUpdateManager.shared.snapshot()
                case "update.rollback": try await LocalUpdateManager.shared.rollback(); result = LocalUpdateManager.shared.snapshot()
                case "update.pause": LocalUpdateManager.shared.pause(); result = LocalUpdateManager.shared.snapshot()
                case "update.cancel": LocalUpdateManager.shared.cancel(); result = LocalUpdateManager.shared.snapshot()
                default: throw DesktopError("不支持的桌面接口：\(method)")
                }
                replyHandler(result, nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { if webView === current { pageFailure = nil; refreshNavigation(); service.pageReady() } }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { pageFailure = error.localizedDescription } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { pageFailure = "网页进程已退出，请重新载入页面。" }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if trustedDocument(url) || url.scheme == "blob" || url.absoluteString == "about:blank" { decisionHandler(.allow) }
        else { if ["https","http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) { decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { downloads.own(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { downloads.own(download) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { if let url = navigationAction.request.url, trustedDocument(url) { webView.load(navigationAction.request) } else if let url = navigationAction.request.url, ["http","https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; return nil }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { let alert = NSAlert(); alert.messageText = message; alert.runModal(); completionHandler() }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "继续"); alert.addButton(withTitle: "取消"); completionHandler(alert.runModal() == .alertFirstButtonReturn) }
}

struct WebContainer: NSViewRepresentable {
    let web: WKWebView
    func makeNSView(context: Context) -> WKWebView { web }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
