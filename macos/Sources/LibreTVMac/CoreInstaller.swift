import Foundation
import WebKit

@MainActor enum CoreLayout {
    static func validate(_ directory: URL, version: String? = nil) throws {
        for file in ["server.js", "package.json", ".next/BUILD_ID", ".next/server/app/api/status/route.js", ".next/server/app/api/auth/route.js", ".next/server/app/api/search/route.js", "node_modules/next/package.json"] {
            guard FileManager.default.fileExists(atPath: directory.appendingPathComponent(file).path) else { throw DesktopError("官方内核包缺少运行文件：\(file)") }
        }
        let package = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("package.json"))) as? [String: Any]
        guard let actual = package?["version"] as? String, version == nil || actual == version else { throw DesktopError("内核包的实际版本与官方发布信息不一致") }
        let runtime = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("node_modules/next/package.json"))) as? [String: Any]
        guard (runtime?["version"] as? String)?.hasPrefix("15.") == true else { throw DesktopError("当前桌面附加层仅验证过 Next.js 15 内核，请先更新桌面适配能力。") }
    }
    static var selectionURL: URL { DesktopPreferences.shared.support.appendingPathComponent("current-core.json") }
    static var coresURL: URL { DesktopPreferences.shared.support.appendingPathComponent("Cores", isDirectory: true) }
    static var rollbackURL: URL { DesktopPreferences.shared.support.appendingPathComponent("rollback.json") }
    static func selected(in location: URL? = nil) throws -> URL? {
        let support = location ?? DesktopPreferences.shared.support
        let selectionURL = support.appendingPathComponent("current-core.json")
        let coresURL = support.appendingPathComponent("Cores")
        guard FileManager.default.fileExists(atPath: selectionURL.path) else { return nil }
        let data = try JSONSerialization.jsonObject(with: Data(contentsOf: selectionURL)) as? [String: String]
        guard let name = data?["directory"], UUID(uuidString: name) != nil else { throw DesktopError("本地内核版本引用损坏") }
        let url = coresURL.appendingPathComponent(name, isDirectory: true); try validate(url); return url
    }
    static func select(_ directory: URL?, in location: URL? = nil) throws {
        let support = location ?? DesktopPreferences.shared.support
        let selectionURL = support.appendingPathComponent("current-core.json")
        let coresURL = support.appendingPathComponent("Cores")
        guard let directory else { if FileManager.default.fileExists(atPath: selectionURL.path) { try FileManager.default.removeItem(at: selectionURL) }; return }
        guard directory.deletingLastPathComponent().standardizedFileURL == coresURL.standardizedFileURL, UUID(uuidString: directory.lastPathComponent) != nil else { throw DesktopError("拒绝使用内核目录之外的路径") }
        try validate(directory)
        try JSONSerialization.data(withJSONObject: ["directory": directory.lastPathComponent]).write(to: selectionURL, options: .atomic)
    }
}

