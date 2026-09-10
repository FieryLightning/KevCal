// Minimal .env loader. KevCal now needs one secret (the Gemini key) and the
// friendliest place to put it is a file you can edit, not a shell profile you
// have to remember to export from.
//
// Deliberately tiny: KEY=value, # comments, optional quotes. Anything already
// in the real environment wins, so `GEMINI_API_KEY=... npm start` still works.

import fs from 'node:fs';

export function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}
