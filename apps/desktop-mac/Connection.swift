import Foundation
import Security

struct MacPair: Codable {
    let deviceId: UUID
    let token: String
    let owner: String
}

struct MacTask: Decodable {
    let id: UUID
    let status: String
    let nativeAction: String?
    let fileCopy: CopyInstruction?
}

struct MacPoll: Decodable {
    let task: MacTask?
    let authorizationId: UUID?
}

struct MacGrant: Decodable { let authorizationId: UUID? }
private struct Envelope<T: Decodable>: Decodable { let data: T }
private struct NoFields: Decodable {}

enum PairStore {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.xuti.finder-assistant",
         kSecAttrAccount as String: "production"]
    }
    static func load() throws -> MacPair? {
        var q = query
        q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw FinderFailure("无法读取钥匙串，请解锁后重试。")
        }
        return try JSONDecoder().decode(MacPair.self, from: data)
    }
    static func save(_ pair: MacPair) throws {
        let data = try JSONEncoder().encode(pair)
        var q = query
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        q[kSecValueData as String] = data
        var status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        }
        guard status == errSecSuccess else { throw FinderFailure("配对凭证无法保存到本机钥匙串。") }
    }
    static func forget() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw FinderFailure("无法移除钥匙串中的配对凭证。")
        }
    }
}

private final class SameOriginSession: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct MacServiceError: LocalizedError {
    let status: Int
    var errorDescription: String? {
        switch status {
        case 401, 403: return "配对或操作授权无效，请查看工作台中的设备状态。"
        case 409: return "任务状态已变化，请查看任务卡。"
        default: return "工作台请求失败（HTTP \(status)）。"
        }
    }
}

final class MacService {
    private let base = URL(string: "https://vip-web-production.up.railway.app/api/v1/my-workspace/assistant/desktop/client/")!
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 12
        config.timeoutIntervalForResource = 18
        session = URLSession(configuration: config, delegate: SameOriginSession(), delegateQueue: nil)
    }
    private func post<T: Decodable>(_ path: String, _ body: [String: Any], _ pair: MacPair?) async throws -> T {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let pair = pair { request.setValue("Bearer " + pair.token, forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FinderFailure("工作台连接失败。") }
        guard (200..<300).contains(http.statusCode) else { throw MacServiceError(status: http.statusCode) }
        return try JSONDecoder().decode(Envelope<T>.self, from: data).data
    }
    func pair(code: String, name: String) async throws -> MacPair {
        try await post("pair", ["code": code, "name": name, "platform": "macos"], nil)
    }
    func authorize(_ pair: MacPair, enabled: Bool) async throws -> MacGrant {
        try await post("authorization", ["enabled": enabled], pair)
    }
    func poll(_ pair: MacPair) async throws -> MacPoll {
        try await post("poll", ["platform": "macos", "fileCopyShortcuts": true], pair)
    }
    func pause(_ task: UUID, pair: MacPair) async throws {
        let _: NoFields = try await post("tasks/\(task.uuidString.lowercased())/control", [
            "action": "pause", "note": "Mac 已重新连接或接单已停止，请核对 Finder 后继续。"
        ], pair)
    }
    enum Action: String { case start, permitCopy = "permit_copy", copied, permitPaste = "permit_paste", complete, handoff }
    func progress(_ action: Action, task: UUID, attempt: UUID, grant: UUID, pair: MacPair, note: String? = nil) async throws {
        var body: [String: Any] = ["action": action.rawValue, "attemptId": attempt.uuidString.lowercased(),
                                   "authorizationId": grant.uuidString.lowercased()]
        if let note = note { body["note"] = String(note.prefix(300)) }
        let _: NoFields = try await post("tasks/\(task.uuidString.lowercased())/file-copy", body, pair)
    }
}
