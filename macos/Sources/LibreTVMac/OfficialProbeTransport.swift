import Foundation

/// Only transports the official probe APIs. Interpretation and health records stay in LibreTV.
@MainActor final class OfficialProbeTransport: NSObject, URLSessionDataDelegate {
    private struct Pending {
        let task: URLSessionDataTask
        let continuation: CheckedContinuation<[String: Any], Error>
        var bytes = Data()
        var response: HTTPURLResponse?
    }
    private var pending: [Int: Pending] = [:]
    private var identifiers: [String: Int] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 32
        configuration.timeoutIntervalForRequest = 9
        configuration.timeoutIntervalForResource = 10
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }()
    var activeCount: Int { pending.count }
    func request(id: String, path: String, method: String, body: String?, base: URL, cookies: [HTTPCookie]) async throws -> [String: Any] {
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.scheme == base.scheme, url.host == base.host, url.port == base.port,
              ["/api/source/test", "/api/live/playlist", "/api/source-list"].contains(url.path),
              (url.path == "/api/source/test" ? method == "POST" : method == "GET"), !id.isEmpty, identifiers[id] == nil,
              pending.count < 64, (body?.utf8.count ?? 0) <= 16_384 else { throw DesktopError("拒绝无效或超出并发限制的官方测活请求") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body?.data(using: .utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (header, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: header) }
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request)
            pending[task.taskIdentifier] = Pending(task: task, continuation: continuation)
            identifiers[id] = task.taskIdentifier
            task.resume()
        }
    }
    func cancel(_ id: String) { if let key = identifiers[id] { pending[key]?.task.cancel() } }
    func cancelAll() { for item in pending.values { item.task.cancel() } }
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        MainActor.assumeIsolated {
            guard pending[dataTask.taskIdentifier] != nil, response.expectedContentLength <= 4 * 1024 * 1024 else { completionHandler(.cancel); return }
            pending[dataTask.taskIdentifier]?.response = response as? HTTPURLResponse
            completionHandler(.allow)
        }
    }
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated {
            guard let item = pending[dataTask.taskIdentifier] else { return }
            guard item.bytes.count + data.count <= 4 * 1024 * 1024 else { dataTask.cancel(); return }
            pending[dataTask.taskIdentifier]?.bytes.append(data)
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated {
            guard let item = pending.removeValue(forKey: task.taskIdentifier) else { return }
            identifiers = identifiers.filter { $0.value != task.taskIdentifier }
            if let error { item.continuation.resume(throwing: error); return }
            guard let response = item.response, let body = String(data: item.bytes, encoding: .utf8) else { item.continuation.resume(throwing: DesktopError("官方测活响应无效")); return }
            item.continuation.resume(returning: ["status": response.statusCode, "body": body])
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
