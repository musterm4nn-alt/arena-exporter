// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ArenaArchive",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ArchiveKit", targets: ["ArchiveKit"]),
        .executable(name: "ArenaArchive", targets: ["ArenaArchiveApp"])
    ],
    targets: [
        .target(name: "ArchiveKit"),
        .executableTarget(name: "ArenaArchiveApp", dependencies: ["ArchiveKit"]),
        .executableTarget(name: "ArchiveKitProbe", dependencies: ["ArchiveKit"]),
        .testTarget(name: "ArchiveKitTests", dependencies: ["ArchiveKit"])
    ]
)
