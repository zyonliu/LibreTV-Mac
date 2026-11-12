import XCTest
@testable import LibreTVMac

final class ProbeTransportTests: XCTestCase {
    @MainActor func testBoundedParallelOfficialTransportCancellationAndResponseLimit() async throws {
        guard let project = ProcessInfo.processInfo.environment["LIBRETV_TEST_PROJECT"] else { throw XCTSkip("Set LIBRETV_TEST_PROJECT") }
        let resources = ProcessInfo.processInfo.environment["LIBRETV_TEST_RESOURCES"].map { URL(fileURLWithPath:$0) } ?? URL(fileURLWithPath:project).appendingPathComponent("build/LibreTV.app/Contents/Resources")
        let node = resources.appendingPathComponent("Runtime/node")
        let fixture = Process(), pipe = Pipe()
        fixture.executableURL = node
        fixture.arguments = ["-e", """
        const http=require('node:http');let active=0,peak=0;
        const server=http.createServer((req,res)=>{active++;peak=Math.max(peak,active);setTimeout(()=>{active--;res.setHeader('Content-Type','application/json');res.end(req.url.includes('large=1')?'x'.repeat(5*1024*1024):JSON.stringify({ok:true,peak}));},100)});
        server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
        """]
        fixture.standardOutput = pipe; fixture.standardError = FileHandle.nullDevice
        try fixture.run()
        defer { if fixture.isRunning { fixture.terminate(); fixture.waitUntilExit() } }
        let port = String(decoding:pipe.fileHandleForReading.availableData,as:UTF8.self).trimmingCharacters(in:.whitespacesAndNewlines)
        let base = try XCTUnwrap(URL(string:"http://127.0.0.1:\(port)")), transport = OfficialProbeTransport()
        let start = Date()
        let peaks = try await withThrowingTaskGroup(of:Int.self) { group in
            for index in 0..<32 { group.addTask { @MainActor in
                let response = try await transport.request(id:"job\(index)",path:"/api/source/test",method:"POST",body:"{}",base:base,cookies:[])
                let json = try JSONSerialization.jsonObject(with:Data((response["body"] as! String).utf8)) as! [String:Any]
                return json["peak"] as! Int
            } }
            var values:[Int]=[];for try await value in group { values.append(value) };return values
        }
        XCTAssertEqual(peaks.max(),32); XCTAssertLessThan(Date().timeIntervalSince(start),2); XCTAssertEqual(transport.activeCount,0)
        let cancelled = Task { @MainActor in try await transport.request(id:"cancel",path:"/api/source/test",method:"POST",body:"{}",base:base,cookies:[]) }
        try await Task.sleep(for:.milliseconds(20)); transport.cancelAll()
        do { _ = try await cancelled.value; XCTFail("Cancelled request completed") } catch { }
        XCTAssertEqual(transport.activeCount,0)
        do { _ = try await transport.request(id:"large",path:"/api/source-list?large=1",method:"GET",body:nil,base:base,cookies:[]); XCTFail("Oversized response accepted") } catch { }
        do { _ = try await transport.request(id:"foreign",path:"https://example.com/api/source/test",method:"POST",body:nil,base:base,cookies:[]); XCTFail("Foreign URL accepted") } catch { }
        XCTAssertEqual(transport.activeCount,0)
    }
}
