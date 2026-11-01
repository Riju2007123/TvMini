/**
 * Legacy binary `.fla` (Flash 5 … CS4, an OLE compound file) -> the same
 * document model `fla-reader.js` builds for XFL packages, so `fla-import.js`
 * can paint it.
 *
 * What is decoded (checked against a real Flash file):
 *   - the compound-file streams (`Contents`, `Page 1`) via `readCfbStreams`;
 *   - the stage size, frame rate and background from `Contents`;
 *   - every `CPicShape` of the first scene: its matrix, fill colours and the
 *     whole edge stream (moves, quadratic curves, fill-style changes);
 *   - frame lengths and the layer name from the record tails.
 *
 * Edge stream, per edge:  type byte `t`
 *   t & 0x40  a style change follows: three style indices, u8 each when
 *             t & 0x80, else u16 (& 0x7fff) each. Order: line, left fill,
 *             right fill.
 *   bits 0-1, 2-3, 4-5 describe three coordinate pairs
 *             (move, control, anchor), each:
 *             0 = (0,0)  1 = two s16  2 = two s32  3 = two s16 << 7
 *   The control is `current + control delta`, the end is `control + anchor
 *   delta`. A non-zero move delta starts a new contour. Units are 1/256 twip
 *   (1/5120 px). The header's edge count includes the style edges and not the
 *   terminating 0 byte; that count is how a shape is recognised.
 *
 * Not decoded (warned about): pencil lines, gradient and bitmap fills,
 * symbols, text, bitmaps, tweens, masks, more than one scene.
 */
import { readCfbStreams } from "./fla-parser.js";
import { rev } from "./fla-reader.js";

const UNIT = 5120; // edge units per pixel
const TWIP = 20;

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const s16 = (d, o) => (u16(d, o) << 16) >> 16;
const s32 = (d, o) => u32(d, o) | 0;

const hex2 = (n) => n.toString(16).padStart(2, "0");

/** Read one shape whose 6×u32 matrix starts at `m`; null when the bytes are not a shape. */
export function readShapeAt(d, m) {
  if (m + 24 + 1 + 4 + 2 > d.length) return null;
  const matrix = [0, 1, 2, 3, 4, 5].map((i) => s32(d, m + 4 * i));
  // a plausible 16.16 matrix: scale between 1/16 and 16, little skew
  const scaleOk = (v) => Math.abs(v) >= 4096 && Math.abs(v) <= 1 << 20;
  if (!scaleOk(matrix[0]) || !scaleOk(matrix[3]) || Math.abs(matrix[1]) > 1 << 20 || Math.abs(matrix[2]) > 1 << 20) return null;
  let o = m + 24;
  const schema = d[o++];
  if (schema < 1 || schema > 8) return null;
  const count = u32(d, o); o += 4;
  if (count < 1 || count > 2_000_000) return null;
  const fillCount = u16(d, o); o += 2;
  if (fillCount > 200) return null;
  const fills = [];
  for (let i = 0; i < fillCount; i++) {
    if (o + 6 > d.length) return null;
    fills.push({ r: d[o], g: d[o + 1], b: d[o + 2], a: d[o + 3] }); // colour, then two bytes skipped
    o += 6;
  }
  if (o + 2 > d.length) return null;
  const lineCount = u16(d, o); o += 2;
  if (lineCount > 200) return null;
  if (lineCount) return { lines: true, at: m };

  const edges = [];
  let style = [0, 0, 0];
  for (;;) {
    if (o >= d.length) return null;
    const t = d[o++];
    if (t === 0) break;
    if (t & 0x40) {
      if (t & 0x80) {
        if (o + 3 > d.length) return null;
        style = [d[o], d[o + 1], d[o + 2]]; o += 3;
      } else {
        if (o + 6 > d.length) return null;
        style = [u16(d, o) & 0x7fff, u16(d, o + 2) & 0x7fff, u16(d, o + 4) & 0x7fff]; o += 6;
      }
    }
    const pairs = [];
    for (let sh = 0; sh <= 4; sh += 2) {
      const mode = (t >> sh) & 3;
      const need = mode === 0 ? 0 : mode === 2 ? 8 : 4;
      if (o + need > d.length) return null;
      if (mode === 0) pairs.push([0, 0]);
      else if (mode === 1) pairs.push([s16(d, o), s16(d, o + 2)]);
      else if (mode === 3) pairs.push([s16(d, o) * 128, s16(d, o + 2) * 128]);
      else pairs.push([s32(d, o), s32(d, o + 4)]);
      o += need;
    }
    edges.push({ type: t, style, move: pairs[0], control: pairs[1], anchor: pairs[2] });
    if (edges.length > count) return null;
  }
  if (edges.length !== count) return null;
  return { at: m, end: o, matrix, schema, fills, edges };
}

