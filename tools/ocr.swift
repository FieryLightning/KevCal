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

// MARK: - PDF text layer

/// A PDF that carries real text should never be OCR'd — OCR of a rendered page
/// introduces errors (2027 -> 2021) that the embedded text does not have.
///
/// Text comes from `page.string`, which is exact. Geometry comes from clustering
/// character bounds. The two indexings drift (PDFKit's string contains newline
/// characters that `numberOfCharacters` does not count), so they are only zipped
/// together when the counts agree; otherwise the text is kept and the boxes fall
/// back to evenly spaced bands. Correct text matters more than a perfect box.
func textLayerLines(_ page: PDFPage) -> [Line]? {
    guard let whole = page.string,
          whole.trimmingCharacters(in: .whitespacesAndNewlines).count > 20 else { return nil }

    let textLines = whole
        .components(separatedBy: CharacterSet.newlines)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    guard textLines.count >= 2 else { return nil }

    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }

    var clusters: [CGRect] = []
    for i in 0..<page.numberOfCharacters {
        let b = page.characterBounds(at: i)
        if b.isNull || b.isInfinite || b.height <= 0 || b.width <= 0 { continue }
        if let last = clusters.last,
           abs(last.midY - b.midY) <= max(last.height, b.height) * 0.6 {
            clusters[clusters.count - 1] = last.union(b)
        } else {
            clusters.append(b)
        }
    }
    clusters.sort { $0.midY > $1.midY }

    let aligned = clusters.count == textLines.count
    var lines: [Line] = []
    for (idx, t) in textLines.enumerated() {
        var bbox: [Double]
        if aligned {
            let r = clusters[idx]
            bbox = [
                Double((r.minX - bounds.minX) / bounds.width),
                Double(1.0 - ((r.maxY - bounds.minY) / bounds.height)),
                Double(r.width / bounds.width),
                Double(r.height / bounds.height),
            ]
        } else {
            let n = Double(textLines.count)
            bbox = [0.05, Double(idx) / n, 0.90, 1.0 / n]
        }
        lines.append(Line(text: t, confidence: 1.0, bbox: bbox))
    }
    return lines
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

var pages: [Page] = []
var engineUsed = "vision"

let pageLimit = 40

if isPDF {
    guard let doc = PDFDocument(url: url) else { fail("could not open the PDF") }
    if doc.pageCount == 0 { fail("the PDF has no pages") }
    var usedTextLayer = false
    for i in 0..<min(doc.pageCount, pageLimit) {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        if let lines = textLayerLines(page), lines.count >= 2 {
            usedTextLayer = true
            pages.append(Page(page: i + 1, width: Int(bounds.width), height: Int(bounds.height), lines: lines))
        } else {
            // Scanned page with no text layer: fall back to OCR.
            let rendered = imagesFromPDF(url, scale: 2.0)
            if i < rendered.count {
                let img = rendered[i]
                pages.append(Page(page: i + 1, width: img.width, height: img.height,
                                  lines: recognise(img, fast: fast, languages: languages)))
            }
        }
    }
    engineUsed = usedTextLayer ? "pdf-text" : "vision"
    if pages.isEmpty { fail("could not read any page of the PDF") }
} else {
    guard let img = imageFromFile(url) else { fail("could not decode image") }
    pages.append(Page(page: 1, width: img.width, height: img.height,
                      lines: recognise(img, fast: fast, languages: languages)))
}

let out = Output(ok: true, engine: engineUsed, pages: pages, error: nil)
let encoder = JSONEncoder()
if let data = try? encoder.encode(out), let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    fail("could not encode result")
}
