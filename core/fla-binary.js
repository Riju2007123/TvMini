/**
 * Binary .fla Page stream decoder (legacy Flash 8 MFC serialization).
 *
 * The format is an MFC `CArchive` object graph, so every object is written
 * children-first and every record is introduced by a class tag:
 *
 *   0xFFFF  <u16 schema> <u16 nameLen> <name>   a new class declaration
 *   0x8000|id                                   an object of class `id`
 *   0x7FFF  <u32 id>                            an object of a known class
 *   0x0001..0x7FFE                              a back-reference (no payload)
 *   0x0000                                      end of a children list
 *
 * `CPicPage` â†’ `CPicLayer` â†’ `CPicFrame` â†’ `CPicShape` data. Every composite
 * starts with a children list and a version flag; the flag decides how many
 * bytes follow the list's `0x0000` terminator (0/8/8/9/10 for flags 0/1/2/3/4+).
 *
 * The layout below follows Umoupen's reader (`import_fla_binary.c`, recovered
 * with Ghidra â€” see `docs/fla-re/`):
 *
 *   FUN_1404fef50  composite children + terminator payload
 *   FUN_1404ff8c0  dispatcher (CPicPage / CPicLayer / CPicFrame / CPicShape â€¦)
 *   FUN_1405046c0  shape: fillSchema, matrix, shapeSchema, fills, lines, edges
 *   FUN_140502420  schema-3+ fill (solid / gradient / bitmap) reader
 *   FUN_1404fe870  MFC counted string
 */

import { Buffer } from "./bytes.js";
import { encodeRgbaPng } from "./png.js";
import { inflateSync } from "./zlib.js";

/** Edge coordinates are 1/20 twip fixed point: 1/20 px with 8 fraction bits. */
const EDGE_SCALE = 1 / 5120;
/** Shape matrices: a,b,c,d are 16.16 fixed point; tx,ty are twips. */
const MATRIX_SCALE = 1 / 65536;
const TRANSLATE_SCALE = 1 / 20;
/** Stroke weights are twips. */
const STROKE_SCALE = 1 / 20;

const MAX_EDGES_PER_SHAPE = 200000;
const MAX_POINTS_PER_DRAWING = 120000;
const MAX_SAFE_CUBIC_COUNT = 200000;

/** Thrown when the stream reaches a record we cannot cross safely. */
class StopDecode extends Error {}

/**
 * A binary-FLA colour is four bytes `R, G, B, A` (Phoenix format notes,
 * confirmed against XFL twins), so a little-endian `u32` reads back as
 * `A << 24 | B << 16 | G << 8 | R`. Alpha is dropped: TVMini strokes are
 * opaque.
 */