/** One sub-path per edge: with the non-zero rule the edges need not be chained into loops. */
function looseEdges(segs) {
  let d = "";
  for (const s of segs) {
    d += `M${+s.x1.toFixed(2)} ${+s.y1.toFixed(2)}`;
    d += s.qx !== undefined ? `Q${+s.qx.toFixed(2)} ${+s.qy.toFixed(2)} ${+s.x2.toFixed(2)} ${+s.y2.toFixed(2)}` : `L${+s.x2.toFixed(2)} ${+s.y2.toFixed(2)}`;
  }
  return d;
}

/** Edges -> per-fill path strings in pixels. */
function shapeToModel(raw, stitch) {
  const fillSegs = new Map();
  let x = 0, y = 0;
  const push = (k, segs) => (fillSegs.get(k) || fillSegs.set(k, []).get(k)).push(...segs);
  for (const e of raw.edges) {
    x += e.move[0]; y += e.move[1];
    const cx = x + e.control[0], cy = y + e.control[1];
    const ex = cx + e.anchor[0], ey = cy + e.anchor[1];
    // snap to twips so the two sides of a shared boundary meet exactly
    const snap = (v) => Math.round(v / (UNIT / TWIP)) / TWIP;
    const seg = e.control[0] === 0 && e.control[1] === 0
      ? { x1: snap(x), y1: snap(y), x2: snap(ex), y2: snap(ey) }
      : { x1: snap(x), y1: snap(y), qx: snap(cx), qy: snap(cy), x2: snap(ex), y2: snap(ey) };
    x = ex; y = ey;
    if (seg.x1 === seg.x2 && seg.y1 === seg.y2 && seg.qx === undefined) continue;
    const [, left, right] = e.style; // line, left fill, right fill
    if (right) push(right, [seg]);
    if (left) push(left, [rev(seg)]);
  }
  const fills = [];
  for (const [index, segs] of fillSegs) {
    const c = raw.fills[index - 1];
    if (!c) continue;
    fills.push({
      style: { type: "solid", color: `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`, alpha: c.a / 255 },
      d: stitch(segs, true),
    });
  }
  const m = raw.matrix;
  return { type: "shape", matrix: [m[0] / 65536, m[1] / 65536, m[2] / 65536, m[3] / 65536, m[4] / 65536 / TWIP, m[5] / 65536 / TWIP], fills, strokes: [] };
}

/** Frame tail that follows a shape: schema byte at +4, length (frames) at +5. */
function frameTail(d, end) {
  const marker = end + 0x16;
  if (marker + 4 > d.length) return null;
  if (!(d[marker] === 0xff && d[marker + 1] === 0xff && d[marker + 2] === 0xff && d[marker + 3] === 0x3f)) return null;
  const duration = u16(d, end + 5);
  return { duration: duration >= 1 && duration <= 10000 ? duration : 1, next: marker + 4 };
}

/** The first non-empty MFC unicode string (`ff fe ff <len> UTF-16`) at or after `from`. */
function firstString(d, from) {
  for (let i = from; i + 4 < d.length; i++) {
    if (d[i] === 0xff && d[i + 1] === 0xfe && d[i + 2] === 0xff) {
      const len = d[i + 3];
      if (len > 0 && len < 0xff && i + 4 + len * 2 <= d.length) {
        let s = "";
        for (let k = 0; k < len; k++) s += String.fromCharCode(u16(d, i + 4 + k * 2));
        return s;
      }
    }
  }
  return null;
}

