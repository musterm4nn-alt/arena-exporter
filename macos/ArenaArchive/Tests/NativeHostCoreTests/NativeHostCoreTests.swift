import XCTest
@testable import NativeHostCore
@testable import ArchiveKit

final class NativeHostCoreTests: XCTestCase {
    private func store() -> ArchiveStore {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return ArchiveStore(root: dir)
    }

    func testHelloAndWrite() throws {
        let core = NativeHostCore(store: store())
        let hello = core.handle(["id": "h1", "op": "hello"])
        XCTAssertEqual(hello["ok"] as? Bool, true)
        XCTAssertNotNil(hello["root"] as? String)

        let write = core.handle([
            "id": "w1", "op": "write",
            "files": [["rel": "conversation.json", "encoding": "utf8", "content": "{}"]]
        ])
        XCTAssertEqual(write["ok"] as? Bool, true)
        XCTAssertEqual((write["written"] as? [String])?.first, "conversation.json")
        let path = try core.store.safeRelpath("conversation.json")
        XCTAssertEqual(try String(contentsOf: path, encoding: .utf8), "{}")
    }

    func testRejectsTraversalAndUnknownOperation() {
        let core = NativeHostCore(store: store())
        let escaped = core.handle([
            "id": "bad", "op": "write",
            "files": [["rel": "../outside.txt", "encoding": "utf8", "content": "no"]]
        ])
        XCTAssertEqual(escaped["ok"] as? Bool, false)
        let unknown = core.handle(["id": "x", "op": "getRoot"])
        XCTAssertEqual(unknown["ok"] as? Bool, false)
    }

    func testDataURL() throws {
        let core = NativeHostCore(store: store())
        let result = core.handle([
            "id": "data", "op": "write",
            "files": [["rel": "hello.txt", "encoding": "dataurl", "content": "data:text/plain;base64,aGVsbG8="]]
        ])
        XCTAssertEqual(result["ok"] as? Bool, true)
        let data = try Data(contentsOf: core.store.safeRelpath("hello.txt"))
        XCTAssertEqual(String(data: data, encoding: .utf8), "hello")
    }

    func testNativeMessagingFrameIsLittleEndian() throws {
        let payload = Data("hello".utf8)
        let frame = try XCTUnwrap(NativeHostFrame.encode(payload))
        XCTAssertEqual(Array(frame.prefix(4)), [5, 0, 0, 0])
        XCTAssertEqual(NativeHostFrame.decodeLength(Data(frame.prefix(4))), payload.count)
        XCTAssertEqual(Data(frame.dropFirst(4)), payload)
    }
}
