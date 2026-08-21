import XCTest
@testable import ArchiveKit

final class ArchiveKitTests: XCTestCase {
    func testPathTraversalRejected() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let store = ArchiveStore(root: dir)
        XCTAssertThrowsError(try store.safeRelpath("../etc/passwd"))
        XCTAssertThrowsError(try store.safeRelpath("/tmp/x"))
        XCTAssertThrowsError(try store.safeRelpath("../\(dir.lastPathComponent)-evil/x"))
    }

    func testSubtypeLockedOnSecondSync() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ArchiveStore(root: dir)
        let chat1: [String: Any] = [
            "key": "c:abc",
            "mode": "battle",
            "subtype": "text",
            "title": "hello world",
            "models": [],
            "models_pending": true
        ]
        let first = try store.sync(chat: chat1, files: [
            ["path": "conversation.md", "content": "# hi"]
        ])
        XCTAssertTrue(first.rel.contains("battle/text/"))
        var chat2 = chat1
        chat2["subtype"] = "code"
        let second = try store.sync(chat: chat2, files: [
            ["path": "conversation.md", "content": "# still here"]
        ])
        XCTAssertEqual(first.rel, second.rel)
        XCTAssertEqual(store.resolve("c:abc")?.subtype, "text")
    }

    func testSlugStable() {
        let a = ArchiveStore.slug(title: "Liquid glass LLM dashboard", key: "c:01a01b66-19b7")
        XCTAssertTrue(a.contains("liquid-glass"))
        XCTAssertTrue(a.contains("01a01b66"))
    }
}
