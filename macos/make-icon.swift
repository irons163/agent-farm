// Builds the app icon (1024×1024 PNG) from the Blender renders in web/assets:
// the day island with its buildings and windmill on a rounded sky tile.
//   swift macos/make-icon.swift web/assets out.png
import AppKit
import ImageIO

let args = CommandLine.arguments
let assets = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2])

func load(_ rel: String) -> CGImage {
    let src = CGImageSourceCreateWithURL(assets.appendingPathComponent(rel) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(src, 0, nil)!
}
func ctx(_ w: Int, _ h: Int) -> CGContext {
    CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
              space: CGColorSpace(name: CGColorSpace.sRGB)!,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

// 1. the scene at full size: background, then occluders (houses, trees…), the windmill, crops and
//    a few animals, depth-sorted the same way the web page does it
let scene = try! JSONSerialization.jsonObject(with: Data(contentsOf: assets.appendingPathComponent("scene.json"))) as! [String: Any]
let size = scene["size"] as! [Int]
let (W, H) = (size[0], size[1])
let s = ctx(W, H)
func draw(_ img: CGImage, _ x: Double, _ y: Double, _ w: Double, _ h: Double) {
    s.draw(img, in: CGRect(x: x, y: Double(H) - y - h, width: w, height: h))  // scene coords are top-left
}
let proj = scene["proj"] as! [[Double]]
func P(_ p: [Double]) -> (Double, Double) {
    (proj[0][0] * p[0] + proj[0][1] * p[1] + proj[0][3], proj[1][0] * p[0] + proj[1][1] * p[1] + proj[1][3])
}
let num = { (v: Any?) in (v as! NSNumber).doubleValue }
draw(load((scene["bg"] as! [String: String])["day"]!), 0, 0, Double(W), Double(H))
var items: [(z: Double, src: String, x: Double, y: Double, w: Double, h: Double)] = []
for o in scene["occluders"] as! [[String: Any]] {
    items.append((num(o["sort"]), (o["src"] as! [String: String])["day"]!, num(o["x"]), num(o["y"]), num(o["w"]), num(o["h"])))
}
let bl = scene["blades"] as! [String: Any]
items.append((num(bl["sort"] ?? 700), ((bl["frames"] as! [String: [String]])["day"]!)[2],
              num(bl["x"]), num(bl["y"]), num(bl["w"]), num(bl["h"])))
func sprite(_ meta: [String: Any], _ src: String, at world: [Double]) {
    let (px, py) = P(world)
    items.append((py, src, px - num(meta["ax"]), py - num(meta["ay"]), num(meta["w"]), num(meta["h"])))
}
let zones = scene["zones"] as! [String: Any]
let crops = scene["crops"] as! [String: [String: Any]]
let stages = [3, 3, 2, 3, 3, 2, 1, 3, 3, 2, 2, 3]  // a farm that's been busy
for plot in zones["plots"] as! [[String: Any]] {
    let i = (plot["id"] as! NSNumber).intValue, meta = crops[plot["crop"] as! String]!
    sprite(meta, (meta["stages"] as! [String: String])[String(stages[i])]!, at: (plot["center"] as! [NSNumber]).map(\.doubleValue))
}
let animals = scene["animals"] as! [String: [String: Any]]
let plots = zones["plots"] as! [[String: Any]]
for (name, frame, spot) in [("fox", "se_work0", (plots[4]["station"] as! [NSNumber]).map(\.doubleValue)),
                            ("cow", "se_idle", ((zones["barnyard"] as! [[NSNumber]])[1]).map(\.doubleValue)),
                            ("sheep", "se_idle", (zones["meadow_center"] as! [NSNumber]).map(\.doubleValue))] {
    let meta = animals[name]!
    sprite(meta, (meta["frames"] as! [String: String])[frame]!, at: spot)
}
for it in items.sorted(by: { $0.z < $1.z }) { draw(load(it.src), it.x, it.y, it.w, it.h) }
let full = s.makeImage()!

// 2. crop to what's drawn (alpha bounding box)
let px = s.data!.bindMemory(to: UInt8.self, capacity: s.bytesPerRow * H)
var (minX, minY, maxX, maxY) = (W, H, 0, 0)
for y in 0..<H {
    let row = px + y * s.bytesPerRow
    for x in 0..<W where row[x * 4 + 3] > 24 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
}
// bitmap rows are top-down in memory, so (minY…maxY) are already top-left coordinates
let island = full.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))!

// 3. rounded tile (macOS icon grid: 824 pt tile inside 1024) with the day sky
let N = 1024
let c = ctx(N, N)
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let path = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
c.saveGState()
c.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: CGColor(gray: 0, alpha: 0.28))
c.addPath(path)
c.setFillColor(CGColor(srgbRed: 0.49, green: 0.77, blue: 0.93, alpha: 1))
c.fillPath()
c.restoreGState()
c.saveGState()
c.addPath(path)
c.clip()
let hex = { (v: UInt32) in CGColor(srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255,
                                   blue: CGFloat(v & 255) / 255, alpha: 1) }
let sky = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                     colors: [hex(0x7cc4ee), hex(0xa9dcf6), hex(0xd8f0fb), hex(0xf4f6e6)] as CFArray,
                     locations: [0, 0.38, 0.68, 1])!
c.drawLinearGradient(sky, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])
// a couple of soft clouds (one transparency layer, so overlapping puffs don't show seams)
c.saveGState()
c.setAlpha(0.8)
c.beginTransparencyLayer(auxiliaryInfo: nil)
c.setFillColor(CGColor(gray: 1, alpha: 1))
for (x, y, r) in [(250.0, 800.0, 38.0), (292, 812, 50), (338, 798, 36), (690, 760, 30), (724, 770, 40), (760, 758, 28)] {
    c.fillEllipse(in: CGRect(x: x - r, y: y - r * 0.8, width: r * 2, height: r * 1.6))
}
c.endTransparencyLayer()
c.restoreGState()
// the island, as large as fits with a little margin
let iw = Double(island.width), ih = Double(island.height)
let k = min(780 / iw, 600 / ih)
let dw = iw * k, dh = ih * k
c.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: CGColor(srgbRed: 0.1, green: 0.2, blue: 0.3, alpha: 0.25))
c.interpolationQuality = .high
c.draw(island, in: CGRect(x: 512 - dw / 2, y: 470 - dh / 2, width: dw, height: dh))
c.restoreGState()

let dest = CGImageDestinationCreateWithURL(out as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(dest, c.makeImage()!, nil)
CGImageDestinationFinalize(dest)
print("icon", out.path, "island", island.width, "x", island.height)
