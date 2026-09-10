// What a file actually IS, rather than what it claims to be.
//
// KevCal used to name stored uploads using the extension from the client's
// filename, then serve them back from its own origin with a content-type
// derived from that same extension. Uploading "x.html" therefore got you HTML
// executing on the app's origin — able to read every letter you had imported.
//
// The filename is now ignored entirely. A file is identified by its leading
// bytes, stored under the extension those bytes imply, and served as the type
// those bytes imply. Anything unrecognised never reaches disk.

const TYPES = [
  { ext: '.png',  mime: 'image/png',  test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.jpg',  mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif',  mime: 'image/gif',  test: (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  { ext: '.pdf',  mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    ext: '.webp', mime: 'image/webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    // iPhone photos. The brand sits at bytes 8-12 of the ISO-BMFF box header.
    ext: '.heic', mime: 'image/heic',
    test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp'
      && ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'mif1', 'msf1']
        .includes(b.subarray(8, 12).toString('latin1')),
  },
];

/**
 * @param {Buffer} buf
 * @returns {{ext:string, mime:string}|null} null means "not a document KevCal reads"
 */
export function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  for (const t of TYPES) {
    try { if (t.test(buf)) return { ext: t.ext, mime: t.mime }; } catch { /* next */ }
  }
  return null;
}

/** The same question, answered from the first bytes of a file already on disk. */
export function sniffFile(fs, filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    return sniffType(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

export const ACCEPTED = TYPES.map((t) => t.ext).join(', ');
