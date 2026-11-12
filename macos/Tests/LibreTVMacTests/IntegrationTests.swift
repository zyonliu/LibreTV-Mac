import XCTest
import WebKit
import AVFoundation
@testable import LibreTVMac

final class IntegrationTests: XCTestCase {
    @MainActor private func ready(_ web: WKWebView, script: String = "typeof window.__ltDesktopBackup === 'function'") async throws {
        for _ in 0..<150 {
            if (try? await web.evaluateJavaScript(script)) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Web runtime not ready: \(web.url?.absoluteString ?? "nil"); condition: \(script)")
        throw DesktopError("Integration runtime timed out")
    }
    @MainActor private func js(_ web: WKWebView, _ script: String, _ args: [String: Any] = [:]) async throws -> Any? {
        try await web.callAsyncJavaScript(script, arguments: args, in: nil, contentWorld: .page)
    }
    @MainActor private func downloadRecords(_ web: WKWebView) async throws -> [[String:Any]] {
        // Observe committed records on the visible page. A full backup flushes
        // settings and reads every table; it is not a download-progress API.
        try await js(web,"""
        return await new window.__ltNativePromise((resolve,reject)=>{
          const request=indexedDB.open('libretv',30);request.onerror=()=>reject(request.error);
          request.onsuccess=()=>{
            const database=request.result,transaction=database.transaction('downloads','readonly');
            const rows=transaction.objectStore('downloads').getAll();let values;
            rows.onsuccess=()=>{values=rows.result;};
            transaction.oncomplete=()=>{database.close();resolve(values);};
            transaction.onabort=()=>{database.close();reject(transaction.error||new Error('Read-only download observation aborted'));};
          };
        });
        """) as? [[String:Any]] ?? []
    }
    @MainActor func testOfficialUpgradeRollbackSharedSettingsCacheAndNativeSave() async throws {
        guard let project = ProcessInfo.processInfo.environment["LIBRETV_TEST_PROJECT"] else { throw XCTSkip("Set LIBRETV_TEST_PROJECT for full local integration") }
        let projectURL = URL(fileURLWithPath: project), root = FileManager.default.temporaryDirectory.appendingPathComponent("libretv-integration-\(UUID().uuidString)")
        let suite = "LibreTVIntegration.\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!
        let prefs = DesktopPreferences(support: root.appendingPathComponent("Support"), defaults: defaults, home: root)
        let manager = DownloadManager(preferences: prefs, recover: true)
        let resources = ProcessInfo.processInfo.environment["LIBRETV_TEST_RESOURCES"].map { URL(fileURLWithPath:$0) } ?? projectURL.appendingPathComponent("build/LibreTV.app/Contents/Resources")
        let service = ServiceManager(prefs: prefs, resources: resources, bundledCore: projectURL.appendingPathComponent("build/official/2.21.2/Core"), readinessAttempts: 20)
        let browser = BrowserModel(service: service, dataStore: .nonPersistent(), downloads: manager)
        defer { browser.reset(); manager.shutdown(); service.stop(); defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: root) }
        try await CorePreflight.validate(service.bundledCore, node: service.nodeURL, supervisor: service.resources.appendingPathComponent("Runtime/service-host.cjs"), version: "2.21.2")
        await service.start(); XCTAssertTrue(service.ready, service.diagnostics()); XCTAssertEqual(service.version, "2.21.2")
        let desktop = browser.view(for: "desktop"); try await ready(desktop)
        let original = browser.view(for: "original"); try await ready(original, script: "document.readyState === 'complete' && !!document.querySelector('main')")
        try await ready(original, script: "document.documentElement.dataset.desktopMode === 'desktop'")
        try await ready(original, script: "getComputedStyle(document.querySelector('header:has(a[aria-label=\\\"LibreTV 首页\\\"])')).display === 'none'")
        await browser.switchMode("original")
        XCTAssertTrue(browser.current === original)
        try await ready(original, script: "getComputedStyle(document.querySelector('header:has(a[aria-label=\\\"LibreTV 首页\\\"])')).display !== 'none'")
        await browser.switchMode("desktop"); XCTAssertTrue(browser.current === original)
        // Independent pages on the same real gateway must read the same settings.
        _ = try await js(desktop, "localStorage.setItem('libretv-download-settings',JSON.stringify({proxy:true})); localStorage.setItem('libretv-video-cache-settings',JSON.stringify({enabled:false,horizonSeconds:600,maxBytesPerEpisode:104857600,maxTotalBytes:5368709120})); return true;")
        try await ready(original, script: "JSON.parse(localStorage.getItem('libretv-download-settings') || '{}').proxy === true")
        try await ready(original, script: "JSON.parse(localStorage.getItem('libretv-video-cache-settings') || '{}').enabled === false")
        let sharedQuota = try await js(original, "return JSON.parse(localStorage.getItem('libretv-video-cache-settings')).maxTotalBytes;") as? NSNumber
        XCTAssertEqual(sharedQuota?.int64Value, 5 * 1024 * 1024 * 1024)
        _ = try await js(original, "localStorage.setItem('libretv-download-settings',JSON.stringify({proxy:false})); localStorage.setItem('libretv-theme','dark'); return true;")
        try await ready(desktop, script: "JSON.parse(localStorage.getItem('libretv-download-settings') || '{}').proxy === false")
        try await ready(desktop, script: "document.documentElement.classList.contains('dark')")
        try await ready(desktop, script: "getComputedStyle(document.documentElement).getPropertyValue('--c-page').trim() === '11 16 26'")
        XCTAssertEqual(prefs.appearance, "dark")
        // Raw official page uses the host's standard browser file API without source patches.
        let bytes = try await js(original, "const handle=await showSaveFilePicker({suggestedName:'integration.ts'}); const output=await handle.createWritable(); const writer=output.getWriter(); await writer.write(new Uint8Array([0,1,255,8])); await writer.close(); return true;")
        XCTAssertEqual(bytes as? Bool, true)
        XCTAssertEqual(try Data(contentsOf: prefs.defaultDownloads.appendingPathComponent("integration.ts")), Data([0,1,255,8]))
        XCTAssertEqual(manager.activeCount, 0)
        _ = try await js(original,"const blob=new Blob([JSON.stringify({source:'official-export-test',version:1})],{type:'application/json'});const anchor=document.createElement('a');anchor.href=URL.createObjectURL(blob);anchor.download='LibreTV-Settings_integration.json';document.body.append(anchor);anchor.click();anchor.remove();return true;")
        let exportURL = prefs.defaultExports.appendingPathComponent("LibreTV-Settings_integration.json")
        for _ in 0..<100 { if FileManager.default.fileExists(atPath:exportURL.path) { break }; try await Task.sleep(for:.milliseconds(100)) }
        let exportData = try JSONSerialization.jsonObject(with:Data(contentsOf:exportURL)) as? [String:Any]
        XCTAssertEqual(exportData?["source"] as? String,"official-export-test")
        // Managed CacheStorage buckets land on disk and are readable by the other mode.
        let key = "https://fixture.libretv.test/shared.ts"
        _ = try await js(original, "const cache=await caches.open('libretv-video-v1'); await cache.put(key,new Response(new Uint8Array([4,5,6]))); return true;", ["key":key])
        let cached = try await js(desktop, "const response=await fetch('/api/desktop/cache?key='+encodeURIComponent(key)); return Array.from(new Uint8Array(await response.arrayBuffer()));", ["key":key])
        XCTAssertEqual(cached as? [Int], [4,5,6])
        let cacheFiles = try FileManager.default.contentsOfDirectory(atPath: prefs.defaultCache.path)
        XCTAssertTrue(cacheFiles.contains { $0.hasSuffix(".bin") })
        _ = try await js(desktop, "localStorage.setItem('desktop-integration-marker','before-upgrade'); return true;")
        let backup = try await js(desktop, "return await window.__ltDesktopBackup();") as! [String:Any]
        let cores = prefs.support.appendingPathComponent("Cores"); try FileManager.default.createDirectory(at: cores, withIntermediateDirectories: true)
        let candidate = cores.appendingPathComponent(UUID().uuidString)
        try FileManager.default.copyItem(at: projectURL.appendingPathComponent("build/official/2.22.0/Core"), to: candidate)
        try await CorePreflight.validate(candidate, node: service.nodeURL, supervisor: service.resources.appendingPathComponent("Runtime/service-host.cjs"), version: "2.22.0")
        let installer = CoreInstaller(service: service, browser: browser)
        try await installer.install(candidate); XCTAssertTrue(service.ready); XCTAssertEqual(service.version,"2.22.0")
        let upgraded = browser.view(for:"desktop"); try await ready(upgraded)
        // Queue ownership survives all outer tabs, mode changes, and pagination. Fixture requests never leave this isolated test web view.
        _ = try await js(upgraded,"""
        window.__fixtureCandidates=Array.from({length:120},(_,i)=>({id:'vod:https://fixture'+i+'.test/api',name:'Fixture '+i,url:'https://fixture'+i+'.test/api',type:'vod',origin:'isolated test'}));
        sessionStorage.setItem('desktop-candidates',JSON.stringify(window.__fixtureCandidates));
        window.__fixtureCalls=0;const actualFetch=window.fetch;
        window.fetch=async(input,options)=>{
          if(String(input)==='/api/source/test'){
            window.__fixtureCalls++;
            const index=Number(JSON.parse(options.body).url.match(/fixture(\\d+)/)[1]);
            await new Promise(resolve=>setTimeout(resolve,500));
            return new Response(JSON.stringify({ok:index<5||index>=8,ms:500,count:1}),{headers:{'Content-Type':'application/json'}});
          }
          if(String(input).startsWith('/api/desktop/discover?'))return new Response(JSON.stringify({candidates:window.__fixtureCandidates,repositories:[],note:'Isolated discovery fixture'}),{headers:{'Content-Type':'application/json'}});
          return actualFetch(input,options);
        };return true;
        """)
        await browser.showSettings(tab:"sources")
        try await ready(upgraded,script:"document.querySelectorAll('.desktop-source-row').length === 100")
        _ = try await js(upgraded,"[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='全部检测').click();return true;")
        try await ready(upgraded,script:"window.__fixtureCalls === 32")
        _ = try await js(upgraded,"[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='暂停').click();return true;")
        await browser.showSettings(tab:"desktop")
        await browser.switchMode("original")
        try await Task.sleep(for:.milliseconds(650))
        await browser.switchMode("desktop")
        await browser.showSettings(tab:"sources")
        try await ready(upgraded,script:"!![...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='继续' && !button.disabled)")
        let pausedCalls = try await js(upgraded,"return window.__fixtureCalls;") as? Int
        XCTAssertEqual(pausedCalls,32)
        _ = try await js(upgraded,"[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='继续').click();return true;")
        await browser.showSettings(tab:"updates")
        try await Task.sleep(for:.milliseconds(1800))
        await browser.showSettings(tab:"sources")
        try await ready(upgraded,script:"window.__fixtureCalls === 120 && [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='全部检测')?.disabled === false")
        let completedCalls = try await js(upgraded,"return window.__fixtureCalls;") as? Int
        XCTAssertEqual(completedCalls,120)
        // Eight selected addresses contain only five eligible entries. Successful imports
        // must move to Added, including after the same discovery result is fetched again.
        _ = try await js(upgraded,"for(let i=0;i<8;i++)document.querySelector('input[aria-label=\"选择 Fixture '+i+'\"]').click();return true;")
        try await ready(upgraded,script:"document.querySelector('.desktop-source-bulk-main').textContent.includes('8 项已选，其中 5 项可添加')")
        _ = try await js(upgraded,"[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='添加已选可用项（5）').click();return true;")
        try await ready(upgraded,script:"document.querySelector('.desktop-source-views').textContent.replace(/\\s/g,'').includes('发现结果115已添加5')")
        let hiddenAdded = try await js(upgraded,"return Array.from({length:5},(_,i)=>!document.querySelector('input[aria-label=\"选择 Fixture '+i+'\"]')).every(Boolean);") as? Bool
        XCTAssertEqual(hiddenAdded,true)
        _ = try await js(upgraded,"[...document.querySelectorAll('.desktop-source-views button')].find(button=>button.textContent.startsWith('已添加')).click();return true;")
        try await ready(upgraded,script:"document.querySelectorAll('.desktop-source-row').length===5")
        _ = try await js(upgraded,"[...document.querySelectorAll('.desktop-source-views button')].find(button=>button.textContent.startsWith('发现结果')).click();return true;")
        _ = try await js(upgraded,"const row=document.querySelector('input[aria-label=\"选择 Fixture 8\"]').closest('article');[...row.querySelectorAll('button')].find(button=>button.textContent.trim()==='添加').click();return true;")
        try await ready(upgraded,script:"document.querySelector('.desktop-source-views').textContent.replace(/\\s/g,'').includes('发现结果114已添加6')")
        _ = try await js(upgraded,"[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='发现数据源').click();return true;")
        try await ready(upgraded,script:"document.querySelector('.desktop-source-notice').textContent.includes('Isolated discovery fixture')")
        let alreadyAdded = try await js(upgraded,"return [0,1,2,3,4,8].some(i=>document.querySelector('input[aria-label=\"选择 Fixture '+i+'\"]'));") as? Bool
        XCTAssertEqual(alreadyAdded,false)
        _ = try await js(upgraded,"window.__fixtureCandidates=window.__fixtureCandidates.filter((_,i)=>i<5||i===8);[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='发现数据源').click();return true;")
        try await ready(upgraded,script:"document.querySelectorAll('.desktop-source-row').length===0 && document.body.textContent.includes('本次发现的项目均已添加')")
        await browser.showSettings(view:"history")
        try await ready(upgraded,script:"!!document.querySelector('iframe[title=\\\"官方观看历史\\\"]')?.contentDocument?.querySelector('[data-official-panel][aria-label=\\\"观看历史\\\"]')")
        await browser.showSettings(tab:"original")
        try await ready(upgraded,script:"!!document.querySelector('iframe[title=\\\"官方设置\\\"]')?.contentDocument?.querySelector('[data-official-panel][aria-label=\\\"设置\\\"]')")
        _ = try await js(upgraded,"window.__themeDocument=crypto.randomUUID();for(const frame of document.querySelectorAll('iframe'))frame.contentWindow.__themeDocument=crypto.randomUUID();window.__themeFrames=[...document.querySelectorAll('iframe')].map(frame=>frame.contentWindow.__themeDocument);return true;")
        for appearance in ["light","dark","system","light"] {
            _ = try await js(upgraded,"return await libreTVDesktop.call('preferences.set',{appearance});",["appearance":appearance])
            try await ready(upgraded,script:"[window,...[...document.querySelectorAll('iframe')].map(frame=>frame.contentWindow)].every(view=>view.document.documentElement.classList.contains('dark') === (localStorage.getItem('libretv-theme')==='dark'||(localStorage.getItem('libretv-theme')==='system'&&view.matchMedia('(prefers-color-scheme: dark)').matches)))")
            try await ready(browser.view(for:"original"),script:"document.documentElement.classList.contains('dark') === (localStorage.getItem('libretv-theme')==='dark'||(localStorage.getItem('libretv-theme')==='system'&&matchMedia('(prefers-color-scheme: dark)').matches))")
        }
        let retainedThemes = try await js(upgraded,"return window.__themeFrames.every((value,index)=>document.querySelectorAll('iframe')[index].contentWindow.__themeDocument===value);") as? Bool
        XCTAssertEqual(retainedThemes,true,"Changing appearance must not reload settings/history or stop their work")
        try await ready(browser.view(for:"original"),script:"!!document.querySelector('button[aria-label=\"切换主题，当前 浅色\"]')")
        await browser.showOfficial()
        if let fixture = ProcessInfo.processInfo.environment["LIBRETV_TEST_MEDIA_URL"] {
            let downloadPage = browser.view(for:"original")
            // Attach the current view as in the app; keep retired upgrade views
            // detached so they cannot also claim the same shared download records.
            let downloadWindow = NSWindow(contentRect:NSRect(x:120,y:120,width:960,height:640),styleMask:[.titled,.closable],backing:.buffered,defer:false)
            downloadWindow.isReleasedWhenClosed = false
            downloadWindow.title = "LibreTV 下载集成验收（隔离数据）"
            downloadWindow.contentView = downloadPage
            downloadWindow.orderFrontRegardless()
            defer { downloadWindow.close() }
            try await ready(downloadPage,script:"document.readyState === 'complete' && !!document.querySelector('button[aria-label=\"观看历史\"]')")
            _ = try await js(downloadPage,"window.dispatchEvent(new CustomEvent('libretv:add-download',{detail:{url:fixture,title:'Integration-HLS',format:'TS'}})); return true;",["fixture":fixture])
            var completed = false
            for _ in 0..<200 {
                _ = try await js(downloadPage,"return document.readyState;")
                if let entry = try await downloadRecords(downloadPage).first(where:{$0["title"] as? String == "Integration-HLS"}) {
                    if entry["status"] as? String == "completed" { completed = true; break }
                    if entry["status"] as? String == "error" { XCTFail("Official download failed: \(entry)"); break }
                }
                try await Task.sleep(for:.milliseconds(100))
            }
            XCTAssertTrue(completed, "Official HLS download should complete through the standard file and cache APIs")
            let exported = try Data(contentsOf:prefs.defaultDownloads.appendingPathComponent("Integration-HLS.ts"))
            var expected = Data()
            for i in 0..<3 { expected.append(try Data(contentsOf:projectURL.appendingPathComponent("build/verification-media/segment-\(i).ts"))) }
            XCTAssertEqual(exported, expected)
            XCTAssertEqual(manager.activeCount,0)
            // The shared DB can show completed before the page's completion/finally
            // callbacks have retired its output target. Await that lifecycle boundary.
            try await ready(downloadPage,script:"globalThis.__ltDownloadTargets?.size === 0")
            _ = try await js(downloadPage,"window.dispatchEvent(new CustomEvent('libretv:add-download',{detail:{url:fixture,title:'Integration-MP4',format:'MP4'}}));return true;",["fixture":fixture])
            var mp4Completed = false
            var mp4Last: [String:Any] = [:]
            for _ in 0..<200 {
                _ = try await js(downloadPage,"return document.readyState;")
                if let entry = try await downloadRecords(downloadPage).first(where:{$0["title"] as? String == "Integration-MP4"}) {
                    mp4Last = entry
                    if entry["status"] as? String == "completed" { mp4Completed = true; break }
                    if entry["status"] as? String == "error" {
                        let message = try await js(downloadPage,"return document.body.innerText.split('\\n').filter(line=>line.includes('Integration-MP4')).join(' | ');")
                        XCTFail("Official MP4 export failed: \(String(describing:message))"); break
                    }
                }
                try await Task.sleep(for:.milliseconds(100))
            }
            if !mp4Completed { let trace = try await js(downloadPage,"return {events:globalThis.__ltDownloadEvents,debug:[...(globalThis.__ltDownloadDebug||new Map())],targets:[...(globalThis.__ltDownloadTargets||new Map()).keys()]};"); print("DOWNLOAD TRACE",String(describing:trace)) }
            XCTAssertTrue(mp4Completed, String(describing:mp4Last))
            let mp4URL = prefs.defaultDownloads.appendingPathComponent("Integration-MP4.mp4")
            let mp4 = try Data(contentsOf:mp4URL)
            XCTAssertEqual(String(data:mp4.subdata(in:4..<8),encoding:.utf8),"ftyp")
            let asset = AVURLAsset(url:mp4URL), duration = try await asset.load(.duration), playable = try await asset.load(.isPlayable)
            XCTAssertTrue(playable); XCTAssertEqual(CMTimeGetSeconds(duration),18,accuracy:0.5)
            XCTAssertEqual(manager.activeCount,0)
            try await ready(downloadPage,script:"globalThis.__ltDownloadTargets?.size === 0")
        }
        let after = try await js(upgraded, "return await window.__ltDesktopBackup();") as! [String:Any]
        XCTAssertEqual((after["local"] as? [String:String])?["desktop-integration-marker"], "before-upgrade")
        XCTAssertEqual((after["tables"] as? [String:Any])?.keys.sorted(), (backup["tables"] as? [String:Any])?.keys.sorted())
        _ = try await js(upgraded,"localStorage.setItem('desktop-integration-marker','after-upgrade'); return true;")
        await browser.switchMode("original") // Rollback must use the addon bridge even from original mode.
        try await installer.rollback(); XCTAssertTrue(service.ready); XCTAssertEqual(service.version,"2.21.2")
        let restored = browser.view(for:"desktop"); try await ready(restored)
        let restoredMarker = try await js(restored,"return localStorage.getItem('desktop-integration-marker');") as? String
        XCTAssertEqual(restoredMarker,"before-upgrade")
        // A structurally complete candidate that crashes must not strand the service or version pointer.
        let broken = cores.appendingPathComponent(UUID().uuidString)
        try FileManager.default.copyItem(at: candidate, to: broken)
        try Data("process.exit(7);".utf8).write(to: broken.appendingPathComponent("server.js"))
        do { try await installer.install(broken); XCTFail("Broken server should fail activation") } catch { XCTAssertTrue(service.ready, service.diagnostics()); XCTAssertEqual(service.version,"2.21.2"); XCTAssertNil(try CoreLayout.selected(in:prefs.support)) }
        let port = Int(service.baseURL!.port!); browser.reset(); service.stop(); XCTAssertTrue(LoopbackPort.canBind(port))
    }
}
