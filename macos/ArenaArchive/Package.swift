// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ArenaArchive",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ArchiveKit", targets: ["ArchiveKit"]),
        .executable(name: "ArenaArchive", targets: ["ArenaArchiveApp"]),
        .executable(name: "ArenaArchiveHost", targets: ["ArenaArchiveHost"]),
        .executable(name: "ArchiveKitProbe", targets: ["ArchiveKitProbe"])
    ],
    targets: [
        .target(name: "ArchiveKit"),
        .target(name: "NativeHostCore", dependencies: ["ArchiveKit"]),
        .executableTarget(name: "ArenaArchiveApp", dependencies: ["ArchiveKit"]),
        .executableTarget(name: "ArenaArchiveHost", dependencies: ["NativeHostCore"], path: "Sources/NativeHost"),
        .executableTarget(name: "ArchiveKitProbe", dependencies: ["ArchiveKit"]),
        .testTarget(name: "ArchiveKitTests", dependencies: ["ArchiveKit"]),
        .testTarget(name: "NativeHostCoreTests", dependencies: ["NativeHostCore", "ArchiveKit"])
    ]
)
