// kevcal-ocr — on-device OCR via Apple's Vision framework.
//
// Why this exists: every professional persona in the research refused to trust an
// import they could not check against the source, and two of them (pupil names,
// colleagues' names) could not send the document to a cloud service at all.
// Vision runs locally, costs nothing, needs no API key, and returns bounding
// boxes — which is exactly what the review UI needs to show a source crop.
//
// Usage:  kevcal-ocr <path-to-image-or-pdf> [--fast] [--lang en-GB]
// Output: JSON on stdout — { ok, pages: [ { page, width, height, lines: [...] } ] }
//         bbox is [x, y, w, h] normalised 0..1 with a TOP-LEFT origin (web convention).

import Foundation
import Vision
import CoreGraphics
import ImageIO
import PDFKit
import AppKit

struct Line: Codable {
    let text: String
    let confidence: Double
    let bbox: [Double]
}
struct Page: Codable {
    let page: Int
    let width: Int
    let height: Int
    let lines: [Line]
}
struct Output: Codable {
    let ok: Bool
    let engine: String
    let pages: [Page]
    let error: String?
}

func fail(_ message: String) -> Never {
    let out = Output(ok: false, engine: "vision", pages: [], error: message)
    if let data = try? JSONEncoder().encode(out), let s = String(data: data, encoding: .utf8) {
        print(s)
    }
    exit(1)
}

// MARK: - Loading

func imagesFromPDF(_ url: URL, scale: CGFloat) -> [CGImage] {
    guard let doc = PDFDocument(url: url) else { return [] }
    var out: [CGImage] = []
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let w = Int(bounds.width * scale), h = Int(bounds.height * scale)
        guard w > 0, h > 0,
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { continue }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
        page.draw(with: .mediaBox, to: ctx)
        if let img = ctx.makeImage() { out.append(img) }
    }
    return out
}

func imageFromFile(_ url: URL) -> CGImage? {
    if let src = CGImageSourceCreateWithURL(url as CFURL, nil),
       CGImageSourceGetCount(src) > 0,
       let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
        return img
    }
    // HEIC / odd formats fall back through AppKit.
    guard let ns = NSImage(contentsOf: url) else { return nil }
    var rect = CGRect(x: 0, y: 0, width: ns.size.width, height: ns.size.height)
    return ns.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

// MARK: - Recognition

func recognise(_ image: CGImage, fast: Bool, languages: [String]) -> [Line] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = fast ? .fast : .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = languages
    // Rotas and promo grids use tiny type; let Vision consider small text.
    request.minimumTextHeight = 0.0

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return [] }

    guard let observations = request.results else { return [] }
    return observations.compactMap { obs -> Line? in
        guard let candidate = obs.topCandidates(1).first else { return nil }
        let b = obs.boundingBox            // normalised, BOTTOM-left origin
        let topLeftY = 1.0 - b.origin.y - b.size.height
        return Line(
            text: candidate.string,
            confidence: Double(candidate.confidence),
            bbox: [
                Double(b.origin.x), Double(topLeftY),
                Double(b.size.width), Double(b.size.height)
            ]
        )
    }
}

// MARK: - Main

var args = Array(CommandLine.arguments.dropFirst())
var fast = false
var languages = ["en-GB", "en-US"]
var path: String? = nil

var i = 0
while i < args.count {
    switch args[i] {
    case "--fast": fast = true
    case "--lang":
        if i + 1 < args.count { languages = [args[i + 1]]; i += 1 }
    default: path = args[i]
    }
    i += 1
}

guard let path, FileManager.default.fileExists(atPath: path) else {
    fail("file not found: \(path ?? "<none>")")
}

let url = URL(fileURLWithPath: path)
let isPDF = url.pathExtension.lowercased() == "pdf"

var images: [CGImage] = []
if isPDF {
    images = imagesFromPDF(url, scale: 2.0)
    if images.isEmpty { fail("could not render any page of the PDF") }
} else {
    guard let img = imageFromFile(url) else { fail("could not decode image") }
    images = [img]
}

// Guard against a 300-page PDF being dropped in by accident.
let pageLimit = 40
if images.count > pageLimit { images = Array(images.prefix(pageLimit)) }

var pages: [Page] = []
for (idx, img) in images.enumerated() {
    let lines = recognise(img, fast: fast, languages: languages)
    pages.append(Page(page: idx + 1, width: img.width, height: img.height, lines: lines))
}

let out = Output(ok: true, engine: "vision", pages: pages, error: nil)
let encoder = JSONEncoder()
if let data = try? encoder.encode(out), let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    fail("could not encode result")
}
