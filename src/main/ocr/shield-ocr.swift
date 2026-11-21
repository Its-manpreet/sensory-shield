// OWNER: Agent A. On-device text recognition helper (macOS Vision framework). Built by `npm run content:setup`
// into vendor/ocr/shield-ocr. Spawned by src/main/ocr.js; never touches the network or the disk.
//
// stdin, repeated:  u32 LE width, u32 LE height, u32 LE id, then width*height bytes of 8-bit grayscale
// stdout, one JSON line per frame:
//   {"id":1,"ms":42.1,"lines":[{"t":"text","x":0.1,"y":0.2,"w":0.3,"h":0.02,"c":0.98}]}
// Boxes are normalized 0..1 with the origin at the TOP-left (Vision uses bottom-left; converted here).
// argv[1]: "fast" | "accurate" (default accurate)
import Foundation
import Vision
import CoreGraphics

setvbuf(stdout, nil, _IOFBF, 1 << 16)
let level: VNRequestTextRecognitionLevel = CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "fast" ? .fast : .accurate
let input = FileHandle.standardInput

func readExactly(_ n: Int) -> Data? {
  var buf = Data(capacity: n)
  while buf.count < n {
    let chunk = input.readData(ofLength: n - buf.count)
    if chunk.isEmpty { return nil }
    buf.append(chunk)
  }
  return buf
}

func u32(_ d: Data, _ at: Int) -> Int {
  return Int(d[at]) | Int(d[at + 1]) << 8 | Int(d[at + 2]) << 16 | Int(d[at + 3]) << 24
}

func esc(_ s: String) -> String {
  var out = ""
  for ch in s.unicodeScalars {
    switch ch {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n", "\r", "\t": out += " "
    default:
      if ch.value < 0x20 { out += " " } else { out.unicodeScalars.append(ch) }
    }
  }
  return out
}

while true {
  guard let header = readExactly(12) else { break }
  let w = u32(header, 0), h = u32(header, 4), id = u32(header, 8)
  guard w > 0, h > 0, w * h < 64_000_000, let pixels = readExactly(w * h) else { break }
  let t0 = DispatchTime.now()
  var lines: [String] = []
  if let provider = CGDataProvider(data: pixels as CFData),
     let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w,
                         space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                         provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = level
    req.usesLanguageCorrection = level == .accurate
    req.minimumTextHeight = 0
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([req])
    for obs in req.results ?? [] {
      guard let top = obs.topCandidates(1).first else { continue }
      let b = obs.boundingBox
      lines.append(String(format: "{\"t\":\"%@\",\"x\":%.5f,\"y\":%.5f,\"w\":%.5f,\"h\":%.5f,\"c\":%.3f}",
                          esc(top.string), b.minX, 1 - b.maxY, b.width, b.height, top.confidence))
    }
  }
  let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
  print("{\"id\":\(id),\"ms\":\(String(format: "%.1f", ms)),\"lines\":[\(lines.joined(separator: ","))]}")
  fflush(stdout)
}
