// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ArenaArchive",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ArchiveKit", targets: ["ArchiveKit"]),
        .executable(name: "arena-archive-host", targets: ["ArenaArchiveHost"]),
        .executable(name: "ArenaArchive", targets: ["ArenaArchiveApp"])
    ],
    targets: [
        .target(name: "ArchiveKit"),
        .executableTarget(name: "ArenaArchiveHost", dependencies: ["ArchiveKit"]),
        .executableTarget(name: "ArenaArchiveApp", dependencies: ["ArchiveKit"]),
        .executableTarget(name: "ArchiveKitProbe", dependencies: ["ArchiveKit"])
    ]
)
