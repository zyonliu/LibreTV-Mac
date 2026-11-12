import AppKit
import WebKit

@MainActor final class DownloadManager: NSObject, WKDownloadDelegate {
    static let shared = DownloadManager(preferences: .shared, recover: true)
    struct Stream { let handle: FileHandle; let temporary: URL; let destination: URL }
    struct Transfer { let temporary: URL; let destination: URL }
    private var streams: [String: Stream] = [:]
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var destinations: [ObjectIdentifier: Transfer] = [:]
    private let preferences: DesktopPreferences?
    private let ledger: URL?
    private var owned = Set<String>()
    private(set) var lastError: String?
    var activeCount: Int { streams.count + downloads.count }
    init(preferences: DesktopPreferences? = nil, recover: Bool = false) {
        self.preferences = preferences
        ledger = preferences?.support.appendingPathComponent("download-partials.json")
        super.init()
        if recover, let ledger, let data = try? Data(contentsOf: ledger), let paths = try? JSONDecoder().decode([String].self, from: data) {
            for path in paths {
                let file = URL(fileURLWithPath: path), name = file.lastPathComponent
                // Only our explicitly registered UUID temporary files; never final films or arbitrary paths.
                guard name.hasPrefix(".libretv-"), name.hasSuffix(".part"), UUID(uuidString: String(name.dropFirst(9).dropLast(5))) != nil else { continue }
                if FileManager.default.fileExists(atPath: path) {
                    do { try FileManager.default.removeItem(at: file) }
                    catch { owned.insert(path); lastError = "未完成文件暂时无法清理：\(error.localizedDescription)" }
                }
            }
            try? persistLedger()
        }
    }
    private func persistLedger() throws {
        guard let ledger else { return }
        try JSONEncoder().encode(Array(owned).sorted()).write(to: ledger, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: ledger.path)
    }
    private func temporary(for destination: URL) throws -> URL {
        let file = destination.deletingLastPathComponent().appendingPathComponent(".libretv-\(UUID().uuidString).part")
        owned.insert(file.path)
        do { try persistLedger() } catch { owned.remove(file.path); throw error }
        return file
    }
    private func removeTemporary(_ file: URL) {
        do { if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }; owned.remove(file.path); try persistLedger() }
        catch { lastError = error.localizedDescription }
    }
    func safeName(_ input: String) -> String {
        let cleaned = input.components(separatedBy: CharacterSet(charactersIn: "/\\:\0\n\r")).joined(separator: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "LibreTV-download" : String(cleaned.prefix(180))
    }
    func unique(_ proposed: URL) -> URL {
        if !FileManager.default.fileExists(atPath: proposed.path) { return proposed }
        let stem = proposed.deletingPathExtension().lastPathComponent, ext = proposed.pathExtension
        for i in 1...10000 {
            let name = "\(stem) (\(i))" + (ext.isEmpty ? "" : ".\(ext)")
            let next = proposed.deletingLastPathComponent().appendingPathComponent(name)
            if !FileManager.default.fileExists(atPath: next.path) { return next }
        }
        return proposed.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + "-" + proposed.lastPathComponent)
    }
    func destination(_ name: String, isExport: Bool = false) async throws -> URL {
        let prefs = preferences ?? .shared, config = prefs.read()
        let exporting = isExport || (name.lowercased().hasPrefix("libretv-") && name.lowercased().hasSuffix(".json"))
        let dir = URL(fileURLWithPath: config[exporting ? "exportDirectory" : "downloadDirectory"] as? String ?? (exporting ? prefs.defaultExports.path : prefs.defaultDownloads.path), isDirectory: true)
        guard !dir.path.hasPrefix("/Volumes/") || FileManager.default.fileExists(atPath: dir.path) else { throw DesktopError("下载磁盘未挂载，请重新选择目录。") }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if config["askEachTime"] as? Bool == true {
            let panel = NSSavePanel(); panel.nameFieldStringValue = safeName(name); panel.directoryURL = dir; panel.canCreateDirectories = true
            guard await panel.begin() == .OK, let url = panel.url else { throw DesktopError("已取消保存") }
            return unique(url)
        }
        return unique(dir.appendingPathComponent(safeName(name)))
    }
    func begin(_ filename: String) async throws -> [String: Any] { try openStream(at: await destination(filename)) }
    func openStream(at target: URL) throws -> [String: Any] {
        let id = UUID().uuidString, temp = try temporary(for: target)
        do {
            guard FileManager.default.createFile(atPath: temp.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw DesktopError("无法创建下载文件，请检查磁盘权限与剩余空间。") }
            streams[id] = Stream(handle: try FileHandle(forWritingTo: temp), temporary: temp, destination: target)
            return ["id": id, "path": target.path]
        } catch { removeTemporary(temp); throw error }
    }
    func append(_ id: String, base64: String) throws {
        guard let stream = streams[id], base64.utf8.count <= 1_500_000, let data = Data(base64Encoded: base64) else { throw DesktopError("无效的下载写入请求") }
        do { try stream.handle.write(contentsOf: data) }
        catch { abort(id); throw DesktopError("写入失败：\(error.localizedDescription)。请检查磁盘空间与连接。") }
    }
    func finish(_ id: String) throws -> [String: Any] {
        guard let stream = streams[id] else { throw DesktopError("下载任务不存在") }
        do {
            try stream.handle.synchronize(); try stream.handle.close()
            let target = unique(stream.destination)
            try FileManager.default.moveItem(at: stream.temporary, to: target)
            streams.removeValue(forKey: id); owned.remove(stream.temporary.path); try? persistLedger()
            return ["path": target.path]
        } catch { abort(id); throw error }
    }
    func abort(_ id: String) { guard let stream = streams.removeValue(forKey: id) else { return }; try? stream.handle.close(); removeTemporary(stream.temporary) }
    func shutdown() {
        for id in Array(streams.keys) { abort(id) }
        for download in downloads.values { download.cancel { _ in } }
        downloads.removeAll()
        for transfer in destinations.values { removeTemporary(transfer.temporary) }
        destinations.removeAll()
    }
    func own(_ download: WKDownload) { download.delegate = self; downloads[ObjectIdentifier(download)] = download }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        Task { @MainActor in
            do {
                let target = try await destination(suggestedFilename, isExport: response.mimeType == "application/json")
                guard downloads[ObjectIdentifier(download)] != nil else { completionHandler(nil); return }
                let temp = try temporary(for: target)
                destinations[ObjectIdentifier(download)] = Transfer(temporary: temp, destination: target); completionHandler(temp)
            } catch { lastError = error.localizedDescription; completionHandler(nil); downloads.removeValue(forKey: ObjectIdentifier(download)) }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        guard let transfer = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        do { try FileManager.default.moveItem(at: transfer.temporary, to: unique(transfer.destination)); owned.remove(transfer.temporary.path); try? persistLedger() }
        catch { lastError = error.localizedDescription; removeTemporary(transfer.temporary) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        lastError = error.localizedDescription; downloads.removeValue(forKey: ObjectIdentifier(download))
        if let transfer = destinations.removeValue(forKey: ObjectIdentifier(download)) { removeTemporary(transfer.temporary) }
    }
}