function colorFromU32(value) {
  const r = value & 0xff;
  const g = (value >>> 8) & 0xff;
  const b = (value >>> 16) & 0xff;
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function strokeWidth(weightTwips) {
  const width = weightTwips * STROKE_SCALE;
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.min(200, Math.max(1, width));
}

class BinaryCursor {
  constructor(data) {
    this.data = data;
    this.at = 0;
  }

  eof() {
    return this.at >= this.data.length;
  }

  need(n) {
    if (this.at + n > this.data.length) throw new StopDecode("the page stream is truncated");
  }

  u8() {
    this.need(1);
    return this.data[this.at++];
  }

  u16() {
    this.need(2);
    const value = this.data[this.at] | (this.data[this.at + 1] << 8);
    this.at += 2;
    return value;
  }

  u32() {
    this.need(4);
    const value =
      (this.data[this.at] |
        (this.data[this.at + 1] << 8) |
        (this.data[this.at + 2] << 16) |
        (this.data[this.at + 3] << 24)) >>>
      0;
    this.at += 4;
    return value;
  }

  s16() {
    const value = this.u16();
    return value < 0x8000 ? value : value - 0x10000;
  }

  s32() {
    const value = this.u32();
    return value > 0x7fffffff ? value - 0x100000000 : value;
  }

  skip(n) {
    if (n < 0) throw new StopDecode("a negative skip");
    this.need(n);
    this.at += n;
  }

  bytes(n) {
    this.need(n);
    const out = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  f64() {
    this.need(8);
    const value = this.data.readDoubleLE(this.at);
    this.at += 8;
    return value;
  }

  /**
   * MFC counted string (FUN_1404fe870): a length byte, then either the raw
   * bytes or one of the escape forms (0xFF 0xFFFE wide, 0xFF 0xFFFF long).
   */
  readString() {
    const first = this.u8();
    if (first === 0) return "";
    if (first !== 0xff) return Buffer.from(this.bytes(first)).toString("latin1");

    const marker = this.u16();
    if (marker === 0xfffe) {
      let length = this.u8();
      if (length === 0xff) length = this.u16();
      const raw = this.bytes(length * 2);
      let text = "";
      for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode(raw[i] | (raw[i + 1] << 8));
      return text;
    }
    if (marker === 0xffff) {
      const length = this.u32();
      if (length > this.data.length) throw new StopDecode("a string length runs past the page stream");
      return Buffer.from(this.bytes(length)).toString("latin1");
    }
    return Buffer.from(this.bytes(marker)).toString("latin1");
  }

  readClassTag() {
    const tag = this.u16();
    if (tag === 0x0000) return { kind: "terminator" };
    if (tag === 0xffff) {
      const schema = this.u16();
      const length = this.u16();
      const name = Buffer.from(this.bytes(length)).toString("latin1");
      return { kind: "class", name, schema };
    }
    if (tag === 0x7fff) return { kind: "object", classId: this.u32() };
    if (tag & 0x8000) return { kind: "object", classId: tag & 0x7fff };
    return { kind: "object", classId: tag };
  }
}

/**
 * The stream's class/object table. Every `0xffff` declaration appends TWO
 * entries — the class entry (odd id) and its first object entry (even id) —
 * and reference tags index the table directly: reference id N resolves to
 * entry N's class name, which is then dispatched as a new object record.
 * (Disassembly of `FUN_1405040c0`/`FUN_140503240`: the declaration path calls
 * the appender twice and the reference path copies the name from
 * `table[id - 1]`.)
 */
class ClassRegistry {
  constructor() {
    this.byId = new Map();
    this.nextId = 1;
  }

  register(name) {
    const id = this.nextId;
    this.byId.set(id, name);
    this.byId.set(id + 1, name);
    this.nextId += 2;
    return id;
  }

  resolve(id) {
    return this.byId.get(id) ?? null;
  }
}

function skipTerminatorPayload(cursor, flag) {
  if (flag === 0) return;
  cursor.skip(8);
  if (flag < 3) return;
  cursor.skip(1);
  if (flag === 3) return;
  cursor.skip(1);
}

/**
 * Scan forward from `cursor.at` to find the next plausible class tag, skipping
 * over object data whose size we cannot determine. Returns true if a plausible
 * tag was found (cursor positioned at it), false if we ran out of data.
 */
function skipToNextTag(cursor) {
  const data = cursor.data;
  let pos = cursor.at;
  while (pos < data.length - 1) {
    const tag = data[pos] | (data[pos + 1] << 8);
    if (tag === 0x0000) { cursor.at = pos; return true; } // terminator
    if (tag === 0xffff) { cursor.at = pos; return true; } // class declaration
    if (tag === 0x7fff) { cursor.at = pos; return true; } // full u32 classId object
    if (tag & 0x8000 && (tag & 0x7fff) >= 1) { cursor.at = pos; return true; } // object reference
    pos += 1;
  }
  return false;
}

/**
 * Optional debug tracing of the binary page walk (`FLA_TRACE=1` on stderr).
 */
const FLA_TRACE = typeof process !== "undefined" && process?.env?.FLA_TRACE === "1";
let traceDepth = 0;
function trace(...parts) {
  if (!FLA_TRACE) return;
  console.error(`${traceDepth < 16 ? "  ".repeat(traceDepth) : ""}${parts.join(" ")}`);
}
function traceHex(value) {
  return `0x${value.toString(16)}`;
}

/**
 * One composite's children list (`FUN_1404fef50`): a version flag byte and a
 * companion byte, then class tags until `0x0000` and its version-dependent
 * payload.
 *
 * Every tag is an object record whose own fields follow it in the stream: the
 * tag is dispatched to that class's decoder inline (`handler(name, cursor)`).
 * A `0xffff` tag also declares its class name at the next sequential id, so a
 * later reference tag can resolve to it.
 */
function readCompositeChildren(cursor, registry, warnings, handler, { skipUnknown = false } = {}) {
  const at = cursor.at;
  const flag = cursor.u8();
  const companion = cursor.u8();
  trace(`[] children flag=${flag} comp=${companion} at=${traceHex(at)}`);
  traceDepth += 1;

  try {
    for (;;) {
      if (cursor.eof()) throw new StopDecode("the page stream ends inside a children list");
      const tagAt = cursor.at;
      const tag = cursor.readClassTag();
      if (tag.kind === "terminator") {
        skipTerminatorPayload(cursor, flag);
        trace(`[] terminator at=${traceHex(tagAt)} -> next=${traceHex(cursor.at)} (flag ${flag})`);
        return flag;
      }
      let name;
      if (tag.kind === "class") {
        registry.register(tag.name);
        name = tag.name;
      } else {
        name = registry.resolve(tag.classId);
        if (!name) {
          // Never declared in this stream. Skipping over an object whose size
          // we cannot know is unreliable; stop unless the caller opts into a
          // byte-heuristic resync.
          const message = `a children list refers to undeclared class id ${tag.classId} at ${traceHex(tagAt)}`;
          if (!skipUnknown) throw new StopDecode(message);
          warnings.add(message);
          if (!skipToNextTag(cursor)) throw new StopDecode(`cannot skip undeclared class ${tag.classId}`);
          continue;
        }
      }
      trace(`<> ${name} tag at=${traceHex(tagAt)}${tag.kind === "class" ? " (declared)" : ""}`);
      try {
        if (!handler(name, cursor)) throw new StopDecode(`${name} is not imported`);
      } catch (error) {
        if (!(error instanceof StopDecode)) throw error;
        if (!skipUnknown) throw error;
        warnings.add(`a ${name} in a children list stopped: ${error.message}`);
        if (!skipToNextTag(cursor)) throw new StopDecode(`cannot skip after ${name} in a children list`);
        continue;
      }
    }
  } finally {
    traceDepth -= 1;
  }
}

/**
 * An optional object reference (`FUN_140504520`): one class tag, then — for a
 * new `0xffff` declaration — that object's full record. A terminator (an
 * empty reference) and a tag referencing an already-decoded object resolve to
 * that object with nothing further to read.
 */
function readOptionalObject(cursor, registry, ctx) {
  const at = cursor.at;
  const tag = cursor.readClassTag();
  if (tag.kind === "terminator") {
    trace(`  (opt) none at=${traceHex(at)}`);
    return 0;
  }
  if (tag.kind !== "class") {
    const name = registry.resolve(tag.classId);
    if (!name) throw new StopDecode(`an optional object refers to undeclared class id ${tag.classId} at ${traceHex(at)}`);
    trace(`  (opt) ref ${name} id=${tag.classId} at=${traceHex(at)}`);
    return tag.classId;
  }
  const name = (() => { registry.register(tag.name); return tag.name; })();
  const decoder = OPTIONAL_DECODERS[name];
  if (!decoder) {
    throw new StopDecode(`an optional object of class ${name} declared at ${traceHex(at)} is not imported`);
  }
  trace(`  (opt) ${name} at=${traceHex(at)}`);
  traceDepth += 1;
  try {
    return decoder(cursor, registry, ctx);
  } finally {
    traceDepth -= 1;
  }
}

/* ------------------------------------------------------------------ shapes */

/**
 * Classes an optional-object slot can dispatch to (`FUN_140504520` recursion).
 */
const OPTIONAL_DECODERS = {
  CPicShape: (cursor, registry, ctx) => decodeFrameShapeObject(cursor, registry, ctx),
  CPicBitmap: (cursor, registry, ctx) => decodeCPicBitmap(cursor, registry, ctx),
  CPicSymbol: (cursor, registry, ctx) => decodeCPicSymbol(cursor, registry, ctx),
  CPicSprite: (cursor, registry, ctx) => decodeCPicSprite(cursor, registry, ctx),
};

function readGradientMatrix(cursor) {
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(cursor.s32());
  return matrix;
}

/**
 * A fill or line-fill payload (`FUN_140502420`), for shape schema 3+.
 * Returns `{ color, type }`; gradients and bitmaps are flattened to a colour.
 */
function readFillPayload(cursor, fillSchema, alphaRead, warnings) {
  const color = cursor.u32();
  const subtype = cursor.u8();
  cursor.skip(1);

  const base = subtype & 0x7f;
  const gradient = base === 0x10 || base === 0x12 || base === 0x13;
  const bitmap = (subtype & 0x40) !== 0;

  if (!gradient && !bitmap) {
    if ((subtype & 0x70) !== 0) {
      warnings.add(`an unsupported fill subtype 0x${subtype.toString(16)} was imported as a solid colour`);
    }
    return { type: "solid", color: colorFromU32(color) };
  }

  if (bitmap) {
    readGradientMatrix(cursor);
    const media = cursor.u16();
    warnings.add(`a bitmap fill (media ${media}) was imported as a solid colour`);
    return { type: "bitmap", color: colorFromU32(color), media };
  }

  readGradientMatrix(cursor);
  const stopCount = cursor.u8();
  if (alphaRead || fillSchema >= 3) cursor.skip(8);
  const stops = [];
  for (let i = 0; i < stopCount; i += 1) {
    const ratio = cursor.u8();
    const value = cursor.u32();
    stops.push({ ratio, color: colorFromU32(value) });
  }
  if (!stops.length) return { type: "gradient", color: colorFromU32(color) };
  warnings.add("a gradient fill was imported as its first colour");
  return { type: "gradient", color: stops[0].color, stops };
}

/**
 * The shape body (`FUN_1405046c0`), starting at `fillSchema`. The caller has
 * already consumed this object's children list.
 */
function readShapeBody(cursor, versionFlag, warnings) {
  const shapeStart = cursor.at;
  const fillSchema = cursor.u8();
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(cursor.s32());

  const shapeSchema = cursor.u8();
  if (shapeSchema > 8) throw new StopDecode(`an unsupported binary shape schema ${shapeSchema} at 0x${(cursor.at - 1).toString(16)}`);
  const declaredEdges = cursor.u32();

  const fillCount = cursor.u16();
  const fills = [];
  for (let i = 0; i < fillCount; i += 1) {
    if (shapeSchema < 3) {
      const color = cursor.u32();
      cursor.skip(2);
      fills.push({ type: "solid", color: colorFromU32(color) });
    } else {
      fills.push(readFillPayload(cursor, fillSchema, false, warnings));
    }
  }

  const lineStyles = [];
  const lineCount = cursor.u16();
  for (let i = 0; i < lineCount; i += 1) {
    const color = cursor.u32();
    const weight = cursor.u16();
    cursor.skip(4); // join/cap flags, unused
    if (fillSchema < 3) {
      warnings.add("a legacy binary line style was imported without its fill");
      lineStyles.push({ color: colorFromU32(color), width: strokeWidth(weight) });
    } else {
      cursor.skip(6);
      const fill = readFillPayload(cursor, fillSchema, true, warnings);
      lineStyles.push({ color: colorFromU32(color), width: strokeWidth(weight), fill });
    }
  }

  const edges = readEdgeRecords(cursor, shapeSchema, versionFlag, warnings);
  if (declaredEdges !== 0 && edges.length !== declaredEdges) {
    warnings.add(
      `a shape declares ${declaredEdges} edges but ${edges.length} were read`,
    );
  }
  return { fillSchema, shapeSchema, matrix, fills, lines: lineStyles, edges };
}

/** Edge records: a type byte, optional styles, then three delta pairs. */
function readEdgeRecords(cursor, shapeSchema, versionFlag, warnings) {
  const edges = [];
  if (shapeSchema < 2) return edges;

  let x = 0;
  let y = 0;
  // Style indices are 1-based and 0 means "no style"; store them 0-based with
  // -1 for none, so they index the fill and line lists directly.
  let lastFill = -1;
  let lastFill1 = -1;
  let lastLine = -1;
  let count = 0;

  const readDelta = (shift) => {
    if (shift === 0) return [0, 0];
    if (shift === 1) return [cursor.s16(), cursor.s16()];
    if (shift === 2) return [cursor.s32(), cursor.s32()];
    return [cursor.s16() * 128, cursor.s16() * 128];
  };

  for (;;) {
    const type = cursor.u8();
    if (type === 0) break;
    count += 1;
    if (count > MAX_EDGES_PER_SHAPE) throw new StopDecode("a shape has more edges than can be imported");

    let fillStyle = lastFill;
    let fillStyle1 = lastFill1;
    let lineStyle = lastLine;
    let styleChange = false;
    if (type & 0x40) {
      styleChange = true;
      // Phoenix: three indices â€” line, then the fill on each side of the
      // edge. Bit 15 of the 16-bit form is the XFL edge-selection flag.
      let line;
      let fill0;
      let fill1;
      if (type & 0x80) {
        line = cursor.u8();
        fill0 = cursor.u8();
        fill1 = cursor.u8();
      } else {
        line = cursor.u16() & 0x7fff;
        fill0 = cursor.u16() & 0x7fff;
        fill1 = cursor.u16() & 0x7fff;
      }
      lineStyle = line > 0 ? line - 1 : -1;
      fillStyle = fill0 > 0 ? fill0 - 1 : -1;
      fillStyle1 = fill1 > 0 ? fill1 - 1 : -1;
      lastFill = fillStyle;
      lastFill1 = fillStyle1;
      lastLine = lineStyle;
    }

    // The three pairs are: a move to the edge start, then the quadratic
    // control point and the endpoint, both relative to that start.
    const d1 = readDelta(type & 3);
    const d2 = readDelta((type >> 2) & 3);
    const d3 = readDelta((type >> 4) & 3);
    const startX = x + d1[0];
    const startY = y + d1[1];
    const controlX = startX + d2[0];
    const controlY = startY + d2[1];
    const endX = startX + d3[0];
    const endY = startY + d3[1];

    // Version 5+ marks a line edge with a zero-shift control pair and writes
    // one extra byte for it.
    if (versionFlag > 4 && ((type >> 2) & 3) === 0) cursor.skip(1);

    x = endX;
    y = endY;
    edges.push({
      start: [startX, startY],
      control: [controlX, controlY],
      end: [endX, endY],
      fillStyle,
      fillStyle1,
      lineStyle,
      styleChange,
    });
  }

  // Shape schema 5+ stores cubic edges after the terminator.
  if (shapeSchema >= 5) {
    const cubicCount = cursor.s32();
    if (cubicCount < 0) throw new StopDecode("a shape has a negative cubic edge count");
    if (cubicCount > MAX_SAFE_CUBIC_COUNT) throw new StopDecode("a shape has too many cubic edges");
    for (let i = 0; i < cubicCount; i += 1) {
      cursor.skip(0x20);
      if (versionFlag > 4) {
        const inner = cursor.u8();
        cursor.skip(inner * 10);
        const flags = cursor.u8();
        if (flags & 1) cursor.skip(8);
        if (flags & 2) cursor.skip(8);
      }
    }
  }

  return edges;
}

/* --------------------------------------------------------------- rendering */

/**
 * Transform a raw edge coordinate (1/5120 px) into pixels: the matrix's
 * linear part is 16.16 fixed point and its translation is in twips.
 */
function applyMatrix(matrix, x, y) {
  if (!matrix) return [clampCoord(x * EDGE_SCALE), clampCoord(y * EDGE_SCALE)];
  const [a, b, c, d, tx, ty] = matrix;
  if (a === 0x10000 && b === 0 && c === 0 && d === 0x10000 && tx === 0 && ty === 0) {
    return [clampCoord(x * EDGE_SCALE), clampCoord(y * EDGE_SCALE)];
  }
  const nx = (a * x + c * y) * MATRIX_SCALE * EDGE_SCALE + tx * TRANSLATE_SCALE;
  const ny = (b * x + d * y) * MATRIX_SCALE * EDGE_SCALE + ty * TRANSLATE_SCALE;
  return [clampCoord(nx), clampCoord(ny)];
}

function clampCoord(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1e6, Math.min(1e6, v));
}

function sampleQuadratic(p0, control, p1, steps) {
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * control[0] + t * t * p1[0];
    const y = u * u * p0[1] + 2 * u * t * control[1] + t * t * p1[1];
    points.push([x, y]);
  }
  return points;
}

