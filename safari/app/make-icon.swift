// Renders the Sendfeather mark (favicon.svg) into a macOS-style padded app-icon master.
//
// The macOS icon grid places the artwork in a rounded-square body of ~824×824 centered
// on a 1024×1024 canvas; the Sendfeather favicon already uses a matching corner ratio
// (rx 42/180 ≈ 23%, Apple's squircle ≈ 22.5%), so it only needs the inset.
//
// Usage: xcrun swift make-icon.swift <input.svg> <output.png> [canvas] [body]
// Example (from the repo root):
//   xcrun swift safari/app/make-icon.swift /path/to/favicon.svg \
//     safari/app/AppIcon/master-1024.png
import AppKit

let args = CommandLine.arguments
guard args.count >= 3,
      let svg = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write(
        "usage: swift make-icon.swift <input.svg> <output.png> [canvas=1024] [body=824]\n"
            .data(using: .utf8)!)
    exit(1)
}
let canvas = args.count > 3 ? Int(args[3]) ?? 1024 : 1024
let body = args.count > 4 ? Int(args[4]) ?? 824 : 824
let inset = (canvas - body) / 2

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: canvas, pixelsHigh: canvas,
    bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0
) else {
    FileHandle.standardError.write("could not create bitmap\n".data(using: .utf8)!)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
let context = NSGraphicsContext(bitmapImageRep: rep)!
context.imageInterpolation = .high
NSGraphicsContext.current = context
svg.draw(in: NSRect(x: inset, y: inset, width: body, height: body))
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("could not encode png\n".data(using: .utf8)!)
    exit(1)
}
let outURL = URL(fileURLWithPath: args[2])
try! FileManager.default.createDirectory(
    at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try! png.write(to: outURL)
print("wrote \(outURL.path) — canvas \(canvas)x\(canvas), body \(body)x\(body)")
