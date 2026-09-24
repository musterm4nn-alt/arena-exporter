import Foundation
import ArchiveKit

/// Protocol-independent implementation of the Arena Archive native messaging
/// host. The executable in NativeHost only owns stdio framing; all validation
/// and archive writes live here so they can be tested without a browser.
public struct NativeHostCore {
    public static let appName = "ArenaArchive"
    public static let version = "2.2.0"
    public static let maxFilesPerWrite = 80
    public static let maxFileBytes = 32 * 1024 * 1024

    public let store: ArchiveStore

    public init(store: ArchiveStore = ArchiveStore()) {
        self.store = store
    }

    public func handle(_ request: [String: Any]) -> [String: Any] {
        guard let id = request["id"] as? String, !id.isEmpty else {
            return failure(id: "unknown", error: "missing request id")
        }
        switch request["op"] as? String {
        case "hello":
            return hello(id: id)
        case "write":
            return write(id: id, files: request["files"] as? [[String: Any]] ?? [])
        default:
            return failure(id: id, error: "unsupported operation")
        }
    }

    private func hello(id: String) -> [String: Any] {
        do {
            try store.ensureRoot()
            return [
                "id": id,
                "op": "hello",
                "ok": true,
                "app": Self.appName,
                "version": Self.version,
                "root": store.root.path
            ]
        } catch {
            return failure(id: id, error: "archive root unavailable")
        }
    }

    private func write(id: String, files: [[String: Any]]) -> [String: Any] {
        guard !files.isEmpty else {
            return failure(id: id, error: "write contains no files")
        }
        guard files.count <= Self.maxFilesPerWrite else {
            return failure(id: id, error: "write contains too many files")
        }

        var written: [String] = []
        var failed: [[String: String]] = []
        for file in files {
            guard let path = file["rel"] as? String, !path.isEmpty else {
                failed.append(["path": "", "error": "missing file path"])
                continue
            }
            guard let content = file["content"] as? String else {
                failed.append(["path": path, "error": "missing file content"])
                continue
            }
            let encoding = file["encoding"] as? String ?? "utf8"
            do {
                try validateSize(content: content, encoding: encoding)
                if encoding == "dataurl" {
                    try writeDataURL(path: path, value: content, written: &written)
                } else {
                    try store.writeEncodedFile(rel: path, content: content, encoding: encoding)
                    written.append(path)
                }
            } catch {
                failed.append(["path": path, "error": String(describing: error).prefix(240).description])
            }
        }

        var response: [String: Any] = [
            "id": id,
            "op": "write",
            "ok": failed.isEmpty,
            "written": written,
            "root": store.root.path
        ]
        if !failed.isEmpty { response["failed"] = failed }
        return response
    }

    private func validateSize(content: String, encoding: String) throws {
        var body = content
        var base64 = encoding == "base64"
        if encoding == "dataurl", let comma = content.firstIndex(of: ",") {
            body = String(content[content.index(after: comma)...])
            base64 = content[..<comma].lowercased().contains(";base64")
        }
        let bytes = base64 ? (body.count * 3 + 3) / 4 : body.utf8.count
        guard bytes <= Self.maxFileBytes else {
            throw NSError(domain: "ArenaArchiveHost", code: 11, userInfo: [NSLocalizedDescriptionKey: "file exceeds 32 MiB"])
        }
    }

    private func writeDataURL(path: String, value: String, written: inout [String]) throws {
        guard let comma = value.firstIndex(of: ",") else {
            throw NSError(domain: "ArenaArchiveHost", code: 10, userInfo: [NSLocalizedDescriptionKey: "invalid data URL"])
        }
        let metadata = String(value[..<comma]).lowercased()
        let body = String(value[value.index(after: comma)...])
        if metadata.contains(";base64") {
            try store.writeEncodedFile(rel: path, content: body, encoding: "base64")
        } else {
            let decoded = body.removingPercentEncoding ?? body
            try store.writeEncodedFile(rel: path, content: decoded, encoding: "utf8")
        }
        written.append(path)
    }

    private func failure(id: String, error: String) -> [String: Any] {
        ["id": id, "op": "error", "ok": false, "error": error]
    }
}

public enum NativeHostFrame {
    public static let maxBytes = 128 * 1024 * 1024

    public static func decodeLength(_ header: Data) -> Int? {
        guard header.count == 4 else { return nil }
        let length = UInt32(header[header.startIndex])
            | (UInt32(header[header.startIndex + 1]) << 8)
            | (UInt32(header[header.startIndex + 2]) << 16)
            | (UInt32(header[header.startIndex + 3]) << 24)
        guard length > 0, length <= UInt32(maxBytes) else { return nil }
        return Int(length)
    }

    public static func encode(_ payload: Data) -> Data? {
        guard !payload.isEmpty, payload.count <= maxBytes else { return nil }
        let length = UInt32(payload.count)
        var frame = Data(capacity: 4 + payload.count)
        frame.append(UInt8(length & 0xff))
        frame.append(UInt8((length >> 8) & 0xff))
        frame.append(UInt8((length >> 16) & 0xff))
        frame.append(UInt8((length >> 24) & 0xff))
        frame.append(payload)
        return frame
    }
}