/**
 * Flatten a shape into TVMini strokes and fills.
 *
 * Flash keeps the ink of a brush as filled regions, not as a line down the
 * middle. Outlining those regions draws both of their sides, which is where
 * the double edge of an imported brush stroke came from, so a filled region
 * becomes a filled path at its own colour. An edge that also carries a line
 * style still becomes a stroke on top of the fill, the way a shape can have
 * an outline and an interior.
 *
 * The edges of one fill style are kept as separate subpaths. All subpaths of
 * the same style are filled together with combined nonzero winding (Flash's
 * fill model): an inner contour whose winding opposes the outer one carves a
 * hole instead of being painted on top of it.
 */
function shapeToStrokes(shape, out, warnings) {
  if (!shape || !shape.edges.length) return;

  const scalePoint = (point) => applyMatrix(shape.matrix, point[0], point[1]);
  const joins = (a, b) => Boolean(a && b) && Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.01;

  // One subpath per contiguous run of edges per fill style. Subpaths are not
  // stitched into closed loops: every subpath of one fill style contributes
  // to the same winding number when the region is filled.
  const lines = [];
  const fillSubpaths = new Map(); // style -> array of subpaths, each an array of points
  let lineChain = null;
  let lineLast = null;
  let points = 0;

  edgeLoop: for (const edge of shape.edges) {
    const start = scalePoint(edge.start);
    const control = scalePoint(edge.control);
    const end = scalePoint(edge.end);
    const rough =
      Math.hypot(control[0] - start[0], control[1] - start[1]) +
      Math.hypot(end[0] - control[0], end[1] - control[1]);
    const steps = Math.min(12, Math.max(1, Math.ceil(rough / 4)));
    const curve = sampleQuadratic(start, control, end, steps);

    // Each edge bounds the fill on its right (`fillStyle1`) and on its left
    // (`fillStyle`). Going along the edge, the right-hand region is kept in
    // the edge's own direction and the left-hand one reversed, so the edges
    // of one region chain end-to-start into loops with a single winding.
    // An edge with the same fill on both sides is not a boundary at all.
    if (edge.fillStyle !== edge.fillStyle1) {
      const key = (point) => `${point[0]},${point[1]}`;
      const forward = [start, ...curve];
      const sides = [];
      if (shape.fills[edge.fillStyle1]) sides.push([edge.fillStyle1, forward, key(edge.start), key(edge.end)]);
      if (shape.fills[edge.fillStyle]) sides.push([edge.fillStyle, [...forward].reverse(), key(edge.end), key(edge.start)]);
      for (const [style, run, from, to] of sides) {
        let runs = fillSubpaths.get(style);
        if (!runs) {
          runs = [];
          fillSubpaths.set(style, runs);
        }
        points += run.length;
        if (points >= MAX_POINTS_PER_DRAWING) {
          warnings.add("a drawing has more points than can be imported; the rest was dropped");
          break edgeLoop;
        }
        runs.push({ from, to, points: run });
      }
    }

    if (shape.lines[edge.lineStyle]) {
      if (!lineChain || lineChain.style !== edge.lineStyle || !joins(start, lineLast)) {
        lineChain = { style: edge.lineStyle, points: [start] };
        lines.push(lineChain);
        points += 1;
      }
      for (const point of curve) {
        if (points >= MAX_POINTS_PER_DRAWING) {
          warnings.add("a drawing has more points than can be imported; the rest was dropped");
          break edgeLoop;
        }
        lineChain.points.push(point);
        points += 1;
      }
      lineLast = end;
    }
  }

  // Fill every fill style: all its contours together, combined winding.
  for (const [style, runs] of fillSubpaths) {
    const fill = shape.fills[style];
    const contours = joinRuns(runs);
    if (!contours.length) continue;
    out.push({
      kind: "paths",
      color: fill.color,
      width: 1,
      paths: contours,
      opacity: 1,
      blend: "normal",
    });
  }

  // The lines of a shape go on top of its fills, the way Flash paints a shape
  // that has both an interior and an outline.
  for (const chain of lines) {
    if (chain.points.length < 2) continue;
    const line = shape.lines[chain.style];
    out.push({
      color: line.color,
      width: line.width,
      points: chain.points,
      opacity: 1,
      blend: "normal",
    });
  }
}

