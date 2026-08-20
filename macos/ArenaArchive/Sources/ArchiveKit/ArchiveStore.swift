import Foundation

public struct ChatIndexEntry: Codable, Equatable {
    public var rel: String
    public var mode: String
    public var subtype: String?
    public var title: String
    public var url: String?
    public var models: [String]
    public var modelsPending: Bool
    public var updatedAt: String

    enum CodingKeys: String, CodingKey {
        case rel, mode, subtype, title, url, models
        case modelsPending = "models_pending"
        case updatedAt = "updated_at"
    }
}

public struct ArchiveIndex: Codable {
    public var version: Int
    public var chats: [String: ChatIndexEntry]
    public init(version: Int = 1, chats: [String: ChatIndexEntry] = [:]) {
        self.version = version
        self.chats = chats
    }
}

public struct HostResponse: Codable {
    public var ok: Bool
    public var id: Int?
    public var version: String?
    public var root: String?
    public var app: String?
    public var rel: String?
    public var exists: Bool?
    public var error: String?
    public var written: [String]?
}

public final class ArchiveStore {
    public private(set) var root: URL
    public static let defaultRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Documents/arena-archive", isDirectory: true)

    public init(root: URL? = nil) {
        self.root = root ?? ArchiveStore.loadSavedRoot() ?? ArchiveStore.defaultRoot
    }

    public static var configURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ArenaArchive/config.json")
    }

    public static func loadSavedRoot() -> URL? {
        guard let data = try? Data(contentsOf: configURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = obj["root"] as? String else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    public func setRoot(_ path: String) throws {
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        root = url
        let dir = ArchiveStore.configURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: ["root": url.path], options: [.prettyPrinted])
        try data.write(to: ArchiveStore.configURL)
    }

    public func ensureRoot() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    public func indexURL() -> URL { root.appendingPathComponent("_index.json") }

    public func loadIndex() -> ArchiveIndex {
        guard let data = try? Data(contentsOf: indexURL()),
              let idx = try? JSONDecoder().decode(ArchiveIndex.self, from: data) else {
            return ArchiveIndex()
        }
        return idx
    }

    public func saveIndex(_ index: ArchiveIndex) throws {
        try ensureRoot()
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try enc.encode(index)
        try data.write(to: indexURL())
    }

    public func resolve(_ key: String) -> ChatIndexEntry? {
        loadIndex().chats[key]
    }

    public func safeRelpath(_ rel: String) throws -> URL {
        if rel.contains("..") || rel.hasPrefix("/") || rel.contains("\0") {
            throw NSError(domain: "ArchiveKit", code: 1, userInfo: [NSLocalizedDescriptionKey: "illegal path"])
        }
        let url = root.appendingPathComponent(rel).standardizedFileURL
        let rootStd = root.standardizedFileURL.path
        if !url.path.hasPrefix(rootStd) {
            throw NSError(domain: "ArchiveKit", code: 1, userInfo: [NSLocalizedDescriptionKey: "path escapes archive root"])
        }
        return url
    }

    public func writeUTF8(rel: String, content: String) throws {
        let url = try safeRelpath(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(content.utf8).write(to: url)
    }

    public func sync(chat: [String: Any], files: [[String: Any]]) throws -> (rel: String, written: [String]) {
        try ensureRoot()
        guard let key = chat["key"] as? String, !key.isEmpty else {
            throw NSError(domain: "ArchiveKit", code: 2, userInfo: [NSLocalizedDescriptionKey: "missing chat key"])
        }
        var index = loadIndex()
        let mode = (chat["mode"] as? String) ?? "agent"
        var subtype = chat["subtype"] as? String
        if subtype == "webdev" { subtype = "code" }
        let title = (chat["title"] as? String) ?? key
        if let existing = index.chats[key] {
            subtype = existing.subtype ?? subtype
        }
        let rel: String
        if let existing = index.chats[key] {
            rel = existing.rel
        } else {
            let slug = Self.slug(title: title, key: key)
            if mode == "battle" {
                rel = "battle/\(subtype ?? "text")/\(slug)"
            } else {
                rel = "agent/\(slug)"
            }
        }
        var written: [String] = []
        for file in files {
            guard let path = file["path"] as? String,
                  let content = file["content"] as? String else { continue }
            try writeUTF8(rel: "\(rel)/\(path)", content: content)
            written.append(path)
        }
        let models = (chat["models"] as? [String]) ?? []
        let pending = (chat["models_pending"] as? Bool) ?? models.isEmpty
        index.chats[key] = ChatIndexEntry(
            rel: rel,
            mode: mode,
            subtype: subtype,
            title: title,
            url: chat["url"] as? String,
            models: models,
            modelsPending: pending,
            updatedAt: ISO8601DateFormatter().string(from: Date())
        )
        try saveIndex(index)
        return (rel, written)
    }

    public func writeChunk(key: String, path: String, content: String) throws {
        guard let entry = resolve(key) else {
            throw NSError(domain: "ArchiveKit", code: 3, userInfo: [NSLocalizedDescriptionKey: "unknown chat key"])
        }
        try writeUTF8(rel: "\(entry.rel)/\(path)", content: content)
    }

    public static func slug(title: String, key: String) -> String {
        let base = title.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let clipped = String(base.prefix(60))
        let id = key.replacingOccurrences(of: "^[cs]:", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[^a-zA-Z0-9]", with: "", options: .regularExpression)
        let short = String(id.prefix(8))
        let head = clipped.isEmpty ? "chat" : clipped
        return short.isEmpty ? head : "\(head)--\(short)"
    }
}

public enum NativeProtocol {
    public static func handle(message: [String: Any], store: ArchiveStore) -> [String: Any] {
        let type = message["type"] as? String ?? ""
        let id = message["id"] as? Int
        func wrap(_ dict: [String: Any]) -> [String: Any] {
            var d = dict
            if let id { d["id"] = id }
            return d
        }
        do {
            switch type {
            case "ping":
                return wrap(["ok": true, "version": "1.0", "root": store.root.path, "app": "Arena Archive"])
            case "set_root":
                guard let path = message["path"] as? String else {
                    return wrap(["ok": false, "error": "missing path"])
                }
                try store.setRoot(path)
                return wrap(["ok": true, "root": store.root.path])
            case "resolve":
                let key = message["key"] as? String ?? ""
                if let e = store.resolve(key) {
                    return wrap(["ok": true, "exists": true, "rel": e.rel, "subtype": e.subtype as Any])
                }
                return wrap(["ok": true, "exists": false])
            case "sync_meta":
                let chat = message["chat"] as? [String: Any] ?? [:]
                let files = message["files"] as? [[String: Any]] ?? []
                let result = try store.sync(chat: chat, files: files)
                return wrap(["ok": true, "rel": result.rel, "written": result.written])
            case "write_chunk":
                let key = message["key"] as? String ?? ""
                let path = message["path"] as? String ?? ""
                let content = (message["data_utf8"] as? String) ?? (message["content"] as? String) ?? ""
                try store.writeChunk(key: key, path: path, content: content)
                return wrap(["ok": true, "path": path])
            default:
                return wrap(["ok": false, "error": "unknown type \(type)"])
            }
        } catch {
            return wrap(["ok": false, "error": error.localizedDescription])
        }
    }
}
