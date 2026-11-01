/**
 * TVPaint `.tvpp` reader and writer, implemented for TVMini from a
 * reverse-engineered byte grammar.
 *
 * The grammar was mapped by studying MoArt's public browser build as
 * documentation of the byte layout (its own notes describe validation
 * against real TVPaint files). No code was copied; this module is written
 * fresh for TVMini. Fact levels follow the project convention: the byte
 * grammar below matches real .tvpp files (cross-checked through that
 * documented validation); where the format allows multiple encodings and
 * we picked one (writing every new image as an uncompressed DBOD chunk) it
 * is marked INFERRED and waits for one true TVPaint round-trip.
 *
 * Container layout (observed):
 *   [16B node GUID][BE32 reserved=0][BE32 size][body]  — nested freely
 *   project node -> { meta node, scene node }
 *   scene node   -> { shot-info node, drawing node }
 *   drawing node -> { annotation node, media node }
 *   media node   -> { `FORM` `TVPP` IFF chunk with the media data }
 * The meta node carries key/value text records; the project-level meta has
 * Width/Height/FrameRate/StartFrame and the layer metadata.
 *
 * IFF chunk layout: [4CC ascii][BE32 size][body][pad byte to even size].
 * Inside `FORM TVPP` the chunk order observed:
 *   DGBL DPEL DLOC BGMD ARAT CRLR BGP1 BGP2 FRAT FILD MARK XSHT TLNT
 *   per layer: LNAM LNAW LRHD <frame chunks...> LEXT UDAT  then STCK XSRC.
 *
 * Frame chunks: images appear either as `ZCHK` wrappers around
 * `DBOD`/`SRAW`, or — in files saved without compression — as bare
 * `DBOD`/`SRAW` chunks. Both decode identically: the image payload always
 * starts with [4CC][BE32 payloadSize] followed by the data, so the
 * unwrapped `ZCHK` content and a bare chunk have the same shape. Small
 * `SRAW` stubs are directives:
 *   body words [6][1][0]       -> frame repeats the previous frame's image
 *   body words [2][0][b]       -> frame reuses history image number b
 *   body words [5][0][0][0][0] -> explicitly empty frame
 * Full image payloads:
 *   DBOD = a PackBits-32 stream of w*h BGRA *premultiplied* pixels in
 *          row-major frame order (runs may cross 64x64 tile borders).
 *   SRAW = [BE32 x][BE32 thumbLen][thumb bytes][BE32 tileCount] then per
 *          tile [BE32 len] + (len ? PackBits tile data : [BE32 sel]
 *          [BE32 index]) where sel=0 reuses tile `index` of this same
 *          image and sel=1 of the previous image.
 * PackBits-32 codes: 0..127 = literal run of n+1 pixels (4 bytes each);
 * 129..255 = repeat one pixel 257-n times; 128 = skip. Pixels are BGRA.
 * LRHD layer header (26 BE32 words), the ones we use:
 *   [1]=first frame [2]=last frame [3]=frame count [4]=opacity*255
 *   [7]&1=layer hidden [11]=post*65536+pre (none 0, repeat 1, hold 3)
 *   [15]=blend code (we write 0, "Color") [16]=65537
 */

import { Buffer } from "./bytes.js";
import { inflateSync } from "./zlib.js";
import { encodeRgbaPng, renderDrawingRgba } from "./png.js";
import { createLayer, createProject, normalizeProject } from "./model.js";

const TVPP_TILE = 64;
const FORMAT_TVPP = "TVPP";

const GUID_PROJECT = "3384780ebc4011d785af00105aafaaab";
const GUID_META = "3385553abc4011d79e7c00105aafaaab";
const GUID_SCENE = "338631b2bc4011d7896e00105aafaaab";
const GUID_SHOT = "3388da98bc4011d794b100105aafaaab";
const GUID_DRAWING = "3389b846bc4011d79efe00105aafaaab";
const GUID_ANNOTATION = "3387e34abc4011d78ee600105aafaaab";
const GUID_MEDIA = "33871154bc4011d780a400105aafaaab";
const GUID_FRAME_LIST = "588a9280b5cb4a0b84b01b852747d9a1";
const GUID_FRAME = "b2427e3f511d45fd827e49fc31668337";

const TVPP_BEHAVIOR = { none: 0, repeat: 1, hold: 3 };