/**
 * Join the runs of one fill style (each `{ from, to, points }`, `from`/`to`
 * being the exact end-point keys) into contours, following each run to the
 * one that starts where it ends. A contour that does not come back to its
 * start is closed with a straight line, the way Flash fills an open outline.
 * Flash writes edges in drawing order, not loop order, so this is what turns
 * a pile of edges into regions instead of slivers.
 */
function joinRuns(runs) {
  const byStart = new Map();
  runs.forEach((run, index) => {
    const list = byStart.get(run.from);
    if (list) list.push(index);
    else byStart.set(run.from, [index]);
  });
  const used = new Array(runs.length).fill(false);
  const contours = [];

  for (let first = 0; first < runs.length; first += 1) {
    if (used[first]) continue;
    used[first] = true;
    const startKey = runs[first].from;
    const contour = [...runs[first].points];
    let tail = runs[first].to;
    while (tail !== startKey) {
      const candidates = byStart.get(tail);
      let next = -1;
      if (candidates) {
        for (const index of candidates) {
          if (!used[index]) {
            next = index;
            break;
          }
        }
      }
      if (next === -1) break;
      used[next] = true;
      for (let i = 1; i < runs[next].points.length; i += 1) contour.push(runs[next].points[i]);
      tail = runs[next].to;
    }
    if (contour.length < 3) continue;
    const head = contour[0];
    const last = contour[contour.length - 1];
    if (Math.hypot(head[0] - last[0], head[1] - last[1]) > 1e-6) contour.push([head[0], head[1]]);
    contours.push(contour);
  }
  return contours;
}

/* ----------------------------------------------------------------- objects */

function decodeFrameShapeObject(cursor, registry, ctx) {
  const flag = readCompositeChildren(cursor, registry, ctx.warnings, () => {
    throw new StopDecode("a shape inside a shape is not imported");
  });
  return readShapeBody(cursor, flag, ctx.warnings);
}

/**
 * A placed bitmap (`CPicBitmap`, `FUN_1404ff8c0`): its own children list, a
 * one-byte schema, a 3Ã—2 matrix, the media id, and (schema 2+) the filter mode.
 * The placement is kept; the pixels are decoded from the page's `Media N`
 * stream and flattened into an image once the stage size is known.
 */
function decodeCPicBitmap(cursor, registry, ctx) {
  readCompositeChildren(cursor, registry, ctx.warnings, (name) => {
    throw new StopDecode(`${name} inside a bitmap is not imported`);
  });

  const schema = cursor.u8();
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(cursor.s32());
  const media = cursor.u16();
  if (schema >= 2) {
    const filter = cursor.u8();
    if (filter !== 0) {
      throw new StopDecode(`a bitmap uses an unsupported filter mode ${filter}`);
    }
  }
  return { matrix, media };
}

/**
 * A placed sprite (`CPicSprite`, `FUN_140506510`), schema `0x13`:
 * composite children, then schema, 6Ã—u32 matrix (a,b,c,d 16.16 + tx,ty twips),
 * firstFrame u16, two pad fields, 8Ã—u16 colour transform, pad fields, u32,
 * instance name, **streamId u32** (symbol-library lookup), then a fixed tail
 * of pad fields, filters, names and strings. Returns a placement descriptor;
 * the symbol body is resolved later from the `Symbol N` streams.
 */
function decodeCPicSprite(cursor, registry, ctx) {
  readCompositeChildren(cursor, registry, ctx.warnings, (name) => {
    throw new StopDecode(`${name} inside a sprite is not imported`);
  });

  const schema = cursor.u8();
  if (schema !== 0x13) {
    throw new StopDecode(`unsupported CPicSprite schema ${schema}`);
  }
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(cursor.s32());
  const firstFrame = cursor.u16();
  cursor.u16(); // pad
  cursor.u8(); // pad
  const colorTransform = [];
  for (let i = 0; i < 8; i += 1) colorTransform.push(cursor.u16());
  cursor.u16(); // pad
  cursor.u16(); // pad
  cursor.u32(); // pad
  const instanceName = cursor.readString();
  const streamId = cursor.u32();
  return { kind: "sprite", streamId, matrix, firstFrame, instanceName, colorTransform };
}

