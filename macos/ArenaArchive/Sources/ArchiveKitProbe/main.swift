import Foundation
import ArchiveKit

var failed = 0
func check(_ name: String, _ cond: Bool) {
    if cond { print("  ok \(name)") }
    else { print("  FAIL \(name)"); failed += 1 }
}

let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
let store = ArchiveStore(root: dir)

do {
    _ = try store.safeRelpath("../etc/passwd")
    check("reject ..", false)
} catch {
    check("reject ..", true)
}
do {
    _ = try store.safeRelpath("/tmp/x")
    check("reject absolute", false)
} catch {
    check("reject absolute", true)
}

let chat1: [String: Any] = [
    "key": "c:abc",
    "mode": "battle",
    "subtype": "text",
    "title": "hello world",
    "models": [],
    "models_pending": true
]
let first = try store.sync(chat: chat1, files: [["path": "conversation.md", "content": "# hi"]])
check("first rel is battle/text", first.rel.contains("battle/text/"))
var chat2 = chat1
chat2["subtype"] = "code"
let second = try store.sync(chat: chat2, files: [["path": "conversation.md", "content": "# still"]])
check("subtype locked", first.rel == second.rel && store.resolve("c:abc")?.subtype == "text")

let slug = ArchiveStore.slug(title: "Liquid glass LLM dashboard", key: "c:01a01b66-19b7")
check("slug words", slug.contains("liquid-glass") && slug.contains("01a01b66"))

let ping = NativeProtocol.handle(message: ["type": "ping", "id": 1], store: store)
check("ping ok", ping["ok"] as? Bool == true)

if failed > 0 { FileHandle.standardError.write(Data("\(failed) failed\n".utf8)); exit(1) }
print("all ArchiveKitProbe checks passed")
