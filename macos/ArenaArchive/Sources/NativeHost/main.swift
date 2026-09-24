import Foundation
import NativeHostCore

private let input = FileHandle.standardInput
private let output = FileHandle.standardOutput

private func readExactly(_ count: Int) -> Data? {
    var result = Data()
    result.reserveCapacity(count)
    while result.count < count {
        let chunk = input.readData(ofLength: count - result.count)
        if chunk.isEmpty { return nil }
        result.append(chunk)
    }
    return result
}

private func readFrame() -> Data? {
    guard let header = readExactly(4), header.count == 4 else { return nil }
    guard let length = NativeHostFrame.decodeLength(header),
          let payload = readExactly(length), payload.count == length else { return nil }
    return payload
}

private func writeFrame(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let payload = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    if let frame = NativeHostFrame.encode(payload) { output.write(frame) }
}

let core = NativeHostCore()
while let frame = readFrame() {
    guard let object = try? JSONSerialization.jsonObject(with: frame),
          let request = object as? [String: Any] else {
        writeFrame(["id": "unknown", "op": "error", "ok": false, "error": "invalid JSON request"])
        continue
    }
    writeFrame(core.handle(request))
}