/**
 * A placed symbol instance (`CPicSymbol`, `FUN_140506f60`): composite
 * children, schema, 6Ã—u32 matrix, firstFrame, then a schema-dependent tail
 * ending in instance name and streamId u32.
 */
function decodeCPicSymbol(cursor, registry, ctx) {
  readCompositeChildren(cursor, registry, ctx.warnings, (name) => {
    throw new StopDecode(`${name} inside a symbol instance is not imported`);
  });

  const schema = cursor.u8();
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(cursor.s32());
  const firstFrame = cursor.u16();
  if (schema < 2) {
    cursor.u8();
  } else {
    cursor.u16();
    cursor.u8();
    if (schema > 10) {
      for (let i = 0; i < 8; i += 1) cursor.u16(); // 3D centre/rotation
      cursor.u16(); cursor.u16(); cursor.u32();
      const instanceName = cursor.readString();
      const streamId = cursor.u32();
      cursor.u32(); cursor.u8(); cursor.u16();
      if (schema === 0x16) cursor.skip(0x66);
      return { kind: "symbol", streamId, matrix, firstFrame, instanceName };
    }
  }
  for (let i = 0; i < 4; i += 1) cursor.u16();
  const instanceName = cursor.readString();
  const streamId = cursor.u32();
  return { kind: "symbol", streamId, matrix, firstFrame, instanceName };
}

/* ------------------------------------------------------------------- media */

/**
 * A `Media N` stream (`03 05`): row size, width, height, the frame rectangle,
 * a flags byte (bit 0 = the pixels carry alpha) and a storage variant. Variant
 * 1 is zlib split into `u16`-length chunks; variant 0 is raw rows. Pixels are
 * `A, R, G, B` (ARGB, the SWF lossless layout); a transparent pixel is
 * premultiplied.
 */
export function decodeMediaStream(stream, warnings) {
  const bytes = Buffer.from(stream);
  if (bytes.length < 26) return null;
  if (bytes[0] !== 0x03 || bytes[1] !== 0x05) return null;

  const rowSize = bytes.readUInt16LE(2);
  const width = bytes.readUInt16LE(4);
  const height = bytes.readUInt16LE(6);
  const flags = bytes[24];
  const variant = bytes[25];
  if (!(width > 0 && height > 0) || width * height > 64_000_000) return null;
  if (rowSize < width * 4) return null;

  const pixelBytes = rowSize * height;
  let raw;
  if (variant === 1) {
    const chunks = [];
    let at = 26;
    let total = 0;
    while (at + 2 <= bytes.length) {
      const length = bytes.readUInt16LE(at);
      at += 2;
      if (length === 0) break;
      if (at + length > bytes.length) return null;
      chunks.push(bytes.subarray(at, at + length));
      at += length;
      total += length;
      if (total > 512 * 1024 * 1024) return null;
    }
    if (!chunks.length) return null;
    raw = Buffer.from(inflateSync(Buffer.concat(chunks)));
  } else if (variant === 0) {
    if (bytes.length < 26 + pixelBytes) return null;
    raw = bytes.subarray(26, 26 + pixelBytes);
  } else {
    warnings.add(`a bitmap with media format ${variant} was skipped`);
    return null;
  }
  if (raw.length < pixelBytes) return null;

  const rgba = new Uint8Array(width * height * 4);
  const hasAlpha = (flags & 1) !== 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * 4;
      const to = (y * width + x) * 4;
      let a = hasAlpha ? raw[at] : 255;
      let r = raw[at + 1];
      let g = raw[at + 2];
      let b = raw[at + 3];
      if (hasAlpha && a > 0 && a < 255) {
        // The stored colour is premultiplied by alpha; undo it for the
        // straight-alpha RGBA TVMini keeps.
        const scale = 255 / a;
        r = Math.min(255, Math.round(r * scale));
        g = Math.min(255, Math.round(g * scale));
        b = Math.min(255, Math.round(b * scale));
      } else if (a === 0) {
        r = 0;
        g = 0;
        b = 0;
      }
      rgba[to] = r;
      rgba[to + 1] = g;
      rgba[to + 2] = b;
      rgba[to + 3] = a;
    }
  }
  return { width, height, rgba };
}