/* ------------------------------------------------------------------ bytes */

function be16(out, value) {
  out.push((value >> 8) & 0xff, value & 0xff);
}

function be32(out, value) {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function asciiInto(out, text) {
  for (const char of text) out.push(char.charCodeAt(0) & 0xff);
}

function utf8Into(out, text) {
  for (const byte of Buffer.from(text, "utf8")) out.push(byte & 0xff);
}

/** One IFF chunk: [4CC][BE32 size][body][pad to even]. Small only. */
function iffChunk(tag, body) {
  const head = [];
  asciiInto(head, tag);
  be32(head, body.length);
  const out = Buffer.alloc(head.length + body.length + (body.length % 2));
  let at = 0;
  for (const byte of head) out[at++] = byte;
  out.set(body, at);
  return out;
}

/** One container node: [16B guid][BE32 0][BE32 size][body]. */
function node(guid, parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = Buffer.alloc(24 + size);
  for (let i = 0; i < 16; i += 1) out[i] = parseInt(guid.slice(i * 2, i * 2 + 2), 16);
  out.writeUInt32BE(0, 16);
  out.writeUInt32BE(size, 20);
  let at = 24;
  for (const part of parts) {
    if (part.length) out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Key/value text records: [BE32 pair count][BE16 len][UTF-16BE chars] x2. */
function stringRecords(pairs) {
  const out = [];
  be32(out, pairs.length);
  for (const [key, value] of pairs) {
    for (const text of [String(key), String(value)]) {
      be16(out, text.length);
      for (const char of text) be16(out, char.charCodeAt(0));
    }
  }
  return Buffer.from(out);
}

/**
 * Encode `pixelCount` premultiplied BGRA pixels (in `bgra`) as a
 * PackBits-32 stream. Codes: 0..127 literal (n+1 pixels), 129..255 repeat
 * (257-n copies of one pixel), 128 skip (never emitted).
 */
function encodePackBits32(bgra, pixelCount) {
  const parts = [];
  let literalStart = 0;
  let cursor = 0;

  const samePixel = (a, b) =>
    bgra[a * 4] === bgra[b * 4] &&
    bgra[a * 4 + 1] === bgra[b * 4 + 1] &&
    bgra[a * 4 + 2] === bgra[b * 4 + 2] &&
    bgra[a * 4 + 3] === bgra[b * 4 + 3];

  const pushRun = (at, take) => {
    const head = Buffer.from([257 - take]);
    const pixel = Buffer.from(bgra.subarray(at * 4, at * 4 + 4));
    parts.push(head, pixel);
  };

  const flushLiterals = (until) => {
    let start = literalStart;
    while (start < until) {
      const take = Math.min(128, until - start);
      parts.push(Buffer.from([take - 1]), Buffer.from(bgra.subarray(start * 4, (start + take) * 4)));
      start += take;
    }
  };

  let scan = cursor;
  while (scan < pixelCount) {
    let run = 1;
    while (scan + run < pixelCount && samePixel(scan, scan + run)) run += 1;
    if (run < 3) {
      scan += 1;
      continue;
    }
    flushLiterals(scan);
    for (let left = run; left > 0; left -= 128) pushRun(scan, Math.min(128, left));
    scan += run;
    literalStart = scan;
    cursor = scan;
  }
  flushLiterals(pixelCount);
  return Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
}

/** Straight-alpha RGBA -> premultiplied BGRA, then PackBits-32. */
function encodeImagePayload(rgba, width, height) {
  const pixels = width * height;
  const bgra = Buffer.alloc(pixels * 4);
  for (let i = 0, j = 0; i < pixels; i += 1, j += 4) {
    const a = rgba[j + 3];
    if (a === 0) continue;
    bgra[j] = Math.round((rgba[j + 2] * a) / 255);
    bgra[j + 1] = Math.round((rgba[j + 1] * a) / 255);
    bgra[j + 2] = Math.round((rgba[j] * a) / 255);
    bgra[j + 3] = a;
  }
  return encodePackBits32(bgra, pixels);
}

/** Bare (uncompressed) DBOD frame chunk with IFF even padding. */
function tvppDbodChunk(rgba, width, height) {
  const payload = encodeImagePayload(rgba, width, height);
  const out = Buffer.alloc(8 + payload.length + (payload.length % 2));
  out.write("DBOD", 0, "ascii");
  out.writeUInt32BE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}

/** [SRAW][12][6][1][0] — repeat the previous frame's image. */
function tvppSameChunk() {
  const head = [];
  asciiInto(head, "SRAW");
  be32(head, 12);
  be32(head, 6);
  be32(head, 1);
  be32(head, 0);
  return Buffer.from(head);
}

/** [SRAW][20][5][0][0][0][0] — this frame is empty. */
function tvppEmptyChunk() {
  const head = [];
  asciiInto(head, "SRAW");
  be32(head, 20);
  be32(head, 5);
  be32(head, 0);
  be32(head, 0);
  be32(head, 0);
  be32(head, 0);
  return Buffer.from(head);
}

function isBlankRgba(rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return false;
  }
  return true;
}

/**
 * Write one layer's chunks covering every frame in [first..last]. Every
 * frame gets an image entry (full DBOD / repeat stub / empty stub) so the
 * image-local indices stay aligned with the frame numbers; held exposures
 * become repeat stubs that read back as one drawing with hold, and blank
 * drawings become empty frames.
 */
function tvppLayerChunks(project, layer, first, last) {
  const chunks = [];

  const name = String(layer.name || "Layer").replace(/\0/g, "");
  const nameAscii = name.replace(/[^\x20-\x7e]/g, "_");
  chunks.push(iffChunk("LNAM", Buffer.from(`${nameAscii}\0`, "utf8")));
  chunks.push(iffChunk("LNAW", Buffer.from(`${name}\0`, "utf8")));

  const behaviorCode = (value) => {
    const code = TVPP_BEHAVIOR[value];
    return code === undefined ? TVPP_BEHAVIOR.hold : code;
  };

  const words = new Array(26).fill(0);
  words[0] = 1;
  words[1] = first;
  words[2] = last;
  words[3] = last - first + 1;
  words[4] = Math.min(255, Math.max(0, Math.round(layer.opacity * 255)));
  words[7] = layer.visible === false ? 1 : 0;
  words[11] = behaviorCode(layer.postBehavior) * 65536 + behaviorCode(layer.preBehavior);
  words[13] = 1;
  words[15] = 0; // blend code: TVPaint "Color"
  words[16] = 65537;
  const header = [];
  for (const word of words) be32(header, word);
  chunks.push(iffChunk("LRHD", Buffer.from(header)));

  // Logical frame plan first, then emit chunks from it.
  const plan = [];
  let nextDrawing = 0;
  for (let frame = first; frame <= last; frame += 1) {
    while (
      nextDrawing < layer.drawings.length &&
      layer.drawings[nextDrawing].at + layer.drawings[nextDrawing].hold <= frame
    ) {
      nextDrawing += 1;
    }
    const drawing = layer.drawings[nextDrawing];
    if (!drawing || drawing.at > frame) {
      plan.push({ kind: "empty" });
    } else if (drawing.at === frame) {
      const rgba = renderDrawingRgba(project, drawing);
      plan.push(
        isBlankRgba(rgba)
          ? { kind: "empty" }
          : { kind: "full", rgba },
      );
    } else {
      plan.push({ kind: "same" });
    }
  }

  // Emit chunks and collect the LEXT naming entries in one pass.
  const iniEntries = [];
  let imageIndex = 0;
  plan.forEach((entry, position) => {
    if (entry.kind === "empty") {
      chunks.push(tvppEmptyChunk());
    } else if (entry.kind === "same") {
      chunks.push(tvppSameChunk());
    } else {
      chunks.push(tvppDbodChunk(entry.rgba, project.width, project.height));
      iniEntries.push(`${imageIndex}=${name}-c${first + position}`);
      imageIndex += 1;
    }
  });

  const ini =
    "\ufeff[Images Name]\n" +
    iniEntries.join("\n") +
    "\n\n[Images Auid]\n" +
    Array.from({ length: imageIndex }, (_, index) => `${index}=tvmini-${index}`).join("\n") +
    "\n\n";
  chunks.push(iffChunk("LEXT", Buffer.from(ini, "utf8")));

  // UDAT node: one frame-record node per frame in this layer's range.
  const record = node(GUID_FRAME, [Buffer.from([0, 0, 0, 0])]);
  chunks.push(
    iffChunk("UDAT", node(GUID_FRAME_LIST, Array.from({ length: last - first + 1 }, () => record))),
  );

  return chunks;
}

/**
 * Export a validated project as a `.tvpp` byte buffer.
 *
 * INFERRED for real TVPaint: images are written uncompressed (bare DBOD
 * chunks — a variant real files contain when the save options disable
 * compression), and optional chunks we do not model (ANNO, camera entries
 * in FCFG, audio refs, TLNT tail room) are simply omitted. TVPaint reads
 * compressed `ZCHK` files and bare files alike, but this needs one round
 * trip through real TVPaint before we claim full fidelity.
 */
export function createTvppBuffer(project) {
  const width = project.width;
  const height = project.height;

  let frameCount = 1;
  for (const layer of project.layers) {
    for (const drawing of layer.drawings) {
      frameCount = Math.max(frameCount, drawing.at + drawing.hold - 1);
    }
  }

  const media = [Buffer.from(FORMAT_TVPP, "ascii")];

  const pushChunk = (tag, body) => media.push(iffChunk(tag, body));

  const dbl = [];
  be16(dbl, width);
  be16(dbl, height);
  be16(dbl, 1);
  dbl.push(128, 128);
  pushChunk("DGBL", Buffer.from(dbl));

  pushChunk(
    "DPEL",
    Buffer.from([0, 0, 0, 4, 0, 3, 0, 8, 0, 2, 0, 8, 0, 1, 0, 8, 0, 17, 0, 8]),
  );

  const dloc = [];
  be16(dloc, width);
  be16(dloc, height);
  be16(dloc, 0);
  be16(dloc, 0);
  pushChunk("DLOC", Buffer.from(dloc));

  const bgmd = [];
  be32(bgmd, 8);
  pushChunk("BGMD", Buffer.from(bgmd));

  const arat = [];
  be32(arat, 1000000);
  be32(arat, 1000000);
  pushChunk("ARAT", Buffer.from(arat));

  pushChunk("CRLR", Buffer.from([0, 0, 0, 0]));
  pushChunk("BGP1", Buffer.from([255, 255, 255, 255]));
  pushChunk("BGP2", Buffer.from([240, 240, 240, 255]));

  const frat = [];
  be32(frat, Math.round(project.fps * 1000));
  pushChunk("FRAT", Buffer.from(frat));

  const fild = [];
  be32(fild, 5);
  be32(fild, 1);
  pushChunk("FILD", Buffer.from(fild));

  pushChunk("MARK", Buffer.alloc(0));

  const xsht = [];
  be32(xsht, 0);
  be32(xsht, 0);
  be32(xsht, 5000);
  pushChunk("XSHT", Buffer.from(xsht));

  const tlnt = [];
  be32(tlnt, 512);
  be32(tlnt, 200);
  be32(tlnt, 40);
  pushChunk("TLNT", Buffer.concat([Buffer.from(tlnt), Buffer.alloc(68)]));

  // TVPaint layer 1 is topmost, exactly like our layers[0].
  for (const layer of project.layers) {
    if (layer.drawings.length === 0) continue;
    const first = Math.max(project.startFrame, layer.drawings[0].at);
    const last = layer.drawings.reduce(
      (max, drawing) => Math.max(max, drawing.at + drawing.hold - 1),
      first,
    );
    media.push(...tvppLayerChunks(project, layer, first, last));
  }

  pushChunk("STCK", Buffer.from("\ufeff[stack]\ncount=0\n\n", "utf8"));
  pushChunk("XSRC", Buffer.from("\ufeff[xsheet sources]\ncount=0\n\n", "utf8"));

  const mediaBody = Buffer.concat(media);
  const mediaChunk = iffChunk("FORM", mediaBody);

  const meta = stringRecords([
    ["Width", String(width)],
    ["Height", String(height)],
    ["FrameRate", (project.fps ? project.fps : 24).toFixed(6)],
    ["PixelAspectRatio", "1.000000"],
    ["FieldOrder", "0"],
    ["StartFrame", "1"],
    ["UniqueID", projectMetaId()],
    ["Shots", "1"],
    ["Drawings", String(project.layers.length)],
    ["Name", "TVMini project"],
  ]);

  const title = stringRecords([
    ["Name", "TVMini project"],
    ["Dialog", ""],
    ["Action", ""],
    ["Note", ""],
    ["DialogSize", "12"],
    ["ActionSize", "12"],
    ["NoteSize", "12"],
    ["MarkIn", "1"],
    ["MarkInPosition", "0"],
    ["MarkOut", "1"],
    ["MarkOutPosition", String(frameCount - 1)],
    ["Hidden", "0"],
    ["ColorIdx", "0"],
  ]);

  const shot = stringRecords([["Name", "TVMini project"], ["Drawings", "1"]]);

  function projectMetaId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `tvmini-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }

  return node(GUID_PROJECT, [
    node(GUID_META, [meta]),
    node(GUID_SCENE, [
      node(GUID_SHOT, [shot]),
      node(GUID_DRAWING, [
        node(GUID_ANNOTATION, [title]),
        node(GUID_MEDIA, [mediaChunk]),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ reading */

/** Walk nested [GUID][BE32 0][BE32 size][body] records. */
function walkNodes(buf, offset, end, depth, records) {
  while (offset + 24 <= end) {
    const size = buf.readUInt32BE(offset + 20);
    if (size <= 0 || offset + 24 + size > end) break;
    records.push({
      guid: buf.subarray(offset, offset + 16).toString("hex"),
      body: offset + 24,
      size,
      depth,
    });
    if (depth < 24) walkNodes(buf, offset + 24, offset + 24 + size, depth + 1, records);
    offset += 24 + size;
  }
}

/** Collect the IFF chunks inside the `FORM TVPP` media chunk at formStart. */
function mediaChunks(buf, formStart) {
  const formSize = buf.readUInt32BE(formStart + 4);
  const end = formStart + 8 + formSize;

  const chunks = [];
  const CONTAINER = new Set(["FORM", "LIST", "CAT ", "PROP"]);
  const walk = (start, stop) => {
    while (start + 8 <= stop) {
      const id = buf.toString("ascii", start, start + 4);
      const size = buf.readUInt32BE(start + 4);
      if (start + 8 + size > stop) break;
      if (CONTAINER.has(id)) walk(start + 12, start + 8 + size);
      else chunks.push({ id, off: start + 8, size });
      start += 8 + size + (size & 1);
    }
  };
  walk(formStart + 12, end); // formStart+8 is the 'TVPP' genre match
  return chunks;
}

/**
 * Un-premultiplication: TVPaint stores premultiplied BGRA. Our canvas model
 * wants straight RGBA. The table applies the same rounding as the files
 * expect (float32 reciprocal, then round half to even).
 */
const UNPRE = (() => {
  const table = new Uint8Array(256 * 256);
  for (let a = 1; a < 256; a += 1) {
    const recip = Math.fround(255 / a);
    for (let p = 0; p < 256; p += 1) {
      const x = Math.fround(p * recip);
      const f = Math.floor(x);
      const d = x - f;
      let v;
      if (d > 0.5) v = f + 1;
      else if (d < 0.5) v = f;
      else v = f % 2 === 0 ? f : f + 1;
      table[a * 256 + p] = v > 255 ? 255 : v;
    }
  }
  return table;
})();

/** Decode PackBits-32 into a linear premultiplied BGRA buffer. */
function decodePackBits(src, start, end, want) {
  const out = Buffer.alloc(want * 4);
  let cursor = start;
  let written = 0;
  while (cursor < end && written < want) {
    const code = src[cursor];
    cursor += 1;
    if (code === 128) continue;
    if (code < 128) {
      const count = code + 1;
      const take = Math.min(count, want - written);
      if (cursor + 4 * count > end) break;
      src.copy(out, written * 4, cursor, cursor + take * 4);
      cursor += 4 * count;
      written += take;
    } else {
      const count = 257 - code;
      const take = Math.min(count, want - written);
      if (cursor + 4 > end) break;
      Buffer.from(src.subarray(cursor, cursor + 4)).copy(out, written * 4);
      for (let i = 1; i < take; i += 1) {
        src.subarray(cursor, cursor + 4).copy(out, (written + i) * 4);
      }
      cursor += 4;
      written += take;
    }
  }
  return { data: out, written };
}

/** Split the linear stream across 64x64 tiles, row-major. */
function decodeTiles(stream, width, height) {
  const pixels = width * height;
  const gx = Math.ceil(width / TVPP_TILE);
  const gy = Math.ceil(height / TVPP_TILE);
  const tiles = [];
  for (let k = 0; k < gx * gy; k += 1) {
    const r = Math.floor(k / gx);
    const c = k % gx;
    const tw = Math.min(TVPP_TILE, width - c * TVPP_TILE);
    const th = Math.min(TVPP_TILE, height - r * TVPP_TILE);
    tiles.push(Buffer.alloc(tw * th * 4));
  }

  const decoded = decodePackBits(stream, 8, stream.length, pixels);
  if (decoded.written !== pixels) return null;

  for (let n = 0; n < pixels; n += 1) {
    const y = Math.floor(n / width);
    const x = n % width;
    const c = Math.floor(x / TVPP_TILE);
    const r = Math.floor(y / TVPP_TILE);
    const tw = Math.min(TVPP_TILE, width - c * TVPP_TILE);
    const src = decoded.data.subarray(n * 4, n * 4 + 4);
    src.copy(tiles[r * gx + c], ((y % TVPP_TILE) * tw + (x % TVPP_TILE)) * 4);
  }
  return tiles;
}

/** Decode a full SRAW frame: thumbnail, per-tile references and data. */
function decodeSrawTiles(stream, width, height, previous) {
  const thumbLen = stream.readUInt32BE(12);
  let cursor = 16 + thumbLen;
  if (cursor + 4 > stream.length) return null;
  const gx = Math.ceil(width / TVPP_TILE);
  const gy = Math.ceil(height / TVPP_TILE);
  const count = stream.readUInt32BE(cursor);
  if (count !== gx * gy) return null;
  cursor += 4;

  const tiles = [];
  for (let k = 0; k < count; k += 1) {
    const len = stream.readUInt32BE(cursor);
    if (len === 0) {
      const sel = stream.readUInt32BE(cursor + 4);
      const index = stream.readUInt32BE(cursor + 8);
      cursor += 12;
      if (sel === 0) {
        if (index >= k) return null;
        tiles.push(tiles[index]);
      } else if (sel === 1) {
        if (!previous || index >= previous.length) return null;
        tiles.push(previous[index]);
      } else return null;
    } else {
      const r = Math.floor(k / gx);
      const c = k % gx;
      const tw = Math.min(TVPP_TILE, width - c * TVPP_TILE);
      const th = Math.min(TVPP_TILE, height - r * TVPP_TILE);
      const decoded = decodePackBits(stream, cursor + 4, cursor + 4 + len, tw * th);
      if (decoded.written !== tw * th) return null;
      tiles.push(decoded.data);
      cursor += 4 + len;
    }
  }
  return tiles;
}

/** Assemble tiles into straight-alpha RGBA (un-premultiply happens here). */
function assembleTiles(tiles, width, height) {
  const gx = Math.ceil(width / TVPP_TILE);
  const out = Buffer.alloc(width * height * 4);
  for (let k = 0; k < tiles.length; k += 1) {
    const tile = tiles[k];
    if (!tile) continue;
    const r = Math.floor(k / gx);
    const c = k % gx;
    const tw = Math.min(TVPP_TILE, width - c * TVPP_TILE);
    const th = Math.min(TVPP_TILE, height - r * TVPP_TILE);
    for (let y = 0; y < th; y += 1) {
      const srcRow = (y * tw) * 4;
      const dstRow = ((r * TVPP_TILE + y) * width + c * TVPP_TILE) * 4;
      for (let x = 0; x < tw; x += 1) {
        const s = srcRow + x * 4;
        const d = dstRow + x * 4;
        const a = tile[s + 3];
        if (a === 0) continue;
        out[d] = UNPRE[a * 256 + tile[s + 2]];
        out[d + 1] = UNPRE[a * 256 + tile[s + 1]];
        out[d + 2] = UNPRE[a * 256 + tile[s]];
        out[d + 3] = a;
      }
    }
  }
  return out;
}

/** Payload bytes of a frame chunk, unwrapping `ZCHK` deflate blocks. */
function chunkPayload(buf, frame) {
  if (frame.id === "ZCHK") {
    // body = [tag(4)][usize(4)]['czmp'(4)][size(4)][BE32 blocks][blocks]
    const tag = buf.toString("ascii", frame.off, frame.off + 4);
    const blockCount = buf.readUInt32BE(frame.off + 16);
    const parts = [];
    let p = frame.off + 20;
    for (let i = 0; i < blockCount; i += 1) {
      const packed = buf.readUInt32BE(p + 8);
      parts.push(inflateSync(buf.subarray(p + 12, p + 12 + packed)));
      p += 12 + packed;
    }
    return { tag, data: Buffer.concat(parts) };
  }
  // Bare chunk: [4CC][BE32 size][data...] — same shape as an unwrapped one.
  return {
    tag: frame.id,
    data: buf.subarray(frame.off - 8, frame.off + frame.size),
  };
}

/** Read the [BE32 count][BE16 len][UTF-16BE]... string records. */
function readStringRecords(buf, offset, size) {
  const end = Math.min(buf.length, offset + size);
  const count = buf.readUInt32BE(offset);
  let cursor = offset + 4;
  const items = [];
  while (cursor + 2 <= end && items.length < count * 2) {
    const len = buf.readUInt16BE(cursor);
    cursor += 2;
    if (cursor + len * 2 > end) break;
    let text = "";
    for (let i = 0; i < len; i += 1) text += String.fromCharCode(buf.readUInt16BE(cursor + i * 2));
    items.push(text);
    cursor += len * 2;
  }
  const meta = {};
  for (let k = 0; k + 1 < items.length; k += 2) meta[items[k]] = items[k + 1];
  return meta;
}

/** Null-terminated text chunk: LNAW is UTF-8, LNAM is legacy-encoded. */
function readNameChunk(buf, chunk, utf) {
  const raw = buf.subarray(chunk.off, chunk.off + chunk.size);
  const zero = raw.indexOf(0);
  const body = zero < 0 ? raw : raw.subarray(0, zero);
  if (body.length === 0) return "";
  try {
    return new TextDecoder(utf ? "utf-8" : "shift_jis").decode(body).trim();
  } catch {
    return new TextDecoder("utf-8").decode(body).trim();
  }
}

/**
 * Parse a `.tvpp` buffer. Returns
 * `{ meta, width, height, fps, _buf, layers }` with one entry per layer:
 * `{ name, hidden, opacity, blendCode, start, frames }` where `frames`
 * holds the raw chunk records in order (decode with decodeTvppLayers).
 */
export function readTvpp(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 48) throw new Error("not a .tvpp file (too small)");

  const records = [];
  walkNodes(buf, 0, buf.length, 0, records);
  const formRecord = records.find(
    (record) => buf.toString("ascii", record.body, record.body + 4) === "FORM",
  );
  if (!formRecord) throw new Error(".tvpp has no FORM media");

  const chunks = mediaChunks(buf, formRecord.body);
  const metaNode = records.find((record) => record.guid === GUID_META);
  const meta = metaNode ? readStringRecords(buf, metaNode.body, metaNode.size) : {};

  const one = (id) => chunks.find((chunk) => chunk.id === id) || null;
  const dloc = one("DLOC");
  if (!dloc) throw new Error(".tvpp has no DLOC (canvas size)");
  const width = buf.readUInt16BE(dloc.off);
  const height = buf.readUInt16BE(dloc.off + 2);
  const frat = one("FRAT");
  const fps = frat ? buf.readUInt32BE(frat.off) / 1000 : 24;

  const layers = [];
  let current = null;
  for (const chunk of chunks) {
    if (chunk.id === "LNAM") {
      current = {
        name: readNameChunk(buf, chunk, false),
        hidden: false,
        opacity: 255,
        blendCode: 0,
        start: 1,
        frames: [],
      };
      layers.push(current);
    } else if (current && chunk.id === "LNAW") {
      const wide = readNameChunk(buf, chunk, true);
      if (wide) current.name = wide;
    } else if (current && chunk.id === "LRHD") {
      current.start = chunk.size >= 8 ? buf.readUInt32BE(chunk.off + 4) : 1;
      current.opacity = chunk.size >= 20 ? buf.readUInt32BE(chunk.off + 16) : 255;
      current.hidden = chunk.size >= 32 && (buf.readUInt32BE(chunk.off + 28) & 1) === 1;
      current.blendCode = chunk.size >= 64 ? buf.readUInt32BE(chunk.off + 60) : 0;
    } else if (current && (chunk.id === "ZCHK" || chunk.id === "DBOD" || chunk.id === "SRAW")) {
      current.frames.push(chunk);
    }
  }

  return { meta, width, height, fps, _buf: buf, layers };
}

/**
 * Decode every frame of every parsed layer into
 * `{ kind: 'empty'|'same'|'full', rgba? }` records. `same` means "repeat
 * the previous frame's image"; history references (SRAW sel=1) share tile
 * buffers, so layers decode in file order.
 */
export function decodeTvppLayers(parsed) {
  for (const layer of parsed.layers) {
    const history = [];
    let previous = null;
    const decoded = [];
    for (const frame of layer.frames) {
      const { tag, data } = chunkPayload(parsed._buf, frame);
      if (tag === "SRAW" && data.length === 28 && data.readUInt32BE(8) === 5) {
        // Explicit-empty directive; its payload words must all be zero.
        let empty = true;
        for (let o = 12; empty && o < 28; o += 4) empty = empty && data.readUInt32BE(o) === 0;
        if (empty) {
          decoded.push({ kind: "empty" });
          continue;
        }
      }
      if (tag === "SRAW" && data.length === 20) {
        const kind = data.readUInt32BE(8);
        const index = data.readUInt32BE(16);
        if (kind === 6 && previous) {
          decoded.push({ kind: "same" });
          continue;
        }
        if (kind === 2 && history[index]) {
          previous = history[index];
          decoded.push({ kind: "full", rgba: assembleTiles(previous, parsed.width, parsed.height) });
          continue;
        }
        decoded.push({ kind: "empty" });
        continue;
      }
      if (tag !== "DBOD" && tag !== "SRAW") {
        decoded.push({ kind: "empty" });
        continue;
      }
      const tiles =
        tag === "DBOD"
          ? decodeTiles(data, parsed.width, parsed.height)
          : decodeSrawTiles(data, parsed.width, parsed.height, previous);
      if (!tiles) {
        decoded.push({ kind: "empty" });
        continue;
      }
      previous = tiles;
      history.push(tiles);
      decoded.push({ kind: "full", rgba: assembleTiles(tiles, parsed.width, parsed.height) });
    }
    layer.decoded = decoded;
  }
  return parsed;
}

/**
 * One-call import: `.tvpp` bytes -> a validated TVMini project plus
 * warnings. Consecutive identical frames on a layer merge into one drawing
 * with a longer hold, matching our exposure model.
 */
export function importTvppBytes(input) {
  const warnings = [];
  const parsed = decodeTvppLayers(readTvpp(input));
  const { width, height } = parsed;

  let fps = Math.round(parsed.fps * 1000) / 1000;
  if (!Number.isFinite(fps) || fps < 1) fps = 12;
  fps = Math.min(120, fps);

  let startFrame = Infinity;
  for (const layer of parsed.layers) {
    if (layer.decoded.some((frame) => frame.kind === "full")) startFrame = Math.min(startFrame, layer.start);
  }
  if (!Number.isFinite(startFrame)) startFrame = 1;

  const layers = [];
  for (let index = 0; index < parsed.layers.length; index += 1) {
    const source = parsed.layers[index];
    const layer = createLayer(source.name || `Layer ${index + 1}`);
    layer.visible = !source.hidden;
    layer.opacity = Math.min(1, Math.max(0, source.opacity / 255));

    let drawing = null;
    source.decoded.forEach((frame, position) => {
      const at = source.start + position;
      if (frame.kind === "full") {
        drawing = {
          at,
          hold: 1,
          strokes: [],
          image: {
            data: encodeRgbaPng(width, height, frame.rgba).toString("base64"),
            width,
            height,
          },
        };
        layer.drawings.push(drawing);
      } else if (frame.kind === "same" && drawing) {
        drawing.hold += 1;
      } else {
        drawing = null;
      }
    });
    layers.push(layer);
  }

  const project = normalizeProject({
    format: "tvmini",
    version: 2,
    width,
    height,
    background: "#ffffff",
    image: null,
    fps,
    startFrame,
    currentLayer: 0,
    currentFrame: startFrame,
    loop: true,
    layers,
  });

  if (parsed.layers.length > 100) warnings.push("more than 100 layers: extra layers were kept");
  return { project, warnings, meta: parsed.meta };
}
