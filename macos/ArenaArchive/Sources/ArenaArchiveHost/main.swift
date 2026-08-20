import Foundation
import ArchiveKit

/* `read(upToCount:)` is only contracted to return *up to* `count` bytes. Today
 * Darwin's Foundation happens to loop internally, so a 600 KB message dripped
 * in 8 KB slices still arrives whole — but nothing guarantees that, and a short
 * read here would silently drop the message and kill the host loop. Loop
 * explicitly; nil means the peer closed the pipe (or errored) early. */
func readExact(_ handle: FileHandle, count: Int) -> Data? {
    if count <= 0 { return Data() }
    var buf = Data()
    buf.reserveCapacity(count)
    while buf.count < count {
        let remaining = count - buf.count
        let chunk: Data?
        if #available(macOS 10.15.4, *) {
            chunk = try? handle.read(upToCount: remaining)
        } else {
            chunk = handle.readData(ofLength: remaining)
        }
        guard let chunk, !chunk.isEmpty else { return nil }
        buf.append(chunk)
    }
    return buf
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
