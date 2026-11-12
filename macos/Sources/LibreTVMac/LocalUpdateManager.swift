import Foundation
import CryptoKit

/// The unmodified official runtime is updated independently of the desktop add-on.
/// Integrity, API/session contracts and real ephemeral browser data schema are checked before activation.
@MainActor final class LocalUpdateManager: NSObject, URLSessionDownloadDelegate {
    static let shared = LocalUpdateManager()
    var phase = "idle", message = "手动检查本机 LibreTV 内核更新", version = "", notes = "", releaseURL = "https://github.com/LibreSpark/LibreTV/releases"
    var received: Int64 = 0, expected: Int64 = 0
    var currentVersion: String = ""
    var installer: CoreInstaller?
    private var archiveURL: URL?, sumsURL: URL?, archiveName = ""
    private var task: URLSessionDownloadTask?, resumeData: Data?, operation = UUID(), busy = false
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private var staged: URL?
    private var directory: URL { DesktopPreferences.shared.support.appendingPathComponent("Updates", isDirectory: true) }
    func snapshot() -> [String: Any] { ["phase": phase, "message": message, "version": version, "currentVersion": currentVersion, "notes": notes, "releaseURL": releaseURL, "received": received, "expected": expected, "canInstall": phase == "ready", "hasRollback": FileManager.default.fileExists(atPath: CoreLayout.rollbackURL.path)] }
    private func request(_ url: URL) -> URLRequest { var req = URLRequest(url: url, timeoutInterval: 30); req.setValue("LibreTV-Mac-local", forHTTPHeaderField: "User-Agent"); return req }
    private func officialAsset(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), url.scheme == "https", url.host == "github.com", url.path.hasPrefix("/LibreSpark/LibreTV/releases/download/") else { return nil }; return url
    }
    func check() async throws {
        guard !busy, task == nil, !["verifying","installing"].contains(phase) else { throw DesktopError("已有更新任务正在运行") }
        busy = true; phase = "checking"; message = "正在读取官方 GitHub Releases"; defer { busy = false }
        do {
            let (data, response) = try await URLSession.shared.data(for: request(URL(string: "https://api.github.com/repos/LibreSpark/LibreTV/releases/latest")!))
            guard (response as? HTTPURLResponse)?.statusCode == 200, let release = try JSONSerialization.jsonObject(with: data) as? [String: Any], let tag = release["tag_name"] as? String else { throw DesktopError("无法读取官方发布信息，可能是网络失败或 GitHub 请求限额。") }
            version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            notes = release["body"] as? String ?? "暂无发布说明"
            if let value = release["html_url"] as? String, let url = URL(string: value), url.host == "github.com", url.path.hasPrefix("/LibreSpark/LibreTV/releases/") { releaseURL = value }
            let assets = release["assets"] as? [[String: Any]] ?? []
            archiveName = "libretv-\(version)-standalone.tar.gz"
            archiveURL = officialAsset(assets.first { $0["name"] as? String == archiveName }?["browser_download_url"] as? String)
            sumsURL = officialAsset(assets.first { $0["name"] as? String == "SHA256SUMS" }?["browser_download_url"] as? String)
            if version.compare(currentVersion, options: .numeric) != .orderedDescending { phase = "current"; message = "当前本地内核已是官方最新版本" }
            else if archiveURL == nil || sumsURL == nil { phase = "incompatible"; message = "官方发布缺少可核实的 standalone 包或 SHA256SUMS，当前服务保持不变。" }
            else { phase = "available"; message = "发现新版。下载后将验证校验和及桌面适配能力；不会自动替换当前服务。" }
        } catch { phase = "error"; message = error.localizedDescription; throw error }
    }
    func download() {
        guard !busy, task == nil, let archiveURL, ["available","paused","error"].contains(phase) else { return }
        operation = UUID(); phase = "downloading"; message = "正在下载官方内核包"
        if let resumeData { task = session.downloadTask(withResumeData: resumeData) } else { received = 0; expected = 0; task = session.downloadTask(with: request(archiveURL)) }
        task?.taskDescription = operation.uuidString; task?.resume()
    }
    func pause() {
        guard let active = task, phase == "downloading" else { return }
        operation = UUID(); task = nil; phase = "paused"; message = "下载已暂停"
        let token = operation
        active.cancel(byProducingResumeData: { data in Task { @MainActor in guard self.operation == token, self.phase == "paused" else { return }; self.resumeData = data } })
    }
    func cancel() { operation = UUID(); task?.cancel(); task = nil; resumeData = nil; received = 0; expected = 0; if !busy { phase = version.isEmpty ? "idle" : "available"; message = "已取消准备，当前服务继续运行" } }
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        Task { @MainActor in guard downloadTask.taskDescription == self.operation.uuidString else { return }; self.received = totalBytesWritten; self.expected = max(0, totalBytesExpectedToWrite) }
    }
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // URLSession deletes `location` when this callback returns. Move it before hopping executors.
        let retained = FileManager.default.temporaryDirectory.appendingPathComponent("libretv-update-\(UUID().uuidString).tar.gz")
        do { try FileManager.default.moveItem(at: location, to: retained) }
        catch { Task { @MainActor in self.phase = "error"; self.message = error.localizedDescription }; return }
        Task { @MainActor in
            guard downloadTask.taskDescription == self.operation.uuidString else { try? FileManager.default.removeItem(at: retained); return }
            self.task = nil; self.resumeData = nil
            guard [200,206].contains((downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0) else { self.phase = "error"; self.message = "更新包下载失败"; try? FileManager.default.removeItem(at: retained); return }
            await self.verify(retained)
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        Task { @MainActor in guard task.taskDescription == self.operation.uuidString else { return }; self.task = nil; self.phase = "error"; self.message = error.localizedDescription; self.resumeData = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data }
    }
    private func verify(_ file: URL) async {
        let token = operation; phase = "verifying"; message = "正在校验 SHA256SUMS 与官方包结构"; busy = true; defer { busy = false; try? FileManager.default.removeItem(at: file) }
        do {
            guard let sumsURL else { throw DesktopError("缺少官方校验文件") }
            let (data, response) = try await URLSession.shared.data(for: request(sumsURL))
            guard (response as? HTTPURLResponse)?.statusCode == 200, let sums = String(data: data, encoding: .utf8), let line = sums.split(separator: "\n").first(where: { $0.split(whereSeparator: { $0.isWhitespace }).last.map { String($0).replacingOccurrences(of: "*", with: "") == archiveName } ?? false }), let expectedHash = line.split(whereSeparator: { $0.isWhitespace }).first else { throw DesktopError("官方 SHA256SUMS 中找不到此更新包") }
            let hash = try await Task.detached(priority: .utility) { () -> String in let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }; var hasher = SHA256(); while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hasher.update(data: chunk) }; return hasher.finalize().map { String(format: "%02x", $0) }.joined() }.value
            guard operation == token else { return }
            guard hash.lowercased() == expectedHash.lowercased() else { throw DesktopError("更新包 SHA-256 校验失败，当前内核未被替换。") }
            let listing = try await Task.detached { try Self.tar(["-tzf", file.path]) }.value
            let entries = listing.split(separator: "\n").map(String.init)
            guard entries.allSatisfy({ !$0.hasPrefix("/") && !$0.split(separator: "/").contains("..") }) else { throw DesktopError("更新包包含不安全路径") }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let saved = directory.appendingPathComponent(archiveName); if FileManager.default.fileExists(atPath: saved.path) { try FileManager.default.removeItem(at: saved) }; try FileManager.default.copyItem(at: file, to: saved)
            let detail = try await Task.detached { try Self.tar(["-tvzf", saved.path]) }.value
            guard !detail.split(separator: "\n").contains(where: { $0.first == "l" || $0.first == "h" }) else { throw DesktopError("更新包包含链接文件，无法安全安装") }
            try FileManager.default.createDirectory(at: CoreLayout.coresURL, withIntermediateDirectories: true)
            let candidate = CoreLayout.coresURL.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
            do {
                _ = try await Task.detached { try Self.tar(["-xzf", saved.path, "-C", candidate.path, "--no-same-owner"]) }.value
                try CoreLayout.validate(candidate, version: version)
                message = "在隔离环境验证官方接口、会话和网页数据结构"
                try await CorePreflight.validate(candidate, node: Bundle.main.resourceURL!.appendingPathComponent("Runtime/node"), supervisor: Bundle.main.resourceURL!.appendingPathComponent("Runtime/service-host.cjs"), version: version)
            } catch { try? FileManager.default.removeItem(at: candidate); throw error }
            guard operation == token else { try? FileManager.default.removeItem(at: candidate); return }
            staged = candidate; phase = "ready"; message = "官方包校验及接口、数据结构预检通过。点击安装后将备份数据，并短暂中断播放。"
        } catch { if operation == token { phase = "error"; message = error.localizedDescription } }
    }
    func install() async throws {
        guard phase == "ready", let staged, let installer else { throw DesktopError("尚无可安装的兼容内核包") }
        phase = "installing"; message = "备份配置并更新本地服务"
        do { try await installer.install(staged); phase = "complete"; message = "本地内核更新完成"; self.staged = nil }
        catch { phase = "error"; message = error.localizedDescription; throw error }
    }
    func rollback() async throws {
        guard !["checking","downloading","verifying","installing"].contains(phase), let installer else { throw DesktopError("请等待当前更新任务完成") }
        phase = "installing"; message = "正在恢复上一内核与数据备份"
        do { try await installer.rollback(); phase = "complete"; message = "已恢复上一内核与备份数据" }
        catch { phase = "error"; message = error.localizedDescription; throw error }
    }
    nonisolated static func tar(_ args: [String]) throws -> String {
        let process = Process(), output = Pipe(); process.executableURL = URL(fileURLWithPath: "/usr/bin/tar"); process.arguments = args; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run(); let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit(); guard process.terminationStatus == 0, let text = String(data: data, encoding: .utf8) else { throw DesktopError("无法检查更新包结构") }; return text
    }
}
