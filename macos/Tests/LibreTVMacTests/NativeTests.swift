import XCTest
import Darwin
@testable import LibreTVMac

final class NativeTests: XCTestCase {
    @MainActor func testResetUnloadsRetiredJavaScriptContext() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "LibreTVResetTest.\(UUID().uuidString)", defaults = UserDefaults(suiteName:suite)!
        let prefs = DesktopPreferences(support:root,defaults:defaults,home:root)
        let browser = BrowserModel(service:ServiceManager(prefs:prefs),dataStore:.nonPersistent(),downloads:DownloadManager(preferences:prefs))
        defer { browser.reset(); defaults.removePersistentDomain(forName:suite); try? FileManager.default.removeItem(at:root) }
        let retired = browser.view(for:"original")
        retired.loadHTMLString("<script>window.__retiredDesktopContext=true</script><p>old document</p>",baseURL:nil)
        for _ in 0..<100 {
            if (try? await retired.evaluateJavaScript("window.__retiredDesktopContext === true")) as? Bool == true { break }
            try await Task.sleep(for:.milliseconds(30))
        }
        let started = try await retired.evaluateJavaScript("window.__retiredDesktopContext === true") as? Bool
        XCTAssertEqual(started,true)
        browser.reset()
        for _ in 0..<100 {
            if (try? await retired.evaluateJavaScript("document.readyState === 'complete' && typeof window.__retiredDesktopContext === 'undefined' && document.body.innerText === ''")) as? Bool == true { break }
            try await Task.sleep(for:.milliseconds(30))
        }
        let unloaded = try await retired.evaluateJavaScript("typeof window.__retiredDesktopContext === 'undefined' && document.body.innerText === ''") as? Bool
        XCTAssertEqual(unloaded,true)
        XCTAssertNil(retired.navigationDelegate); XCTAssertNil(retired.uiDelegate)
        XCTAssertTrue(retired.configuration.userContentController.userScripts.isEmpty)
    }
    @MainActor func testOnlyApplicationDocumentsReceiveNativePrivileges() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "LibreTVTrustTest.\(UUID().uuidString)", defaults = UserDefaults(suiteName:suite)!
        defer { defaults.removePersistentDomain(forName:suite); try? FileManager.default.removeItem(at:root) }
        let prefs = DesktopPreferences(support:root,defaults:defaults,home:root)
        let service = ServiceManager(prefs:prefs); service.baseURL = URL(string:"http://127.0.0.1:17891")!
        let browser = BrowserModel(service:service,dataStore:.nonPersistent(),downloads:DownloadManager(preferences:prefs))
        for path in ["/","/live","/watch","/about","/desktop?tab=original","/?desktopPanel=settings"] {
            XCTAssertTrue(browser.trustedDocument(URL(string:"http://127.0.0.1:17891"+path)))
        }
        for address in ["https://evil.test/","http://user:password@127.0.0.1:17891/","http://127.0.0.1:17892/","http://127.0.0.1:17891/api/proxy/https://evil.test/?desktopPanel=settings","http://127.0.0.1:17891/_next/static/file.js"] {
            XCTAssertFalse(browser.trustedDocument(URL(string:address)))
        }
    }
    @MainActor func testMainWindowCloseObserverRegistersAfterViewAttachment() {
        let window = NSWindow(contentRect:NSRect(x:0,y:0,width:680,height:540),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.isReleasedWhenClosed = false
        let view = MainWindowHostView()
        var closes = 0
        view.onClose = { closes += 1 }
        window.contentView = view
        window.close()
        XCTAssertEqual(closes,1)
    }
    @MainActor func testCrashRecoveryOnlyRemovesRegisteredOwnedParts() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "LibreTVRecovery.\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: root) }
        let prefs = DesktopPreferences(support:root.appendingPathComponent("Support"),defaults:defaults,home:root)
        let owned = root.appendingPathComponent(".libretv-\(UUID().uuidString).part"), film = root.appendingPathComponent("movie.mp4"), unrelated = root.appendingPathComponent("other.part")
        for file in [owned,film,unrelated] { try Data("keep".utf8).write(to:file) }
        try JSONEncoder().encode([owned.path,film.path,unrelated.path]).write(to:prefs.support.appendingPathComponent("download-partials.json"))
        let manager = DownloadManager(preferences:prefs,recover:true)
        XCTAssertEqual(manager.activeCount,0)
        XCTAssertFalse(FileManager.default.fileExists(atPath:owned.path))
        XCTAssertEqual(try Data(contentsOf:film),Data("keep".utf8)); XCTAssertEqual(try Data(contentsOf:unrelated),Data("keep".utf8))
    }
    @MainActor func testShutdownAndFailedPublishReleaseOwnedStreams() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let manager = DownloadManager()
        let first = try manager.openStream(at:root.appendingPathComponent("one.ts")), second = try manager.openStream(at:root.appendingPathComponent("two.ts"))
        XCTAssertEqual(manager.activeCount,2); manager.shutdown(); manager.shutdown(); XCTAssertEqual(manager.activeCount,0)
        XCTAssertThrowsError(try manager.finish(first["id"] as! String)); XCTAssertThrowsError(try manager.finish(second["id"] as! String))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:root.path),[])
        let task = try manager.openStream(at:root.appendingPathComponent("removed.ts"))
        try FileManager.default.removeItem(at:root)
        XCTAssertThrowsError(try manager.finish(task["id"] as! String)); XCTAssertEqual(manager.activeCount,0)
    }
    @MainActor func testStreamingSavePublishesAtomicallyAndNeverOverwrites() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = DownloadManager(), target = root.appendingPathComponent("movie.mp4")
        try Data("existing-user-file".utf8).write(to: target)
        let task = try manager.openStream(at: target), id = task["id"] as! String
        let bytes = Data((0..<100000).map { UInt8($0 % 256) })
        try manager.append(id, base64: bytes.base64EncodedString())
        XCTAssertEqual(try Data(contentsOf: target), Data("existing-user-file".utf8))
        let result = try manager.finish(id)
        XCTAssertNotEqual(result["path"] as? String, target.path)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: result["path"] as! String)), bytes)
        XCTAssertEqual(try Data(contentsOf: target), Data("existing-user-file".utf8))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasSuffix(".part") })
    }
    @MainActor func testAbortOnlyRemovesOwnedPartialFile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = DownloadManager(); let task = try manager.openStream(at: root.appendingPathComponent("new.ts")); let id = task["id"] as! String
        try Data("keep".utf8).write(to: root.appendingPathComponent("existing.mp4"))
        try manager.append(id, base64: Data("partial".utf8).base64EncodedString()); manager.abort(id)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["existing.mp4"])
        XCTAssertThrowsError(try manager.append(id, base64: "AA=="))
    }
    @MainActor func testOfficialCoreValidationDoesNotRequireDesktopFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertThrowsError(try CoreLayout.validate(root))
        for name in ["server.js", "package.json", ".next/BUILD_ID", ".next/server/app/api/status/route.js", ".next/server/app/api/auth/route.js", ".next/server/app/api/search/route.js", "node_modules/next/package.json"] {
            let file = root.appendingPathComponent(name); try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let text = name == "package.json" ? "{\"version\":\"2.22.0\"}" : name.hasSuffix("package.json") ? "{\"version\":\"15.5.26\"}" : ""
            try Data(text.utf8).write(to: file)
        }
        XCTAssertNoThrow(try CoreLayout.validate(root, version: "2.22.0"))
        XCTAssertThrowsError(try CoreLayout.validate(root, version: "99.0.0"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("desktop-adapter.json").path))
    }
    @MainActor func testOfficialReleasePreflight() async throws {
        guard let project = ProcessInfo.processInfo.environment["LIBRETV_TEST_PROJECT"] else { throw XCTSkip("Set LIBRETV_TEST_PROJECT to verify the downloaded official release") }
        let root = URL(fileURLWithPath: project)
        let resources = ProcessInfo.processInfo.environment["LIBRETV_TEST_RESOURCES"].map { URL(fileURLWithPath:$0) } ?? root.appendingPathComponent("build/LibreTV.app/Contents/Resources")
        try await CorePreflight.validate(root.appendingPathComponent("build/official/2.22.0/Core"), node: resources.appendingPathComponent("Runtime/node"), supervisor: resources.appendingPathComponent("Runtime/service-host.cjs"), version: "2.22.0")
    }
    func testPortProbeRejectsActiveListenerAndAllowsClosedSocket() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0); XCTAssertGreaterThanOrEqual(fd, 0)
        var reuse: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }; XCTAssertEqual(bound, 0); XCTAssertEqual(listen(fd, 1), 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        let port = Int(UInt16(bigEndian: address.sin_port)); XCTAssertFalse(LoopbackPort.canBind(port)); close(fd); XCTAssertTrue(LoopbackPort.canBind(port))
    }
    @MainActor func testFilenameSanitizationCannotEscapeDestination() {
        let manager = DownloadManager()
        XCTAssertEqual(manager.safeName("../../evil/file.mp4"), ".._.._evil_file.mp4")
        XCTAssertEqual(manager.safeName(".."), "LibreTV-download")
    }
}