/** Decode one media stream, or reuse the one already decoded. */
function mediaPicture(mediaId, media, cache, warnings) {
  if (cache.has(mediaId)) return cache.get(mediaId);
  let picture = null;
  const stream = media.get(mediaId);
  if (!stream) {
    warnings.add(`a placed bitmap refers to missing media ${mediaId}; it was skipped`);
  } else {
    try {
      picture = decodeMediaStream(stream, warnings);
      if (!picture) {
        warnings.add(`media ${mediaId} is not a bitmap this importer can read; it was skipped`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.add(`media ${mediaId} could not be decoded (${reason}); it was skipped`);
    }
  }
  cache.set(mediaId, picture);
  return picture;
}

/**
 * Paint one placed bitmap into a stage-size RGBA buffer.
 *
 * The placement matrix is the shape form: `a,b,c,d` are 16.16 and `tx,ty` are
 * twips, but the source coordinates are bitmap pixels, which is the same
 * scaling the media's own twip rectangle uses. Destination pixels are mapped
 * back through the inverse and sampled bilinearly.
 */
function drawBitmapInto(out, width, height, picture, matrix) {
  const [a, b, c, d, tx, ty] = matrix;
  const det = a * d - b * c;
  if (det === 0) return;

  const offsetX = tx * TRANSLATE_SCALE;
  const offsetY = ty * TRANSLATE_SCALE;
  const sw = picture.width;
  const sh = picture.height;
  const src = picture.rgba;

  for (let y = 0; y < height; y += 1) {
    const v = y + 0.5 - offsetY;
    for (let x = 0; x < width; x += 1) {
      const u = x + 0.5 - offsetX;
      const sx = (65536 * (d * u - c * v)) / det - 0.5;
      const sy = (65536 * (a * v - b * u)) / det - 0.5;
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const xa = Math.min(sw - 1, Math.max(0, x0));
      const xb = Math.min(sw - 1, Math.max(0, x0 + 1));
      const ya = Math.min(sh - 1, Math.max(0, y0));
      const yb = Math.min(sh - 1, Math.max(0, y0 + 1));

      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const alpha =
        (src[i00 + 3] * w00 + src[i10 + 3] * w10 +
          src[i01 + 3] * w01 + src[i11 + 3] * w11) / 255;
      if (alpha <= 0) continue;
      const r = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      const g = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      const b2 = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;

      // Source-over onto the transparent image of this layer.
      const to = (y * width + x) * 4;
      const underAlpha = out[to + 3] / 255;
      const outAlpha = alpha + underAlpha * (1 - alpha);
      if (outAlpha <= 0) continue;
      const keep = underAlpha * (1 - alpha);
      out[to] = Math.round((r * alpha + out[to] * keep) / outAlpha);
      out[to + 1] = Math.round((g * alpha + out[to + 1] * keep) / outAlpha);
      out[to + 2] = Math.round((b2 * alpha + out[to + 2] * keep) / outAlpha);
      out[to + 3] = Math.round(outAlpha * 255);
    }
  }
}

/** Compose every bitmap placed in one cell into a stage-size transparent PNG. */
function composeCellBitmaps(bitmaps, media, cache, width, height, warnings) {
  let painted = false;
  let out = null;
  for (const placement of bitmaps) {
    const picture = mediaPicture(placement.media, media, cache, warnings);
    if (!picture) continue;
    if (!out) out = new Uint8Array(width * height * 4);
    drawBitmapInto(out, width, height, picture, placement.matrix);
    painted = true;
  }
  return painted ? encodeRgbaPng(width, height, out).toString("base64") : null;
}

function decodeCPicFrame(cursor, registry, ctx) {
  const shapes = [];
  const bitmaps = [];

  const place = (placement) => {
    ctx.symbolInstances.push({ layerIndex: ctx.currentLayerIndex, ...placement });
    return true;
  };

  let flag = 4;
  try {
    flag = readCompositeChildren(cursor, registry, ctx.warnings, (name, child) => {
      if (name === "CPicShape") {
        shapes.push(decodeFrameShapeObject(child, registry, ctx));
        return true;
      }
      if (name === "CPicBitmap") {
        bitmaps.push(decodeCPicBitmap(child, registry, ctx));
        return true;
      }
      if (name === "CPicSprite") {
        return place(decodeCPicSprite(child, registry, ctx));
      }
      if (name === "CPicSymbol") {
        return place(decodeCPicSymbol(child, registry, ctx));
      }
      throw new StopDecode(`${name} inside a frame is not imported`);
    }, { skipUnknown: true });
  } catch (error) {
    if (!(error instanceof StopDecode)) throw error;
    ctx.warnings.add(`a frame's children stopped reading: ${error.message}`);
  }
  const ownShape = readShapeBody(cursor, flag, ctx.warnings);
  shapes.unshift(ownShape);

  // Frame own fields + the optional tween/timeline block. This block is not
  // drawn, so a malformed (or truncated) timeline must not discard the frame's
  // already-parsed shapes. Read what we can and warn on the rest.
  let duration = 1;
  try {
    const frameSchema = cursor.u8();
    duration = cursor.u16();

    if (frameSchema < 3) {
      cursor.u8();
      if (frameSchema === 2) cursor.u16();
    } else {
      cursor.u16();
      cursor.u16();
      if (frameSchema >= 5) {
        cursor.u16();
        if (frameSchema !== 5) {
          const previewCount = cursor.u16();
          cursor.skip(previewCount * 8);
          if (frameSchema !== 6) {
            cursor.u16();
            cursor.u8();
            cursor.u32();
            cursor.u32();
            if (frameSchema !== 7) {
              cursor.u16();
              if (frameSchema !== 8) {
                if (frameSchema >= 0x17) cursor.readString();
                readFrameTimeline(cursor, registry, ctx, frameSchema);
              }
            }
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof StopDecode)) throw error;
    ctx.warnings.add(`a frame's timeline block stopped reading early: ${error.message}`);
  }
  return { duration, shapes, bitmaps };
}


/** * The tween/timeline block of a schema-0x13+ frame (`FUN_1404ff8c0`,
 * LAB_140500119). It carries two format words and their optional coordinate
 * payload, three ids, two optional objects, a script string, and (schema
 * 0x18) six ease tracks. Only the structure matters here: nothing in the
 * block is drawn.
 */
function readFrameTimeline(cursor, registry, ctx, frameSchema) {
  if (frameSchema < 0x13) {
    throw new StopDecode(`a frame with timeline schema ${frameSchema} is not imported`);
  }

  const skipWords = (count, what) => {
    if (count > (cursor.data.length - cursor.at) / 4) {
      throw new StopDecode(`a frame ${what} runs past the page stream`);
    }
    cursor.skip(count * 4);
  };

  const format = cursor.u32();
  const variant = cursor.u32();

  if (format !== 0) {
    cursor.u32();
    skipWords(cursor.u32(), "timeline payload");
    if (variant === 0) {
      cursor.u32();
      skipWords(cursor.u32(), "timeline payload");
    } else if (variant >= 3) {
      throw new StopDecode(`a frame uses an unsupported timeline format ${variant}`);
    } else if (variant === 1 && format >= 4) {
      if (format > 4) cursor.u32();
      cursor.readString();
    }
  } else if (variant !== 1) {
    if (variant === 0) {
      cursor.u32();
      skipWords(cursor.u32(), "timeline payload");
    } else if (variant >= 3) {
      throw new StopDecode(`a frame uses an unsupported timeline format ${variant}`);
    }
  }

  cursor.u32();
  cursor.u32();
  cursor.u32();
  readOptionalObject(cursor, registry, ctx);
  cursor.u32();
  readOptionalObject(cursor, registry, ctx);

  if (frameSchema < 0x17) {
    if (frameSchema !== 0x13) {
      cursor.u32();
      if (frameSchema !== 0x14) cursor.u32();
    }
  } else {
    cursor.readString();
    cursor.u32();
    cursor.u32();
  }

  cursor.u32();
  if (frameSchema >= 0x18) {
    cursor.u32();
    const easeTracks = cursor.u32();
    if (easeTracks !== 0) {
      for (let i = 0; i < 6; i += 1) {
        const segments = cursor.u32();
        if (segments > (cursor.data.length - cursor.at) / 0x30) {
          throw new StopDecode(`frame ease track ${i} runs past the page stream`);
        }
        cursor.skip(segments * 0x30);
      }
    }
  }
}

// Replacement body for decodeCPicLayer â€” deterministic, byte-verified grammar.
// (see docs/fla-re/fla-study.md â€” dispatcher FUN_1404ff8c0, CPicLayer branch)

function decodeCPicLayer(cursor, registry, ctx) {
  const drawings = [];
  let frameAt = 1;
  ctx.currentLayerIndex = ctx.layers.length;

  const addShapes = (shapes, hold, bitmaps = []) => {
    const duration = Math.max(1, hold);
    const strokes = [];
    for (const shape of shapes) shapeToStrokes(shape, strokes, ctx.warnings);
    if (strokes.length || bitmaps.length) {
      drawings.push({
        at: frameAt,
        hold: Math.max(1, Math.min(10000, duration)),
        strokes,
        bitmaps: bitmaps.length ? bitmaps : undefined,
      });
    }
    frameAt += duration;
  };

  const decodeFrameInList = (fname, child) => {
    if (fname === "CPicFrame") {
      const frame = decodeCPicFrame(child, registry, ctx);
      addShapes(frame.shapes, frame.duration, frame.bitmaps);
      return true;
    }
    if (fname === "CPicShape") {
      addShapes([decodeFrameShapeObject(child, registry, ctx)], 1);
      return true;
    }
    if (fname === "CPicSprite") {
      ctx.symbolInstances.push({ layerIndex: ctx.currentLayerIndex, ...decodeCPicSprite(child, registry, ctx) });
      return true;
    }
    if (fname === "CPicSymbol") {
      ctx.symbolInstances.push({ layerIndex: ctx.currentLayerIndex, ...decodeCPicSymbol(child, registry, ctx) });
      return true;
    }
    throw new StopDecode(`${fname} in frame list not imported`);
  };

  const wrapChildError = (fname, child) => {
    trace(`  frame-child ${fname} at=${traceHex(child.at)}`);
    return decodeFrameInList(fname, child);
  };

  try {
    // 1. Layer children list (`FUN_1404fef50`): the list flag, then CPicFrame
    //    records for every exposure the layer holds. Only new-class
    //    declarations dispatch here; object backrefs simply pass by.
    readCompositeChildren(cursor, registry, ctx.warnings, wrapChildError, { skipUnknown: true });
  } catch (error) {
    if (!(error instanceof StopDecode)) throw error;
    ctx.warnings.add(`frame list children stopped: ${error.message}`);
  }

  // 2. Layer own fields (`FUN_1404ff8c0` layer branch).
  let name = "";
  let current = false;
  let locked = false;
  let hidden = false;
  let layerType = 0;
  try {
    const schema = cursor.u8();
    name = cursor.readString();

    let c8 = 0;
    if (schema < 4) {
      cursor.skip(1); // legacy field, unused
    } else if (schema <= 0x1e) {
      const d4 = cursor.u8();
      const d0 = cursor.u8();
      const cc = cursor.u8();
      if (schema === 0x0b) {
        // Flash 8 layer state. Byte-verified against the Umoupen DOM dump:
        // the d0 byte drives `visible="false"` (Layer 1 of the reference file
        // stores 1 there and is hidden in the ground truth), the cc byte
        // drives `locked`, and d4==1 marks the current/selected layer.
        current = d4 === 1;
        hidden = d0 !== 0;
        locked = cc !== 0;
        cursor.u32(); // b8
        cursor.u32(); // b4
        cursor.u32(); // b0
        cursor.u32(); // ac (schema >= 8 always reads this too)
      } else if (schema >= 5) {
        cursor.u32(); // always 0xFFFFFFFF
        if (schema >= 6) {
          cursor.u32(); // outline colour R,G,B,A
          cursor.u32(); // outline mode
        }
        if (schema >= 8) cursor.u32(); // height multiplier
        // CS3-era state bytes: byte0 doubles as the layer type.
        current = d4 === 1;
        locked = d0 !== 0;
        hidden = cc !== 0;
        layerType = d4; // 0 normal, 1 guide, 3 mask, 4 masked, 5 folder
      } else {
        // schema 4: the three bytes carry no state TVMini keeps.
        void d4;
        void d0;
        void cc;
      }
    }

    // Tail: mode byte, parent reference, then the schema ladder.
    c8 = cursor.u8();
    const parent = readOptionalObject(cursor, registry, ctx);
    if (schema === 7 || schema === 8) {
      readOptionalObject(cursor, registry, ctx);
      cursor.skip(1);
    } else if (schema >= 2) {
      if (schema <= 5) {
        cursor.skip(1);
        cursor.skip(1); // (schema - 3) is always < 6 here
      } else if (schema <= 8) {
        cursor.skip(1); // schema 6 (7/8 handled above)
      } else if (schema >= 9) {
        cursor.u8(); // c4
        if (schema !== 9) {
          cursor.u8(); // c0
          if (schema === 0x0d) {
            const cs4 = cursor.u8();
            if (cs4 >= 2) throw new StopDecode(`unsupported CS4 layer animation type ${cs4}`);
          } else if (schema === 0x0b) {
            // Flash 8 layer mode remap (DAT_141e2d4bd = {1,0,5,3}).
            if (c8 < 2 || c8 === 3) {
              const index = c8 - 1;
              if (index > 3) {
                layerType = 0;
              } else {
                layerType = [1, 0, 5, 3][index];
              }
            } else if (c8 === 4) {
              layerType = 3;
            } else {
              throw new StopDecode(`unsupported Flash 8 layer mode ${c8}`);
            }
          }
        }
      }
    }
    void parent;
  } catch (error) {
    if (!(error instanceof StopDecode)) throw error;
    ctx.warnings.add(`layer own fields stopped: ${error.message}`);
  }

  const description =
    layerType === 1 ? "guide" :
    layerType === 3 ? "mask" :
    layerType === 4 ? "masked" :
    layerType === 5 ? "folder" : "anim";
  return {
    name: name || `Layer ${ctx.layers.length + 1}`,
    type: description,
    visible: !hidden,
    locked,
    current: current || undefined,
    opacity: 1,
    blend: "normal",
    preBehavior: "none",
    postBehavior: "none",
    clip: false,
    parent: -1,
    drawings,
  };
}

function decodeCPicPage(cursor, registry, ctx) {
  // The page record (`FUN_1404ff8c0`, CPicPage branch): its children list â€”
  // every `CPicLayer` of the document, bottom first â€” then its own fields: a
  // version byte, schema-dependent counts, and the version-3/5+ entry block.
  readCompositeChildren(cursor, registry, ctx.warnings, (name, child) => {
    if (name === "CPicLayer") {
      ctx.layers.push(decodeCPicLayer(child, registry, ctx));
      return true;
    }
    throw new StopDecode(`${name} at a page's top level is not imported`);
  }, { skipUnknown: true });

  try {
    const version = cursor.u8();
    if (version !== 4) {
      const first = cursor.u16();
      if (version < 5 && version !== 3) return;
      if (version >= 5) {
        cursor.u16();
        if (version > 6) cursor.u32();
      }
      void first;
    }
    const entryCount = cursor.u32();
    if (entryCount > (cursor.data.length - cursor.at) / 8) {
      throw new StopDecode(`the page declares ${entryCount} entries past the stream`);
    }
    for (let i = 0; i < entryCount; i += 1) {
      cursor.u32();
      cursor.u32();
    }
  } catch (error) {
    if (!(error instanceof StopDecode)) throw error;
    ctx.warnings.add(`the page's own fields stopped reading: ${error.message}`);
  }
}

export function decodeFlaPage(pageBytes, media = new Map() /* registry param is unused */) {
  const cursor = new BinaryCursor(pageBytes);
  const warnings = new Set();
  const ctx = {
    warnings,
    layers: [],
    media,
    mediaCache: new Map(),
    symbolInstances: [],
  };
  // Class ids are per-stream: each stream's own `0xffff` declarations number
  // from 1, so page and symbol streams never share id spaces.
  const reg = new ClassRegistry();

  try {
    if (cursor.u8() !== 0x01) throw new StopDecode("the page stream does not start with the archive marker");
    const pageTag = cursor.readClassTag();
    if (pageTag.kind !== "class" || pageTag.name !== "CPicPage") {
      throw new StopDecode("the page stream does not start with a CPicPage object");
    }
    reg.register(pageTag.name);
    decodeCPicPage(cursor, reg, ctx);
  } catch (error) {
    if (!(error instanceof StopDecode)) throw error;
    warnings.add(`${error.message}; everything before it was imported`);
  }

  // The Page stream lists layers bottom first; a TVMini project keeps the
  // topmost layer at index 0, the way the Flash timeline shows it.
  const active = ctx.layers.findIndex((layer) => layer.current);
  ctx.layers.reverse();
  const currentLayer = active === -1 ? 0 : ctx.layers.length - 1 - active;
  for (const layer of ctx.layers) delete layer.current;

  // Symbol placements collected while decoding layers; carry the final layer
  // index (after the bottom-to-top reversal) so the parser can flatten them.
  const totalLayers = ctx.layers.length;
  const symbolInstances = [];
  for (const inst of ctx.symbolInstances ?? []) {
    symbolInstances.push({ ...inst, layerIndex: totalLayers - 1 - inst.layerIndex });
  }

  return {
    layers: ctx.layers,
    currentLayer,
    warnings: [...warnings],
    media: ctx.media,
    mediaCache: ctx.mediaCache,
    bytesRead: cursor.at,
    bytesTotal: pageBytes.length,
    symbolInstances,
  };
}

/** Extract class declarations from a stream to build a shared registry. */
export function buildClassRegistry(stream) {
  const cursor = new BinaryCursor(stream);
  const registry = new ClassRegistry();
  if (cursor.u8() !== 0x01) return registry; // no archive marker
  while (!cursor.eof()) {
    const tag = cursor.readClassTag();
    if (tag.kind === "terminator") break;
    if (tag.kind === "class") {
      registry.register(tag.name);
      // Skip flag-dependent payload if any (we don't know the flag here, but
      // class declarations in Contents stream typically have no extra payload).
    } else if (tag.kind === "object" || tag.kind === "backref") {
      // Object data starts; class store is done.
      break;
    }
  }
  return registry;
}

export function binaryPageToProject(name, { page, stage, document }) {
  const warnings = [...(page.warnings ?? [])];
  const media = page.media ?? new Map();
  const cache = page.mediaCache ?? new Map();

  // Sanitize layer names: binary .fla streams can produce garbage or duplicate
  // names. TVMini requires names to be 1-80 trimmed characters and unique.
  const seen = new Set();
  let layerIndex = 0;
  for (const layer of page.layers) {
    let clean = String(layer.name ?? "")
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
      .trim()
      .slice(0, 80);
    if (!clean) clean = `Layer ${layerIndex + 1}`;
    if (seen.has(clean)) {
      let n = 2;
      while (seen.has(`${clean} ${n}`.slice(0, 80))) n += 1;
      clean = `${clean} ${n}`.slice(0, 80);
    }
    seen.add(clean);
    layer.name = clean;
    layerIndex += 1;
  }

  for (const layer of page.layers) {
    for (const drawing of layer.drawings) {
      if (!drawing.bitmaps?.length) {
        delete drawing.bitmaps;
        continue;
      }
      const image = composeCellBitmaps(
        drawing.bitmaps,
        media,
        cache,
        stage.width,
        stage.height,
        { add: (message) => warnings.push(message) },
      );
      if (image) {
        drawing.image = { data: image, width: stage.width, height: stage.height };
      }
      delete drawing.bitmaps;
    }
  }

  const project = {
    format: "tvmini",
    version: 3,
    width: stage.width,
    height: stage.height,
    background: document?.background ?? "#ffffff",
    fps: document?.fps ?? 24,
    startFrame: 1,
    currentLayer: page.currentLayer ?? 0,
    currentFrame: 1,
    loop: true,
    camera: null,
    audio: null,
    layers: page.layers,
  };
  takeCameraLayers(project, stage, warnings);
  if (warnings.length) project.warnings = warnings;
  return project;
}

/**
 * The virtual camera of a Flash file, made into the camera of the project.
 *
 * Flash had no camera of its own: animators put a shape — the viewfinder, a
 * rectangle over the stage, usually black, on a layer named after a camera —
 * and let ActionScript move that shape while the film played. The shape is
 * not artwork and covers everything, so as an imported layer it would only
 * paint itself over the scene. Here the layer is recognised, its viewfinder
 * rectangles become the keyframes of the camera track (one per frame the
 * layer shows one), and the layer itself is taken out.
 *
 * A layer qualifies when its name speaks of a camera ("Cam", "Camera",
 * "V-Cam", …) and its shapes are closed fills that cover most of the stage;
 * a name that only says "cam" must also fill near-black, so that an artwork
 * layer that happens to be called Cam is left alone.
 */
function takeCameraLayers(project, stage, warnings) {
  const nameSaysCamera = /(^|[^a-z])(v-?cam(era)?|cam(era)?)([^a-z]|$)/i;
  const explicit = /v-?cam(era)?|camera/i;
  const nearBlack = (hex) => {
    const value = String(hex ?? "").replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return false;
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 <= 0.12;
  };
  const boundsOf = (drawing) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of drawing.strokes ?? []) {
      if (stroke.kind !== "paths" && stroke.kind !== "path") continue;
      const walk = (point) => {
        if (typeof point[0] === "number" && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
          if (point[0] < minX) minX = point[0];
          if (point[1] < minY) minY = point[1];
          if (point[0] > maxX) maxX = point[0];
          if (point[1] > maxY) maxY = point[1];
        } else for (const child of point) walk(child);
      };
      for (const point of stroke.paths ?? stroke.points ?? []) walk(point);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX, minY, maxX, maxY };
  };

  const taken = [];
  const keys = [];
  for (let index = project.layers.length - 1; index >= 0; index -= 1) {
    const layer = project.layers[index];
    if (!nameSaysCamera.test(layer.name ?? "")) continue;
    const drawings = layer.drawings ?? [];
    if (drawings.length === 0) continue;
    const wantsBlack = !explicit.test(layer.name ?? "");
    const frames = [];
    let covered = true;
    for (const drawing of drawings) {
      const bounds = boundsOf(drawing);
      if (!bounds) { covered = false; break; }
      const width = bounds.maxX - bounds.minX;
      const height = bounds.maxY - bounds.minY;
      if (width < stage.width * 0.6 || height < stage.height * 0.6) { covered = false; break; }
      if (wantsBlack) {
        const black = (drawing.strokes ?? []).some((stroke) => nearBlack(stroke.color));
        if (!black) { covered = false; break; }
      }
      frames.push({
        frame: Math.max(1, Math.round(drawing.at ?? 1)),
        x: Math.round(Math.max(0, bounds.minX)),
        y: Math.round(Math.max(0, bounds.minY)),
        width: Math.max(1, Math.round(Math.min(width, stage.width * 4))),
        height: Math.max(1, Math.round(Math.min(height, stage.height * 4))),
        rotation: 0,
        interp: "linear",
      });
    }
    if (!covered || frames.length === 0) continue;
    keys.push(...frames);
    taken.push(layer.name);
    project.layers.splice(index, 1);
  }
  if (taken.length === 0) return;
  // One key per frame: the layers were walked from the top of the stack, so
  // the topmost camera layer wins a frame that two of them both show.
  const byFrame = new Map();
  for (const key of keys) {
    if (!byFrame.has(key.frame)) byFrame.set(key.frame, key);
  }
  project.camera = { keys: [...byFrame.values()].sort((a, b) => a.frame - b.frame) };
  warnings.push(
    `the camera layer ${taken.map((name) => `"${name}"`).join(", ")} became ` +
      `${project.camera.keys.length} camera keyframe${project.camera.keys.length === 1 ? "" : "s"} ` +
      "on the camera track (the viewfinder of a Flash virtual camera is not artwork)",
  );
}
export { BinaryCursor, StopDecode, readShapeBody, shapeToStrokes, composeCellBitmaps };
