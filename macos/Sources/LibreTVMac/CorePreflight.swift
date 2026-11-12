import Foundation
import WebKit

/// Runs an unmodified official core in isolation before activating it. No user WebKit data is opened.
@MainActor enum CorePreflight {
    static func validate(_ directory: URL, node: URL, supervisor: URL, version: String) async throws {
        try CoreLayout.validate(directory, version: version)
        let compatibility = supervisor.deletingLastPathComponent().appendingPathComponent("official-compat.cjs")
        if FileManager.default.fileExists(atPath:compatibility.path) {
            try await Task.detached {
                let check = Process(); check.executableURL = node
                check.arguments = ["-e", "require(process.argv[1]).load(process.argv[2]);", compatibility.path, directory.path]
                check.standardOutput = FileHandle.nullDevice; check.standardError = FileHandle.nullDevice
                try check.run(); check.waitUntilExit()
                guard check.terminationStatus == 0 else { throw DesktopError("此官方构建与已验证的兼容补丁不匹配，已阻止更新。") }
            }.value
        }
        guard let port = (19000...19100).first(where: { LoopbackPort.canBind($0) }) else { throw DesktopError("无法分配内核预检端口") }
        let password = UUID().uuidString + UUID().uuidString
        let process = Process(); process.executableURL = node; process.arguments = [supervisor.path, directory.appendingPathComponent("server.js").path]; process.currentDirectoryURL = directory
        process.environment = ["HOME": FileManager.default.temporaryDirectory.path, "PATH": "/usr/bin:/bin", "NODE_ENV": "production", "HOSTNAME": "127.0.0.1", "PORT": String(port), "PASSWORD": password, "COOKIE_SECURE": "false", "LIBRETV_DESKTOP_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier), "NEXT_TELEMETRY_DISABLED": "1"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run()
        defer { process.terminate(); DispatchQueue.global(qos: .utility).async { let deadline = Date().addingTimeInterval(2); while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }; if process.isRunning { kill(process.processIdentifier, SIGKILL) } } }
        let base = URL(string: "http://127.0.0.1:\(port)")!
        let configuration = URLSessionConfiguration.ephemeral; configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        var status: [String: Any]?
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            guard process.isRunning else { throw DesktopError("官方内核预检启动失败") }
            if let (data, _) = try? await session.data(for: URLRequest(url: base.appendingPathComponent("api/status"), timeoutInterval: 1)), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { status = object; break }
            try await Task.sleep(for: .milliseconds(150))
        }
        guard let status, status["version"] as? String == version, status["passwordRequired"] as? Bool == true, status["defaultSources"] is [Any], status["defaultLiveSources"] is [Any], status["defaultSubscriptions"] is [Any] else { throw DesktopError("官方内核的状态/数据源接口与当前桌面附加层不兼容") }
        var login = URLRequest(url: base.appendingPathComponent("api/auth"), timeoutInterval: 5); login.httpMethod = "POST"; login.setValue("application/json", forHTTPHeaderField: "Content-Type"); login.httpBody = try JSONSerialization.data(withJSONObject: ["password": password])
        let (_, response) = try await session.data(for: login)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw DesktopError("官方内核鉴权接口预检失败") }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: http.allHeaderFields as? [String: String] ?? [:], for: base)
        let cookieHeader = HTTPCookie.requestHeaderFields(with: cookies)["Cookie"] ?? ""
        var authenticated = URLRequest(url: base.appendingPathComponent("api/status"), timeoutInterval: 5); authenticated.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        let (verifiedData, _) = try await session.data(for: authenticated)
        guard let verified = try JSONSerialization.jsonObject(with: verifiedData) as? [String: Any], verified["verified"] as? Bool == true else { throw DesktopError("官方内核会话接口预检失败") }
        // An ephemeral official page validates the real browser DB schema, independently of its source layout.
        let webConfiguration = WKWebViewConfiguration(); webConfiguration.websiteDataStore = .nonPersistent(); webConfiguration.mediaTypesRequiringUserActionForPlayback = .all
        let web = WKWebView(frame: .zero, configuration: webConfiguration)
        defer { web.stopLoading() }
        for cookie in cookies { await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
        web.load(URLRequest(url: base))
        var schemaChecked = false
        for _ in 0..<80 {
            if let value = try? await web.callAsyncJavaScript("if(!indexedDB.databases) return null; const list=await indexedDB.databases(); return list.find(x=>x.name==='libretv')?.version ?? null;", arguments: [:], in: nil, contentWorld: .page), let number = value as? NSNumber, number.intValue == 30 { schemaChecked = true; break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard schemaChecked else { throw DesktopError("官方页面的数据结构未能验证为当前支持的 IndexedDB v3，已阻止更新；现有内核和数据保持不变。") }
        let controls = try await web.evaluateJavaScript("['观看历史','设置','下载管理'].every(label=>document.querySelector('button[aria-label=\\\"'+label+'\\\"]'))") as? Bool ?? false
        guard controls else { throw DesktopError("官方导航入口已变化，需要先更新桌面附加层。现有内核保持不变。") }
    }
}
