import Foundation
import ArchiveKit

func readExact(_ handle: FileHandle, count: Int) -> Data? {
    if count <= 0 { return Data() }
    if #available(macOS 10.15.4, *) {
        return try? handle.read(upToCount: count)
    }
    return handle.readData(ofLength: count)
}

let store = ArchiveStore()
let stdin = FileHandle.standardInput
let stdout = FileHandle.standardOutput

while true {
    guard let lenBytes = readExact(stdin, count: 4), lenBytes.count == 4 else { break }
    let length = lenBytes.withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
    if length == 0 || length > 1_000_000 { break }
    guard let payload = readExact(stdin, count: Int(length)), payload.count == Int(length) else { break }
    let obj = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
    let response = NativeProtocol.handle(message: obj, store: store)
    guard let out = try? JSONSerialization.data(withJSONObject: response) else { continue }
    var outLen = UInt32(out.count).littleEndian
    let header = Data(bytes: &outLen, count: 4)
    stdout.write(header)
    stdout.write(out)
}
