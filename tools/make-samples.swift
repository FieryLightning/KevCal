// Generates fixture documents that mirror the artifacts described in user research,
// so extraction can be tested without needing real school letters or rotas.
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "samples"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func render(_ name: String, w: CGFloat, h: CGFloat, _ body: (CGFloat) -> Void) {
    let size = NSSize(width: w, height: h)
    let img = NSImage(size: size)
    img.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: size).fill()
    body(h)
    img.unlockFocus()
    guard let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return }
    let path = "\(outDir)/\(name)"
    try? png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

func text(_ s: String, _ x: CGFloat, _ yFromTop: CGFloat, _ h: CGFloat,
          size: CGFloat = 15, bold: Bool = false, colour: NSColor = .black) {
    let font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: colour]
    NSString(string: s).draw(at: NSPoint(x: x, y: h - yFromTop - size - 4), withAttributes: attrs)
}

func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ h: CGFloat) {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: x1, y: h - y1)); p.line(to: NSPoint(x: x2, y: h - y2))
    NSColor.darkGray.setStroke(); p.lineWidth = 1; p.stroke()
}

// 1. A school letter — the flagship v1 case.
render("school-letter.png", w: 1000, h: 1300) { h in
    text("OAKFIELD SECONDARY SCHOOL", 60, 50, h, size: 22, bold: true)
    text("Letter to parents and carers — Autumn Term", 60, 84, h, size: 15, colour: .darkGray)
    line(60, 118, 940, 118, h)
    text("Dear Parent/Carer,", 60, 150, h)
    text("Please make a note of the following dates for the coming term.", 60, 182, h)
    text("Key dates", 60, 236, h, size: 18, bold: true)
    text("Year 9 Parents' Evening — Thursday 12 March 2026, 4:30pm to 7:30pm", 80, 274, h)
    text("in the main hall. Please book a slot via the school website.", 96, 300, h, size: 13, colour: .darkGray)
    text("INSET Day (school closed to pupils) — Monday 2 February 2026", 80, 336, h)
    text("Year 11 Mock Exams begin — w/c 18 November 2025", 80, 372, h)
    text("Geography fieldwork trip to Epping Forest — Friday 5 June 2026", 80, 408, h)
    text("Coach departs 07:45 from the main gate, returns approximately 18:00.", 96, 434, h, size: 13, colour: .darkGray)
    text("Deadlines", 60, 492, h, size: 18, bold: true)
    text("Trip payment deadline: 20 May 2026", 80, 530, h, bold: true)
    text("The balance of £42.00 must be paid via ParentPay by this date.", 96, 556, h, size: 13, colour: .darkGray)
    text("Consent forms must be returned by Friday 15 May 2026.", 80, 592, h)
    text("Regular activities", 60, 650, h, size: 18, bold: true)
    text("Homework club runs every Tuesday from 3:15pm until 4:15pm in Room 12.", 80, 688, h)
    text("Half term: Monday 16 February 2026 to Friday 20 February 2026.", 80, 724, h)
    line(60, 790, 940, 790, h)
    text("Yours sincerely,", 60, 820, h)
    text("D. Whitfield, Head of Geography", 60, 848, h, size: 13, colour: .darkGray)
}

// 2. Term-week table — Maya's "Wk 7 (Fri)" problem needs an anchor to resolve.
render("term-dates.png", w: 900, h: 800) { h in
    text("BIOL2041 — Assessment Schedule", 50, 40, h, size: 20, bold: true)
    text("Term 1 Week 1 commences Monday 22 September 2025", 50, 76, h, size: 14, colour: .darkGray)
    line(50, 110, 850, 110, h)
    text("Assessment", 60, 130, h, size: 14, bold: true)
    text("Due", 500, 130, h, size: 14, bold: true)
    text("Weight", 700, 130, h, size: 14, bold: true)
    line(50, 156, 850, 156, h)
    let rows = [("Lab report 1", "Wk 4 (Fri)", "15%"),
                ("Critical appraisal", "Wk 7 (Fri)", "25%"),
                ("Lab report 2", "Wk 9 (Fri)", "15%"),
                ("Final exam", "Wk 12 (Wed)", "45%")]
    var y: CGFloat = 176
    for r in rows {
        text(r.0, 60, y, h); text(r.1, 500, y, h); text(r.2, 700, y, h)
        y += 34
    }
    line(50, y + 6, 850, y + 6, h)
    text("Submissions close at 23:59 on the date shown. Late work is capped at 40%.",
         60, y + 26, h, size: 13, colour: .darkGray)
    text("Reading week (no teaching): week commencing 3 November 2025.",
         60, y + 52, h, size: 13, colour: .darkGray)
}

// 3. A poster — Maya's corridor case: one date, must be 3 taps.
render("poster.png", w: 800, h: 1100) { h in
    NSColor(calibratedRed: 0.09, green: 0.11, blue: 0.20, alpha: 1).setFill()
    NSRect(x: 0, y: h - 300, width: 800, height: 300).fill()
    text("PRE-MED SOCIETY", 60, 90, h, size: 34, bold: true, colour: .white)
    text("Careers in Clinical Research", 60, 150, h, size: 24, colour: .white)
    text("An evening talk with Dr Amara Osei", 60, 200, h, size: 16, colour: .lightGray)
    text("Wednesday 15 October 2025", 60, 360, h, size: 26, bold: true)
    text("6:30pm — 8:00pm", 60, 410, h, size: 22)
    text("Lecture Theatre B, Medical Sciences Building", 60, 470, h, size: 17, colour: .darkGray)
    text("Free entry. Pizza provided.", 60, 520, h, size: 17, colour: .darkGray)
    text("RSVP by 10 October", 60, 600, h, size: 18, bold: true)
}

// 4. Car service reminder — Kevin named this case explicitly.
render("car-reminder.png", w: 900, h: 700) { h in
    text("KWIK SERVICE CENTRE", 50, 44, h, size: 20, bold: true)
    text("Service Record & Reminder", 50, 78, h, size: 14, colour: .darkGray)
    line(50, 112, 850, 112, h)
    text("Vehicle:  KX21 PLZ — Volkswagen Golf 1.5 TSI", 50, 140, h)
    text("Mileage:  48,204", 50, 172, h)
    text("Work completed:  Full service, brake fluid change", 50, 204, h)
    line(50, 248, 850, 248, h)
    text("MOT expires:  14 August 2026", 50, 280, h, size: 17, bold: true)
    text("Next service due:  12 February 2027 or 60,000 miles", 50, 318, h, size: 17, bold: true)
    text("Road tax due:  01 October 2026", 50, 356, h, size: 17, bold: true)
    text("Please book at least two weeks in advance.", 50, 404, h, size: 13, colour: .darkGray)
}
