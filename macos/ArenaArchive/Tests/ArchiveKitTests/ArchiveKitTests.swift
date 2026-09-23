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

    func testDirectAndSideBySideLayouts() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ArchiveStore(root: dir)
        let direct: [String: Any] = ["key": "c:direct-123", "mode": "direct", "subtype": "text", "title": "Direct", "models": [], "models_pending": false]
        let directResult = try store.sync(chat: direct, files: [["path": "conversation.md", "content": "# direct"]])
        XCTAssertTrue(directResult.rel.hasPrefix("direct/text/"))
        let side: [String: Any] = ["key": "c:side-123", "mode": "side-by-side", "subtype": "code", "title": "Side", "models": [], "models_pending": false]
        let sideResult = try store.sync(chat: side, files: [["path": "conversation.md", "content": "# side"]])
        XCTAssertTrue(sideResult.rel.hasPrefix("side-by-side/code/"))
    }

    func testEncodedFileAndFullSlug() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = ArchiveStore(root: dir)
        let chat: [String: Any] = ["key": "c:01a01b66-19b7", "mode": "agent", "title": "Full id", "models": [], "models_pending": false]
        let result = try store.sync(chat: chat, files: [["path": "files/blob.bin", "encoding": "base64", "content": "aGVsbG8="]])
        XCTAssertTrue(result.rel.contains("01a01b66-19b7"))
        let data = try Data(contentsOf: store.safeRelpath(result.rel + "/files/blob.bin"))
        XCTAssertEqual(String(data: data, encoding: .utf8), "hello")
    }
}
