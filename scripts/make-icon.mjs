/**
 * Erzeugt das App-Icon (build/icon.ico + build/icon.png) rein in Node – ohne
 * externe Bildwerkzeuge. Motiv: Rechnungsblatt mit Eselsohr und grünem Häkchen
 * auf markenblauem Grund (passend zur UI-Akzentfarbe #2563eb).
 *
 * Aufruf:  node scripts/make-icon.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const SS = 4; // Supersampling für Kantenglättung

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;

function inRounded(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const nx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
  const ny = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
  const dx = px - nx;
  const dy = py - ny;
  return dx * dx + dy * dy <= r * r;
}

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy), 0, 1);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Farbe (RGBA, jeweils 0/255-Deckung) an einem Punkt im 256er-Koordinatenraum. */
function colorAt(fx, fy) {
  let c = [0, 0, 0, 0];

  if (!inRounded(fx, fy, 12, 12, 232, 232, 52)) return c;
  const t = clamp((fx - 12 + (fy - 12)) / 464, 0, 1);
  c = [lerp(37, 29, t), lerp(99, 78, t), lerp(235, 216, t), 255];

  const dl = 74,
    dt = 54,
    dw = 108,
    dh = 150,
    dr = 14,
    fold = 34;
  if (inRounded(fx, fy, dl, dt, dw, dh, dr)) {
    const u = fx - (dl + dw - fold);
    const v = fy - dt;
    const inFold = fx > dl + dw - fold && fy < dt + fold;
    if (inFold && u + v > fold) {
      // abgeschnittene Ecke -> Hintergrund (blau) bleibt
    } else if (inFold) {
      c = [226, 232, 240, 255]; // umgeklappter Flap
    } else {
      c = [255, 255, 255, 255];
    }
  }

  if (c[0] === 255 && c[1] === 255 && c[2] === 255) {
    const lines = [
      [90, 166, 96, [148, 163, 184]],
      [90, 166, 120, [203, 213, 225]],
      [90, 166, 144, [203, 213, 225]],
      [90, 140, 168, [203, 213, 225]],
    ];
    for (const [x1, x2, y, col] of lines) {
      if (fx >= x1 && fx <= x2 && fy >= y && fy <= y + 9) c = [...col, 255];
    }
  }

  const bx = 172,
    by = 184,
    br = 27;
  if ((fx - bx) ** 2 + (fy - by) ** 2 <= br * br) {
    c = [22, 163, 74, 255];
    const segs = [
      [160, 184, 169, 193],
      [169, 193, 186, 170],
    ];
    let d = 1e9;
    for (const s of segs) d = Math.min(d, distSeg(fx, fy, s[0], s[1], s[2], s[3]));
    if (d <= 4.2) c = [255, 255, 255, 255];
  }

  return c;
}

function renderRGBA() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const c = colorAt(fx, fy);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = SS * SS;
      const o = (y * SIZE + x) * 4;
      buf[o] = a ? Math.round(r / a) : 0;
      buf[o + 1] = a ? Math.round(g / a) : 0;
      buf[o + 2] = a ? Math.round(b / a) : 0;
      buf[o + 3] = Math.round(a / n);
    }
  }
  return buf;
}

// --- PNG-Encoder (RGBA, 8 bit) ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // Filter: None
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // Typ: Icon
  header.writeUInt16LE(1, 4); // Anzahl Bilder
  const entry = Buffer.alloc(16);
  entry[0] = 0; // Breite 256 -> 0
  entry[1] = 0; // Höhe 256 -> 0
  entry[2] = 0; // Farben
  entry[4] = 1; // Ebenen
  entry.writeUInt16LE(32, 6); // Bit pro Pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // Offset
  return Buffer.concat([header, entry, png]);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build");
mkdirSync(outDir, { recursive: true });
const rgba = renderRGBA();
const png = encodePng(rgba);
writeFileSync(path.join(outDir, "icon.png"), png);
writeFileSync(path.join(outDir, "icon.ico"), encodeIco(png));
console.log("Icon geschrieben:", path.relative(root, path.join(outDir, "icon.ico")), `(${png.length} B PNG)`);
