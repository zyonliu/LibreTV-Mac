import AppKit
import WebKit
import Darwin

@MainActor final class ServiceManager: ObservableObject {
    @Published var phase = "准备运行环境"
    @Published var ready = false
    @Published var failure: String?
    @Published var baseURL: URL?
    @Published var version = ""
    let prefs: DesktopPreferences
    let resources: URL
    let bundledCore: URL
    let readinessAttempts: Int
    init(prefs: DesktopPreferences? = nil, resources: URL? = nil, bundledCore: URL? = nil, readinessAttempts: Int = 120) {
        self.prefs = prefs ?? .shared; self.resources = resources ?? Bundle.main.resourceURL!
        self.bundledCore = bundledCore ?? self.resources.appendingPathComponent("Core")
        self.readinessAttempts = readinessAttempts
    }
    private var process: Process?
    private var starting = false
    private var generation = UUID()
    private var heartbeat: Task<Void, Never>?
    let instance = UUID().uuidString
    var cookie: HTTPCookie?
    var desktopCookie: HTTPCookie?
    let desktopKey = UUID().uuidString + UUID().uuidString
    var logURL: URL { prefs.support.appendingPathComponent("service.log") }
    var coreURL: URL { (try? CoreLayout.selected(in: prefs.support)) ?? bundledCore }
    var nodeURL: URL { resources.appendingPathComponent("Runtime/node") }
    func start() async {
        guard !starting, !ready else { return }
        starting = true; defer { starting = false }
        failure = nil; phase = "准备运行环境"
        let run = UUID(); generation = run
        do {
            guard FileManager.default.isExecutableFile(atPath: nodeURL.path), FileManager.default.fileExists(atPath: coreURL.appendingPathComponent("server.js").path) else { throw DesktopError("应用运行资源不完整，请重新运行 scripts/build-macos.sh。") }
            var port = prefs.defaults.integer(forKey: "servicePort")
            if port == 0 { port = (17891...17991).first { LoopbackPort.canBind($0) } ?? 0; guard port > 0 else { throw DesktopError("无法分配本机端口") }; prefs.defaults.set(port, forKey: "servicePort") }
            guard LoopbackPort.canBind(port) else { throw DesktopError("本地端口 \(port) 已被占用。请关闭占用它的程序后重试。为保留网页数据，应用不会自动切换地址。") }
            let url = URL(string: "http://127.0.0.1:\(port)")!; baseURL = url
            let passwordURL = prefs.support.appendingPathComponent("service-secret")
            let password: String
            if let value = try? String(contentsOf: passwordURL, encoding: .utf8), !value.isEmpty { password = value }
            else { password = UUID().uuidString + UUID().uuidString; try password.write(to: passwordURL, atomically: true, encoding: .utf8); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: passwordURL.path) }
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
            let log = try FileHandle(forWritingTo: logURL); try log.truncate(atOffset: 0)
            let child = Process(); child.executableURL = nodeURL; child.arguments = [resources.appendingPathComponent("Runtime/service-host.cjs").path, resources.appendingPathComponent("Runtime/gateway.cjs").path]
            child.currentDirectoryURL = coreURL
            // Do not inherit development settings such as NODE_OPTIONS, PORT or PATH from the host.
            child.environment = ["HOME": FileManager.default.homeDirectoryForCurrentUser.path, "PATH": "/usr/bin:/bin", "NODE_ENV": "production", "HOSTNAME": "127.0.0.1", "PORT": String(port), "PASSWORD": password, "COOKIE_SECURE": "false", "LIBRETV_DESKTOP_CONFIG": prefs.configURL.path, "LIBRETV_DESKTOP_INSTANCE": instance, "NEXT_TELEMETRY_DISABLED": "1", "LIBRETV_CORE_PATH": coreURL.path, "LIBRETV_DESKTOP_PATH": resources.appendingPathComponent("Desktop").path, "LIBRETV_DESKTOP_API_KEY": desktopKey, "LIBRETV_DESKTOP_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier), "LIBRETV_DESKTOP_STATE_PATH": prefs.support.appendingPathComponent("service-\(instance).json").path]
            child.standardOutput = log; child.standardError = log
            phase = "启动本地服务"; try child.run(); process = child
            child.terminationHandler = { [weak self] p in Task { @MainActor in guard let self, self.generation == run, self.ready else { return }; self.ready = false; self.failure = "本地服务已退出（\(p.terminationStatus)），可重新启动。" } }
            phase = "健康检查"
            var healthy = false
            for _ in 0..<readinessAttempts {
                guard generation == run else { return }
                if !child.isRunning { throw DesktopError("本地服务启动失败，请查看诊断日志。") }
                if let (data, _) = try? await URLSession.shared.data(for: URLRequest(url: url.appendingPathComponent("api/desktop/status"), timeoutInterval: 1)), let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any], status["instance"] as? String == instance {
                    version = status["version"] as? String ?? ""; healthy = true; break
                }
                try await Task.sleep(for: .milliseconds(250))
            }
            guard healthy else { throw DesktopError("本地服务启动超时，请查看诊断日志后重试。") }
            var request = URLRequest(url: url.appendingPathComponent("api/auth")); request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["password": password])
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw DesktopError("本地会话建立失败") }
            cookie = HTTPCookie.cookies(withResponseHeaderFields: http.allHeaderFields as? [String: String] ?? [:], for: url).first { $0.name == "ltv_session" }
            guard cookie != nil else { throw DesktopError("本地服务没有返回有效会话") }
            desktopCookie = HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "ltv_desktop", .value: desktopKey, .expires: Date().addingTimeInterval(86400 * 90), HTTPCookiePropertyKey("HttpOnly"): "TRUE"])
            phase = "加载页面"; ready = true
        } catch { stop(); failure = error.localizedDescription }
    }
    func pageReady() { if ready { phase = "就绪" } }
    func restart() async { stop(); await start() }
    func stop() {
        generation = UUID(); heartbeat?.cancel(); ready = false
        guard let child = process else { return }; child.terminationHandler = nil
        if child.isRunning { child.terminate(); let end = Date().addingTimeInterval(3); while child.isRunning && Date() < end { Thread.sleep(forTimeInterval: 0.02) }; if child.isRunning { kill(child.processIdentifier, SIGKILL) } }
        process = nil
    }
    func diagnostics() -> String { let log = (try? String(contentsOf: logURL, encoding: .utf8)) ?? "暂无服务日志"; return "LibreTV Mac\n状态：\(phase)\n\(failure ?? "")\n\(log.suffix(16000))" }
}

/// SO_REUSEADDR ignores closed TCP connections in TIME_WAIT, but never an active listener.
enum LoopbackPort {
    static func canBind(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0); guard fd >= 0 else { return false }; defer { close(fd) }
        var reuse: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_port = in_port_t(port).bigEndian; address.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 } }
    }
}
