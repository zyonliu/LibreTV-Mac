import AppKit
import Foundation

struct DesktopError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

@MainActor final class DesktopPreferences: ObservableObject {
    static let shared = DesktopPreferences()
    let support: URL
    let configURL: URL
    let defaults: UserDefaults
    private let home: URL
    @Published var appearance: String { didSet { defaults.set(appearance, forKey: "appearance"); applyAppearance() } }
    init(support: URL? = nil, defaults: UserDefaults = .standard, home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.defaults = defaults; self.home = home
        self.support = support ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LibreTVMac", isDirectory: true)
        configURL = self.support.appendingPathComponent("desktop-config.json")
        let savedAppearance = defaults.string(forKey: "appearance") ?? "system"
        appearance = ["system","light","dark"].contains(savedAppearance) ? savedAppearance : "system"
        try? FileManager.default.createDirectory(at: self.support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !FileManager.default.fileExists(atPath: configURL.path) {
            try? write(["cacheDirectory": defaultCache.path, "downloadDirectory": defaultDownloads.path, "askEachTime": false])
        }
        applyAppearance()
    }
    var defaultDownloads: URL { home.appendingPathComponent("Downloads/LibreTV") }
    var defaultCache: URL { home.appendingPathComponent("Library/Caches/LibreTV/Media") }
    var defaultExports: URL { home.appendingPathComponent("Documents/LibreTV/Exports") }
    func applyAppearance() { NSApp?.appearance = appearance == "system" ? nil : NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
    func read() -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(contentsOf: configURL))) as? [String: Any] ?? [:] }
    func write(_ data: [String: Any]) throws { try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]).write(to: configURL, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path) }
    func patch(_ values: [String: Any]) throws { var data = read(); data.merge(values) { _, new in new }; try write(data) }
    func snapshot(activeDownloads: Int = 0) -> [String: Any] { var data = read(); data["exportDirectory"] = data["exportDirectory"] ?? defaultExports.path; data["appearance"] = appearance; data.removeValue(forKey:"limitBytes"); data.removeValue(forKey:"cacheLimitTouched"); data["supportDirectory"] = support.path; data["activeDownloads"] = activeDownloads; return data }
    func choose(_ kind: String, reset: Bool = false, activeDownloads: Int = 0) async throws -> [String: Any] {
        if kind == "cache", activeDownloads > 0 { throw DesktopError("下载仍在进行，请先完成或取消下载，再更改缓存目录。") }
        guard ["cache","download","export"].contains(kind) else { throw DesktopError("未知目录类型") }
        var url = kind == "cache" ? defaultCache : kind == "export" ? defaultExports : defaultDownloads
        if !reset {
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
            panel.prompt = "选择文件夹"; panel.message = kind == "cache" ? "将在所选文件夹中创建 LibreTV-Media，专门存放可清理的媒体缓存。" : kind == "export" ? "选择官方配置与数据源文件的默认导出目录。" : "选择新下载任务的默认保存文件夹。"
            let result = await panel.begin()
            guard result == .OK, let selected = panel.url else { throw DesktopError("已取消选择") }
            url = kind == "cache" ? selected.appendingPathComponent("LibreTV-Media") : selected
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let probe = url.appendingPathComponent(".libretv-write-\(UUID().uuidString)")
        try Data().write(to: probe); try FileManager.default.removeItem(at: probe)
        // This local build is deliberately not sandboxed. Access is tested again at every write.
        if kind != "cache" { try patch([kind == "export" ? "exportDirectory" : "downloadDirectory": url.path]) }
        else { try patch(["pendingCacheDirectory": url.path]) }
        return ["path": url.path, "pending": kind == "cache"]
    }
    func reveal(_ kind: String) throws {
        let path = snapshot()[kind == "cache" ? "cacheDirectory" : kind == "export" ? "exportDirectory" : "downloadDirectory"] as? String ?? ""
        guard !path.isEmpty else { throw DesktopError("尚未配置目录") }
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }
}