/** Stage size, frame rate and background out of the `Contents` stream. */
function readContents(c, warnings) {
  const out = { width: 550, height: 400, frameRate: 12, background: "#ffffff" };
  let found = false;
  for (let i = 7; i + 8 <= c.length - 0x40; i++) {
    // `05 00 00 00 00 00 00 <width twips> <height twips>`
    if (c[i - 7] === 5 && c[i - 6] === 0 && c[i - 5] === 0 && c[i - 4] === 0 && c[i - 3] === 0 && c[i - 2] === 0 && c[i - 1] === 0) {
      const w = u32(c, i), h = u32(c, i + 8);
      if (w % TWIP === 0 && h % TWIP === 0 && w >= 16 * TWIP && h >= 16 * TWIP && w <= 8192 * TWIP && h <= 8192 * TWIP) {
        out.width = w / TWIP; out.height = h / TWIP; found = true;
        const rate = c[i + 0x3b];
        if (rate >= 1 && rate <= 120) out.frameRate = rate;
        else warnings.add("the frame rate was not found; 12 fps assumed");
        if (c[i + 0x31 + 3] === 0xff) out.background = `#${hex2(c[i + 0x31])}${hex2(c[i + 0x31 + 1])}${hex2(c[i + 0x31 + 2])}`;
        break;
      }
    }
  }
  if (!found) warnings.add("the stage size was not found; 550x400 at 12 fps assumed");
  return out;
}

/**
 * @param {Uint8Array} bytes the whole .fla file
 * @param {(segs: object[], close: boolean) => string} stitch  fla-reader's stitcher
 * @returns {{doc: object, warnings: Set<string>}}
 */
export function readBinaryFla(bytes, stitch) {
  const warnings = new Set();
  const cfb = readCfbStreams(bytes);
  const names = cfb.entries.map((e) => e.name);
  const contents = cfb.stream("Contents");
  const page = cfb.stream("Page 1");
  if (!contents || !page) throw new Error("This binary .fla has no 'Contents' or 'Page 1' stream, so there is nothing to import.");
  const pages = names.filter((n) => /^Page \d+$/.test(n)).length;
  if (pages > 1) warnings.add(`only the first of ${pages} scenes was imported`);
  if (names.some((n) => /^Symbol \d+$/.test(n))) warnings.add("symbols in binary .fla files were not imported");
  if (names.some((n) => /^Media \d+$/.test(n))) warnings.add("bitmaps in binary .fla files were not imported");

  const stage = readContents(contents, warnings);
  const d = new Uint8Array(page);

  // find the shapes: a candidate is accepted only when its edge count matches exactly
  const frames = [];
  let current = null;
  let index = 0;
  let sawLines = false;
  let lastEnd = 0;
  for (let i = 0; i < d.length - 40;) {
    const shape = readShapeAt(d, i);
    if (shape && shape.lines) { sawLines = true; i += 1; continue; }
    if (!shape) { i += 1; continue; }
    if (!current) current = { index, duration: 1, label: null, elements: [] };
    current.elements.push(shapeToModel(shape, stitch));
    lastEnd = shape.end;
    const tail = frameTail(d, shape.end);
    if (tail) {
      current.duration = tail.duration;
      frames.push(current);
      index += tail.duration;
      current = null;
      i = tail.next;
    } else {
      i = shape.end;
    }
  }
  if (current) frames.push(current);
  if (sawLines && !frames.length) warnings.add("pencil lines (stroke styles) in binary .fla files are not decoded yet");
  else if (sawLines) warnings.add("some pencil lines (stroke styles) were not decoded");
  if (!frames.length) throw new Error("No drawings could be read from this binary .fla (it may hold only symbols, text or bitmaps, which are not decoded yet).");

  const layerName = firstString(d, lastEnd) || "Layer 1";
  const length = frames.reduce((n, f) => Math.max(n, f.index + f.duration), 1);
  const layer = { name: layerName, color: "", type: "normal", visible: true, locked: false, parentLayerIndex: null, frames };
  return {
    doc: {
      width: stage.width, height: stage.height, frameRate: stage.frameRate, background: stage.background,
      timelines: [{ name: "Scene 1", layers: [layer], length }], symbols: {}, bitmaps: {},
    },
    warnings,
  };
}
