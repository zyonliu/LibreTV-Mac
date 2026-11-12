// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "LibreTVMac", platforms: [.macOS(.v14)], products: [.executable(name: "LibreTVMac", targets: ["LibreTVMac"])], targets: [.executableTarget(name: "LibreTVMac", swiftSettings: [.swiftLanguageMode(.v5)]), .testTarget(name: "LibreTVMacTests", dependencies: ["LibreTVMac"], swiftSettings: [.swiftLanguageMode(.v5)])])