@MainActor final class CoreInstaller {
    let service: ServiceManager
    let browser: BrowserModel
    init(service: ServiceManager, browser: BrowserModel) { self.service = service; self.browser = browser }
    private var support: URL { service.prefs.support }
    private var rollbackURL: URL { support.appendingPathComponent("rollback.json") }
    private func restore(_ snapshot: Any) async throws {
        let web = browser.view(for: "desktop")
        for _ in 0..<80 {
            if (try? await web.evaluateJavaScript("typeof window.__ltDesktopRestore === 'function'")) as? Bool == true { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        _ = try await web.callAsyncJavaScript("if (!window.__ltDesktopRestore) throw new Error('数据恢复接口未就绪'); return await window.__ltDesktopRestore(snapshot);", arguments: ["snapshot": snapshot], in: nil, contentWorld: .page)
    }
    func install(_ directory: URL) async throws {
        guard browser.downloads.activeCount == 0 else { throw DesktopError("请先完成或取消下载，再更新内核。") }
        try CoreLayout.validate(directory)
        // Pause before snapshot; no new core page runs until the health check succeeds.
        await browser.prepareForShutdown()
        let previous = try CoreLayout.selected(in: support)
        let backupID = UUID().uuidString
        let backupRoot = support.appendingPathComponent("Backups", isDirectory: true)
        try FileManager.default.createDirectory(at: backupRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let web = browser.view(for: "desktop")
        for _ in 0..<80 { if (try? await web.evaluateJavaScript("typeof window.__ltDesktopBackup === 'function'")) as? Bool == true { break }; try await Task.sleep(for: .milliseconds(100)) }
        guard let snapshot = try await web.callAsyncJavaScript("if (!window.__ltDesktopBackup) throw new Error('本地数据备份接口尚未就绪'); return await window.__ltDesktopBackup();", arguments: [:], in: nil, contentWorld: .page) else { throw DesktopError("数据备份为空") }
        let snapshotURL = backupRoot.appendingPathComponent(backupID + ".json")
        try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]).write(to: snapshotURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: snapshotURL.path)
        var rollback: [String: Any] = ["backupID": backupID, "previousBundled": previous == nil]
        if let previous { rollback["previousDirectory"] = previous.lastPathComponent }
        let previousRollback = try? Data(contentsOf: rollbackURL)
        try JSONSerialization.data(withJSONObject: rollback).write(to: rollbackURL, options: .atomic)
        browser.downloads.shutdown(); service.stop(); browser.reset()
        do {
            try CoreLayout.select(directory, in: support); await service.start()
            guard service.ready else { throw DesktopError(service.failure ?? "新版内核健康检查失败") }
            LocalUpdateManager.shared.currentVersion = service.version
        } catch {
            service.stop(); try CoreLayout.select(previous, in: support); await service.start(); LocalUpdateManager.shared.currentVersion = service.version
            if let previousRollback { try previousRollback.write(to: rollbackURL, options: .atomic) }
            else { try? FileManager.default.removeItem(at: rollbackURL) }
            throw DesktopError("新版启动失败，已恢复上一内核。\(error.localizedDescription)")
        }
    }
    func rollback() async throws {
        guard browser.downloads.activeCount == 0 else { throw DesktopError("请先完成或取消下载，再回退内核。") }
        let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: rollbackURL)) as? [String: Any]
        guard let id = metadata?["backupID"] as? String, UUID(uuidString: id) != nil else { throw DesktopError("没有可用的回退备份") }
        let previous: URL?
        if metadata?["previousBundled"] as? Bool == true { previous = nil }
        else { guard let name = metadata?["previousDirectory"] as? String, UUID(uuidString: name) != nil else { throw DesktopError("回退版本引用无效") }; previous = support.appendingPathComponent("Cores").appendingPathComponent(name); try CoreLayout.validate(previous!) }
        // Only reverse versions that passed the same browser schema preflight.
        // The backup retains every Dexie table and localStorage entry, not only viewing history.
        let backupURL = support.appendingPathComponent("Backups/\(id).json")
        let backup = try JSONSerialization.jsonObject(with: Data(contentsOf: backupURL))
        guard let object = backup as? [String: Any], object["schema"] as? Int == 3, object["tables"] is [String:Any], object["local"] is [String:String] else { throw DesktopError("回退备份结构无效，未切换内核。") }
        // Preserve data created after the upgrade before restoring an older snapshot.
        await browser.prepareForShutdown()
        let active = browser.view(for: "desktop")
        for _ in 0..<80 { if (try? await active.evaluateJavaScript("typeof window.__ltDesktopBackup === 'function'")) as? Bool == true { break }; try await Task.sleep(for: .milliseconds(100)) }
        guard let safety = try await active.callAsyncJavaScript("return await window.__ltDesktopBackup();", arguments: [:], in: nil, contentWorld: .page) else { throw DesktopError("无法备份回退前的数据") }
        let safetyURL = support.appendingPathComponent("Backups/before-rollback-\(UUID().uuidString).json")
        try JSONSerialization.data(withJSONObject: safety).write(to:safetyURL,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:safetyURL.path)
        let current = try CoreLayout.selected(in: support); browser.downloads.shutdown(); service.stop(); browser.reset()
        try CoreLayout.select(previous, in: support); await service.start()
        guard service.ready else { service.stop(); try CoreLayout.select(current, in: support); await service.start(); throw DesktopError("回退内核启动失败，已尝试恢复当前版本") }
        do { try await restore(backup) }
        catch {
            service.stop(); browser.reset(); try CoreLayout.select(current, in: support); await service.start()
            if service.ready { try await restore(safety); browser.reset() }
            throw DesktopError("回退恢复失败，已尝试恢复回退前的内核与数据；安全快照：\(safetyURL.path)。\(error.localizedDescription)")
        }
        browser.reset(); LocalUpdateManager.shared.currentVersion = service.version
    }
}
