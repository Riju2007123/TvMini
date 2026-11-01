/**
 * A `.fla` / `.xfl` reader.
 *
 * Umoupen (the reference tool studied for this) accepts two containers
 * and says so in its own errors:
 *
 * - `PK…` — an Animate / Flash CS5+ ZIP package (XFL). The document is
 *   `DOMDocument.xml`; the timelines, layers, frames, shapes and symbol
 *   instances are XML.
 * - `D0 CF 11 E0 A1 B1 1A E1` — an older binary `.fla`: a compound file
 *   (CFB) whose `Contents` and `Page N` streams are serialized through
 *   Flash's MFC classes (`CDocumentPage`, `CPicPage`, `CPicLayer`,
 *   `CPicFrame`).
 *
 * This module mirrors that, in three layers:
 *
 * 1. `detectFlaContainer` — the two signatures, with Umoupen's message
 *    for anything that is neither.
 * 2. `readCfbStreams` — a complete compound-file reader (byte order,
 *    DIFAT, FAT, MiniFAT, directory chains) that turns a binary .fla
 *    into named streams.
 * 3. `parseFla` — the document: for a ZIP the XFL DOM (edge strings,
 *    fills, strokes, timelines, symbol instances, matrices); for the
 *    binary package, the readable report (`Contents` properties, scene
 *    name, page summaries) plus Umoupen's "open it in Animate and save
 *    as XFL" guidance, because TVMini does not carry the MFC drawing
 *    schemas needed to rebuild legacy vectors.
 *
 * The parsed result is a TVMini project of the same shape `model.js`
 * produces; `normalizeProject` on the caller side takes it from there.
 */

import { Buffer } from "./bytes.js";
import { unzipSync } from "../vendor/fflate.js";
import { binaryPageToProject } from "./fla-binary.js";
import { decodeArchivePage } from "./fla-archive.js";

/* ---------------------------------------------------------------- container */

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Which container the bytes are in.
 *
 * - `"zip"` — Flash CS5+ `.fla` and `.xfl` (an XFL package)
 * - `"cfb"` — a Flash binary compound file (older `.fla`)
 * - `null` — neither; the caller shows the "could not identify" message.
 */
export function detectFlaContainer(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // A ZIP: local-file header "PK\x03\x04" or (rare) empty "PK\x05\x06".
    if (bytes[2] === 0x03 || bytes[2] === 0x05) return "zip";
  }
  if (bytes.length < CFB_SIGNATURE.length) return null;
  for (let i = 0; i < CFB_SIGNATURE.length; i += 1) {
    if (bytes[i] !== CFB_SIGNATURE[i]) return null;
  }
  return "cfb";
}

/**
 * Parse a `.fla` / `.xfl` file into a TVMini project.
 *
 * Throws an `Error` whose message names what was wrong with the file
 * and, for an older binary package, what to do about it.
 */
export function parseFla(name, bytes) {
  const container = detectFlaContainer(bytes);
  if (container === "zip") return parseXflPackage(name, bytes);
  if (container === "cfb") return parseBinaryFla(name, bytes);
  throw new Error(
    "Expected either an Animate ZIP/XFL package (PK signature) or a Flash " +
      "binary compound file (D0 CF 11 E0 A1 B1 1A E1 signature). " +
      "TVMini could not identify this FLA container.",
  );
}

/* ------------------------------------------------------ compound files (CFB) */

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIR_ENTRY = 128;
const MAX_CFB_STREAMS = 4096;

/**
 * Read a compound file into named streams.
 *
 * Returns `{ major, minor, sectorSize, entries, stream(name) }`. The
 * reader follows the DIFAT (in-header 109 slots + chained DIFAT
 * sectors), the FAT, the directory chain and the MiniFAT, and refuses
 * the pathological things a corrupt file can ask it to do (chains that
 * loop, sector ids past the file).
 */
export function readCfbStreams(data) {
  if (!(data instanceof Buffer)) data = Buffer.from(data);
  if (data.length < 512) throw new Error("the compound file header is truncated");
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== CFB_SIGNATURE[i]) throw new Error("not a compound file (bad signature)");
  }

  // Header layout (MS-CFB): minor @24, major @26, byte order @28,
  // sector shift @30, mini shift @32, directory sector count @40 (v4),
  // FAT count @44, first directory sector @48, mini cutoff @56, first
  // MiniFAT sector @60, MiniFAT count @64, first DIFAT sector @68,
  // DIFAT count @72, DIFAT header slots from @76.
  const byteOrder = readU16(data, 28);
  if (byteOrder !== 0xfffe) throw new Error("the compound file is not little-endian");
  const minor = readU16(data, 24);
  const major = readU16(data, 26);
  const sectorShift = readU16(data, 30);
  const miniShift = readU16(data, 32);
  const sectorSize = 1 << sectorShift;
  if (sectorSize !== 512 && sectorSize !== 4096) throw new Error("unsupported compound-file sector size");
  const miniSize = 1 << miniShift;
  if (miniSize !== 64 && miniSize !== 128) throw new Error("unsupported compound-file mini-stream size");

  const totalSectors = Math.floor((data.length - sectorSize) / sectorSize);
  const dirCount = readU32(data, 40);
  if (major === 3 && dirCount !== 0) throw new Error("a v3 compound file has no directory sector count");
  const fatCount = readU32(data, 44);
  const dirFirstSector = readU32(data, 48);
  const miniCutoff = readU32(data, 56);
  const miniFatFirst = readU32(data, 60);
  const miniFatCount = readU32(data, 64);
  const difatFirst = readU32(data, 68);
  const difatCount = readU32(data, 72);

  // DIFAT: the header holds 109 sector ids; more live in chained
  // sectors whose last slot points at the next one.
  const difat = [];
  for (let i = 0; i < 109; i += 1) {
    const s = readU32(data, 76 + i * 4);
    if (s !== FREESECT && s !== NO_SECTOR && s !== ENDOFCHAIN && s !== FATSECT) difat.push(s);
  }
  let difatSector = difatFirst;
  let guard = 0;
  while (difatCount > 0 && difatSector !== FREESECT && difatSector !== ENDOFCHAIN && guard < difatCount + 8) {
    const base = sectorOffset(difatSector);
    if (base + sectorSize > data.length) break;
    for (let i = 0; i < sectorSize / 4 - 1; i += 1) {
      const s = readU32(data, base + i * 4);
      if (s === FREESECT) break;
      if (s !== ENDOFCHAIN && s !== FATSECT) difat.push(s);
    }
    difatSector = readU32(data, base + sectorSize - 4);
    guard += 1;
  }
  if (difat.length > Math.max(fatCount, 1) + 16) throw new Error("the compound-file FAT sector list is inconsistent");

  // FAT: consecutive u32 sector ids across the DIFAT sectors.
  const fat = [];
  for (const s of difat.slice(0, fatCount)) {
    const base = sectorOffset(s);
    if (base + sectorSize > data.length) continue;
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(readU32(data, base + i * 4));
  }

  function sectorOffset(sector) {
    // The 512-byte header sits before sector 0 even in v4 files.
    return (sector + 1) * 512;
  }

  function chain(startSector, label) {
    const parts = [];
    let cursor = startSector;
    const seen = new Set();
    while (cursor !== ENDOFCHAIN && cursor !== FREESECT && cursor !== NO_SECTOR) {
      if (cursor >= totalSectors) throw new Error(`the compound-file ${label} chain runs past the file`);
      if (seen.has(cursor)) throw new Error(`the compound-file ${label} chain loops`);
      seen.add(cursor);
      const base = sectorOffset(cursor);
      parts.push(data.subarray(base, base + sectorSize));
      cursor = fat[cursor];
    }
    return Buffer.concat(parts);
  }

  // Directory: a chain of 128-byte entries; names are UTF-16 with the
  // terminating NUL counted in the length.
  const dirData = chain(dirFirstSector, "directory");
  const dirEntries = [];
  for (let i = 0; i * DIR_ENTRY < dirData.length && i < MAX_CFB_STREAMS; i += 1) {
    const entry = dirData.subarray(i * DIR_ENTRY, (i + 1) * DIR_ENTRY);
    const nameLength = readU16(entry, 64);
    if (nameLength < 2 || nameLength > 64) continue;
    const type = entry[66];
    let name = "";
    for (let c = 0; c + 2 <= nameLength - 2; c += 2) name += String.fromCharCode(readU16(entry, c));
    dirEntries.push({ name, type, start: readU32(entry, 116), size: readU32(entry, 120) });
  }

  const root = dirEntries.find((e) => e.type === 5);
  const miniChain = root && root.size > 0 ? chain(root.start, "mini-stream") : Buffer.alloc(0);
  const miniFatData = miniFatCount > 0 ? chain(miniFatFirst, "MiniFAT") : Buffer.alloc(0);
  const miniFat = [];
  for (let i = 0; (i + 1) * 4 <= miniFatData.length; i += 1) miniFat.push(readU32(miniFatData, i * 4));

  function readMini(firstSector, size) {
    const parts = [];
    let cursor = firstSector;
    let got = 0;
    let steps = 0;
    while (cursor !== ENDOFCHAIN && cursor !== FREESECT && cursor !== NO_SECTOR) {
      if (steps > miniFat.length + 1) throw new Error("the compound-file mini chain loops");
      const offset = cursor * miniSize;
      parts.push(miniChain.subarray(offset, Math.min(offset + miniSize, miniChain.length)));
      got += miniSize;
      if (got >= size) break;
      cursor = miniFat[cursor];
      if (cursor === undefined) break;
      steps += 1;
    }
    return Buffer.concat(parts).subarray(0, size);
  }

  const entries = [];
  for (let i = 0; i < dirEntries.length; i += 1) {
    const e = dirEntries[i];
    if (e.type === 1 || e.type === 2) entries.push({ index: i, name: e.name, type: e.type, size: e.size });
  }

  function stream(name) {
    const e = dirEntries.find((x) => (x.type === 1 || x.type === 2) && x.name === name);
    if (!e) return null;
    if (e.size >= miniCutoff) return chain(e.start, `"${name}"`).subarray(0, e.size);
    if (e.size === 0) return Buffer.alloc(0);
    return readMini(e.start, e.size);
  }

  return { major, minor, sectorSize, entries, stream, dirEntries };
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  // `>>> 0` keeps sector ids unsigned: bitwise ops land on the signed
  // 32-bit range and ids like 0xFFFFFFFE must compare equal to
  // ENDOFCHAIN, not to -2.
  return (readU16(bytes, offset) | (readU16(bytes, offset + 2) << 16)) >>> 0;
}

const NO_SECTOR = 0xffffffff; // alias for the sentinel in typed contexts

const MAX_SYMBOL_DEPTH = 8;

/** Apply a binary placement matrix (a,b,c,d 16.16 + tx,ty twips) to points. */
function applySpriteMatrix(matrix, points) {
  const [a, b, c, d, tx, ty] = matrix;
  const aa = a / 65536;
  const bb = b / 65536;
  const cc = c / 65536;
  const dd = d / 65536;
  const ttx = tx / 20;
  const tty = ty / 20;
  return points.map(([x, y]) => [clampCoord(aa * x + cc * y + ttx), clampCoord(bb * x + dd * y + tty)]);
}

function clampCoord(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1e6, Math.min(1e6, v));
}

/** Return a copy of a stroke with its points transformed by a placement matrix. */
function transformStroke(stroke, matrix) {
  if (stroke && stroke.paths) {
    return { ...stroke, paths: stroke.paths.map((points) => applySpriteMatrix(matrix, points)) };
  }
  if (stroke && stroke.points) {
    return { ...stroke, points: applySpriteMatrix(matrix, stroke.points) };
  }
  return stroke;
}

/** Compose two binary placement matrices (a,b,c,d 16.16; tx,ty twips): `inner` first, then `outer`. */
function composeBinaryMatrix(outer, inner) {
  const [a1, b1, c1, d1, tx1, ty1] = outer;
  const [a2, b2, c2, d2, tx2, ty2] = inner;
  return [
    Math.round((a1 * a2 + c1 * b2) / 65536),
    Math.round((b1 * a2 + d1 * b2) / 65536),
    Math.round((a1 * c2 + c1 * d2) / 65536),
    Math.round((b1 * c2 + d1 * d2) / 65536),
    Math.round((a1 * tx2 + c1 * ty2) / 65536 + tx1),
    Math.round((b1 * tx2 + d1 * ty2) / 65536 + ty1),
  ];
}

/**
 * The library of a binary `.fla`: every `Symbol N` stream is a page of its own
 * (a movie clip / graphic timeline). A placed symbol or sprite names its
 * stream by `streamId`; its strokes are the drawings of the symbol's layers
 * that are on screen at the instance's first frame, moved by the instance
 * matrix. Symbols are decoded once and may hold symbols (depth-limited).
 */
function createSymbolResolver(symbolStreams, mediaStreams, warnings) {
  const pages = new Map();

  const pageOf = (streamId) => {
    if (pages.has(streamId)) return pages.get(streamId);
    const stream = symbolStreams.get(streamId);
    let page = null;
    if (stream) {
      try {
        page = decodeArchivePage(stream, { media: mediaStreams, resolveInstance: (inst) => resolve(inst, 1) });
      } catch (error) {
        warnings.push(`a symbol library page could not be decoded: ${error.message}`);
      }
    } else {
      warnings.push(`a placed symbol refers to missing library item ${streamId}`);
    }
    pages.set(streamId, page);
    return page;
  };

  let depth = 0;
  function resolve(inst, options = {}) {
    const none = { strokes: [], bitmaps: [] };
    if (depth >= MAX_SYMBOL_DEPTH) return none;
    const matrix = inst.matrix ?? [65536, 0, 0, 65536, 0, 0];
    depth += 1;
    try {
      const page = pageOf(inst.streamId);
      if (!page) return none;
      // The cell of the symbol's own timeline the instance shows: its start
      // frame, moved on by the offset a tween span (or the caller) asks for.
      // A loop that runs past the end starts over, the way a graphic that
      // loops does.
      let frame = (inst.firstFrame ?? 0) + 1 + (options.frameOffset ?? 0);
      if (frame > 1) {
        const length = page.layers.reduce(
          (n, layer) => Math.max(
            n,
            ...layer.drawings.map((d) => d.at + (d.hold ?? 1) - 1),
          ),
          0,
        );
        if (length > 0 && frame > length) frame = ((frame - 1) % length) + 1;
      }
      const strokes = [];
      const bitmaps = [];
      for (const layer of page.layers) {
        if (layer.type === "guide" || layer.visible === false) continue;
        const cell = layer.drawings.find((d) => frame >= d.at && frame < d.at + d.hold);
        if (!cell) continue;
        for (const stroke of cell.strokes) strokes.push(transformStroke(stroke, matrix));
        for (const placement of cell.bitmaps ?? []) {
          bitmaps.push({ matrix: composeBinaryMatrix(matrix, placement.matrix), media: placement.media });
        }
      }
      return { strokes, bitmaps };
    } finally {
      depth -= 1;
    }
  }
  return resolve;
}

/* ------------------------------------------------------------------ binary .fla */

const DEFAULT_BINARY_SIZE = { width: 550, height: 400 };

/**
 * Older binary `.fla` files: a compound file with `Contents` (the
 * MFC-serialized document: scene name, stage, publish properties) and
 * `Page N` / `Symbol N` / `Media N` streams (layers, frames, library items,
 * bitmaps).
 *
 * The first scene page is decoded by `fla-archive.js`, a strict reader of the
 * MFC `CArchive` object graph (layers, keyframes with their durations,
 * shapes, placed symbols and bitmaps), and flattened to strokes the same way
 * an XFL shape is. What the decoder cannot read yet is reported in
 * `project.warnings`; a page that stops part-way keeps everything before the
 * stop.
 */
export function parseBinaryFla(name, bytes) {
  const cfb = readCfbStreams(bytes);
  const contents = cfb.stream("Contents");
  if (!contents) throw new Error("this Flash binary compound file has no Contents stream");

  const scene = contentSceneName(contents);
  const publish = contentPublishProperties(contents);
  const document = contentDocument(contents);
  const stage = document
    ? { width: document.width, height: document.height }
    : contentStageSize(publish) ?? DEFAULT_BINARY_SIZE;

  const pageEntries = cfb.entries
    .filter((e) => /^Page \d+$/.test(e.name))
    .sort((a, b) => Number.parseInt(a.name.slice(5), 10) - Number.parseInt(b.name.slice(5), 10));
  const symbols = cfb.entries.filter((e) => /^Symbol \d+$/.test(e.name));
  const media = cfb.entries.filter((e) => /^Media \d+$/.test(e.name));
  if (!pageEntries.length) throw new Error(`${scene ?? name} is a Flash binary .fla with no Page stream to import`);

  const mediaStreams = new Map();
  for (const entry of media) {
    const id = Number.parseInt(entry.name.slice("Media ".length), 10);
    const stream = cfb.stream(entry.name);
    if (Number.isFinite(id) && stream) mediaStreams.set(id, stream);
  }

  const symbolStreams = new Map();
  for (const entry of symbols) {
    const n = Number.parseInt(entry.name.slice("Symbol ".length), 10);
    const stream = cfb.stream(entry.name);
    if (Number.isFinite(n) && stream) symbolStreams.set(n, stream);
  }

  const libraryWarnings = [];
  const resolveInstance = createSymbolResolver(symbolStreams, mediaStreams, libraryWarnings);

  // Decode every page (scene) and put them one after the other on the timeline.
  const pages = [];
  const allWarnings = [];
  let totalFrames = 0;

  for (let pageIndex = 0; pageIndex < pageEntries.length; pageIndex++) {
    const pageEntry = pageEntries[pageIndex];
    const page = decodeArchivePage(cfb.stream(pageEntry.name), { media: mediaStreams, resolveInstance, stage });

    if (!page.layers.length) {
      const detail = page.warnings.length ? `: ${page.warnings.join("; ")}` : "";
      if (pageIndex === 0) {
        throw new Error(`${pageEntry.name} has no layers this importer can read${detail}`);
      }
      allWarnings.push(`${pageEntry.name} has no layers this importer can read${detail}`);
      continue;
    }

    let pageFrameCount = 0;
    for (const layer of page.layers) {
      for (const drawing of layer.drawings) {
        const endFrame = drawing.at + drawing.hold - 1;
        if (endFrame > pageFrameCount) pageFrameCount = endFrame;
      }
    }
    if (pageIndex > 0) {
      for (const layer of page.layers) {
        for (const drawing of layer.drawings) drawing.at += totalFrames;
      }
    }

    pages.push({ page, pageEntry, pageFrameCount, pageIndex });
    totalFrames += pageFrameCount;

    if (page.warnings?.length) {
      allWarnings.push(...page.warnings.map((w) => (pageEntries.length > 1 ? `${pageEntry.name}: ${w}` : w)));
    }
  }

  if (pages.length === 0) {
    throw new Error("No readable pages found in this Flash binary .fla");
  }

  allWarnings.push(...new Set(libraryWarnings));

  const { mergedLayers } = mergePages(pages);
  const firstPage = pages[0].page;
  const project = binaryPageToProject(name, {
    page: { ...firstPage, layers: mergedLayers, warnings: [] },
    pageName: pages.map((p) => p.pageEntry.name).join(", "),
    pageCount: pageEntries.length,
    symbolCount: symbols.length,
    mediaCount: media.length,
    scene,
    stage,
    publish,
    document,
  });

  if (allWarnings.length) {
    project.warnings = [...(project.warnings ?? []), ...allWarnings];
  }
  return project;
}

/**
 * Merge layers from multiple pages into a single layer list.
 * Layers with the same name are merged (their drawings combined).
 * New layers from subsequent pages are appended.
 * Returns { mergedLayers, layerIndexMap } where layerIndexMap maps "pageIndex:localLayerIndex" -> globalLayerIndex
 */
function mergePages(pages) {
  if (pages.length === 1) {
    const layerIndexMap = new Map();
    for (let i = 0; i < pages[0].page.layers.length; i++) {
      layerIndexMap.set(`0:${i}`, i);
    }
    return { mergedLayers: pages[0].page.layers, layerIndexMap };
  }

  // First page layers are the base
  const mergedLayers = JSON.parse(JSON.stringify(pages[0].page.layers));
  const layerNameToIndex = new Map();
  const layerIndexMap = new Map();
  for (let i = 0; i < mergedLayers.length; i++) {
    layerNameToIndex.set(mergedLayers[i].name, i);
    layerIndexMap.set(`0:${i}`, i);
  }

  // Merge subsequent pages
  for (let p = 1; p < pages.length; p++) {
    const page = pages[p].page;
    for (let localIdx = 0; localIdx < page.layers.length; localIdx++) {
      const layer = page.layers[localIdx];
      const existingIndex = layerNameToIndex.get(layer.name);
      if (existingIndex !== undefined) {
        // Merge drawings into existing layer
        mergedLayers[existingIndex].drawings.push(...layer.drawings);
        layerIndexMap.set(`${p}:${localIdx}`, existingIndex);
      } else {
        // New layer from this page
        const newLayer = JSON.parse(JSON.stringify(layer));
        mergedLayers.push(newLayer);
        const globalIdx = mergedLayers.length - 1;
        layerNameToIndex.set(layer.name, globalIdx);
        layerIndexMap.set(`${p}:${localIdx}`, globalIdx);
      }
    }
  }

  return { mergedLayers, layerIndexMap };
}

/** The first tagged string of `Contents` is the scene name. */
function contentSceneName(contents) {
  const strings = taggedStrings(contents);
  return strings[0] ?? null;
}

/**
 * The publish properties of `Contents`: property names
 * (`PublishHtmlProperties::Width`) each followed by a value string,
 * both tagged wide strings.
 */
function contentPublishProperties(contents) {
  const strings = taggedStrings(contents);
  const properties = {};
  for (let i = 0; i < strings.length; i += 1) {
    if (!/^Publish\w+Properties::/.test(strings[i])) continue;
    let value = "";
    for (let j = i + 1; j < strings.length; j += 1) {
      if (/^Publish\w+Properties::/.test(strings[j])) break;
      if (strings[j]) {
        value = strings[j];
        break;
      }
    }
    if (!(strings[i] in properties)) properties[strings[i]] = value;
  }
  return properties;
}

/** The movie size lives in the HTML publish properties, QuickTime next. */
function contentStageSize(publish) {
  for (const prefix of ["PublishHtmlProperties::", "PublishQTProperties::"]) {
    const width = Number.parseInt(publish[`${prefix}Width`] ?? "", 10);
    const height = Number.parseInt(publish[`${prefix}Height`] ?? "", 10);
    if (width >= 16 && height >= 16 && width <= 8192 && height <= 8192) return { width, height };
  }
  return null;
}

/**
 * The document record of `Contents` (section 3 of the format notes): the stage
 * rectangle in twips, the background and grid colours, and the frame rate as
 * 16.16. Its position depends on how many scene, symbol and media records come
 * before it, so the stage rectangle is the anchor and the fields after it are
 * validated before they are trusted.
 */
export function contentDocument(contents) {
  const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
  if (bytes.length < 80) return null;

  const candidates = [];
  for (let at = 0; at + 16 + 56 <= bytes.length; at += 1) {
    // rect: xmin = 0, xmax = width, ymin = 0, ymax = height (twips)
    if (readS32(bytes, at) !== 0 || readS32(bytes, at + 8) !== 0) continue;
    const widthTwips = readS32(bytes, at + 4);
    const heightTwips = readS32(bytes, at + 12);
    const width = widthTwips / 20;
    const height = heightTwips / 20;
    if (!(width >= 16 && width <= 8192 && height >= 16 && height <= 8192)) continue;

    const after = at + 16;
    const grid = [0, 1, 2, 3].map((i) => readU32(bytes, after + 9 + i * 4));
    if (grid.some((value) => value > 40000)) continue;

    const background = contentColor(bytes, after + 37);
    const gridColor = contentColor(bytes, after + 41);
    const fps = readU32(bytes, after + 45) / 65536;
    if (!(fps >= 1 && fps <= 120)) continue;

    // After the seven trailing bytes, the publish-settings list starts with a
    // `u16` count. A small count and a plausible first key confirm the anchor.
    const count = readU16(bytes, after + 56);
    if (count > 0x2000) continue;
    const keyAt = after + 58;
    if (count > 0) {
      if (keyAt >= bytes.length) continue;
      const first = bytes[keyAt];
      if (first !== 0xff && first >= 0x80) continue;
    }

    candidates.push({
      width: Math.round(width),
      height: Math.round(height),
      background,
      gridColor,
      fps,
      at,
    });
  }

  if (!candidates.length) return null;
  // Prefer the rectangle nearest the end of the header half of the stream: the
  // document record follows the library lists, and stray matches live in them.
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0];
}

/** Read a Contents colour (`R, G, B, A`) as a `#rrggbb` string. */
function contentColor(bytes, at) {
  const r = bytes[at];
  const g = bytes[at + 1];
  const b = bytes[at + 2];
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function readS32(bytes, offset) {
  return readU32(bytes, offset) | 0;
}

/** The readable parts of a `Page N` stream: class names and layer names. */
export function pageSummary(pageBytes) {
  if (!pageBytes) return { classes: [], layerLabels: [], layers: [], frames: 0, bytes: 0 };
  const classNames = mfcClassNames(pageBytes);
  const layerNames = taggedStrings(pageBytes).filter((t) => /^(Layer|layer|Guides|guides|Actions|图层|слои)/.test(t));
  return {
    classes: classNames,
    layerLabels: layerNames,
    layers: layerNames.map((name) => ({ name })),
    frames: 0,
    bytes: pageBytes.length,
  };
}

/** The MFC class store of a stream: the Flash serialization names. */
function mfcClassNames(pageBytes) {
  const names = new Set();
  const text = latin1(pageBytes);
  for (const match of text.matchAll(/CDocument\w+|CPic(?:Page|Layer|Frame\w*|Ellipse\w*|Rect\w*|Shape\w*|Text\w*|Bitmap\w*|Photo\w*|Inst\w*)|CFontSehd/g)) {
    names.add(match[0]);
  }
  return [...names];
}

function latin1(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

/**
 * A tagged wide string: `FF FE FF`, then a one-byte length, then
 * UTF-16LE text — the escape MFC's CArchive writes counted strings
 * with. Only runs of printable characters are accepted, so binary
 * noise never becomes a name or a value.
 */
export function taggedStrings(bytes) {
  const strings = [];
  for (let i = 0; i + 5 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xfe || bytes[i + 2] !== 0xff) continue;
    const length = bytes[i + 3];
    const end = i + 4 + length * 2;
    if (length === 0 || length > 1024 || end > bytes.length) continue;
    let text = "";
    let ok = true;
    for (let c = 0; c < length; c += 1) {
      const ch = readU16(bytes, i + 4 + c * 2);
      if (ch < 0x20 || ch > 0x7e) {
        ok = false;
        break;
      }
      text += String.fromCharCode(ch);
    }
    if (ok) strings.push(text);
    i = end - 1;
  }
  return strings;
}

/** Runs of readable wide characters at either parity (report helper). */
export function utf16Runs(bytes) {
  const runs = [];
  for (let parity = 0; parity < 2; parity += 1) {
    let start = -1;
    let codes = [];
    for (let i = parity; i + 1 < bytes.length; i += 2) {
      const ch = readU16(bytes, i);
      const ok = (ch >= 0x20 && ch < 0x7f) || ch === 10 || ch === 13;
      if (ok) {
        if (start < 0) {
          start = i;
          codes = [];
        }
        codes.push(ch);
      } else {
        if (codes.length >= 4) runs.push({ start, text: codes.map((c) => String.fromCharCode(c)).join("") });
        start = -1;
        codes = [];
      }
    }
  }
  runs.sort((a, b) => a.start - b.start);
  const keep = [];
  for (const run of runs) {
    const previous = keep[keep.length - 1];
    if (previous && run.start <= previous.start + previous.text.length * 2 + 4) {
      if (run.text.length > previous.text.length) keep[keep.length - 1] = run;
    } else keep.push(run);
  }
  return keep.map((r) => r.text);
}

/* ------------------------------------------------------------- XFL packages */

/** Umoupen's XFL fallback when the document omits its size. */
const DEFAULT_XFL_SIZE = { width: 1920, height: 1080 };
/** XFL geometry is in twentieths of a pixel. */
const TWIPS = 20;

/**
 * The ZIP/XFL package: `DOMDocument.xml`, the library of symbol items
 * and (optionally) `PublishSettings.xml` for the stage.
 */
export function parseXflPackage(name, bytes) {
  let files;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch (error) {
    throw new Error(`the XFL archive could not be opened: ${error.message ?? error}`);
  }

  const domPath = findEntry(files, "DOMDocument.xml");
  if (!domPath) {
    throw new Error(
      "This ZIP package has no DOMDocument.xml, the document of an XFL/Animate package. " +
        "If the file is an older binary Flash .fla, open it in Adobe Animate or Flash and export or save it as XFL first.",
    );
  }
  const document = parseXml(new TextDecoder("utf-8").decode(files[domPath]));
  if (document.name !== "DOMDocument") {
    throw new Error(`the main document element is "${document.name}", expected "DOMDocument"`);
  }

  // Stage: DOMDocument attributes first, PublishSettings.xml second,
  // defaults last — the ladder Umoupen follows.
  const warnings = [];
  let width = attrNumber(document.attrs, "width", 0);
  let height = attrNumber(document.attrs, "height", 0);
  if (!(width >= 16 && height >= 16)) {
    const settingsPath = findEntry(files, "PublishSettings.xml") ?? findEntry(files, "publishsettings.xml");
    if (settingsPath) {
      const parsed = parseXml(new TextDecoder("utf-8").decode(files[settingsPath]));
      const size = publishStageSize(parsed);
      width = size.width;
      height = size.height;
    }
  }
  if (!(width >= 16 && height >= 16)) {
    width = DEFAULT_XFL_SIZE.width;
    height = DEFAULT_XFL_SIZE.height;
    warnings.push("the stage size was not in the document; using 1920×1080");
  }

  let fps = attrFloat(document.attrs, "frameRate", 0);
  if (!(fps > 0)) fps = 24;

  const timelinesTree = childNamed(document, "timelines") ?? document;
  const timelines = childrenNamed(timelinesTree, "DOMTimeline");
  const timeline = timelines.find((t) => attrString(t.attrs, "currentTimeline", "") === "true") || timelines[0];
  if (!timeline) throw new Error("the document has no timeline to import");

  const library = mapLibrary(files);
  const project = timelineToProject(timeline, { width, height, fps, document, library, warnings });
  project.sourceName = name;
  return project;
}

/** `PublishSettings.xml` carries the stage in worker blues attributes. */
function publishStageSize(settings) {
  // The helpful values are `PublishSizeWidth` style attributes or the
  // document `publishSize`; try the obvious attribute spellings.
  const width = attrNumber(settings.attrs, "width", 0) || attrNumber(settings.attrs, "movieWidth", 0);
  const height = attrNumber(settings.attrs, "height", 0) || attrNumber(settings.attrs, "movieHeight", 0);
  return { width, height };
}

/**
 * Walk a timeline into project layers. XFL frames are 0-based and
 * TVMini drawings are 1-based; a frame with `duration` d is one
 * drawing shown for d frames.
 */
function timelineToProject(timeline, context) {
  const { width, height, fps, document, library, warnings } = context;
  const layers = [];
  const sheet = [];

  for (const layerElement of timelineElements(timeline, "DOMLayer", "DOMFolderLayer", "DOMGuideLayer")) {
    const isFolder = layerElement.name === "DOMFolderLayer";
    const layerType = attrString(layerElement.attrs, "layerType", "normal");
    const type = isFolder ? "group" : layerType === "guide" ? "guide" : layerType === "mask" ? "mask" : "anim";
    const layer = {
      name: attrString(layerElement.attrs, "name", `Layer ${layers.length + 1}`),
      type,
      visible: layerElement.name !== "DOMGuideLayer" && attrString(layerElement.attrs, "visible", "true") !== "false",
      locked: attrString(layerElement.attrs, "locked", "false") === "true",
      opacity: 1,
      blend: "normal",
      preBehavior: type === "guide" ? "none" : "none",
      postBehavior: type === "folder" ? "hold" : "hold",
      clip: false,
      parent: -1,
      drawings: [],
    };
    sheet.push({ layer, folder: isFolder });
    layers.push(layer);

    if (isFolder) continue;
    for (const frame of layerElementChildren(layerElement, "frames", "DOMFrame")) {
      const index = attrInt(frame.attrs, "index", layers.length + layer.drawings.length);
      const duration = Math.max(1, attrInt(frame.attrs, "duration", 1));
      const frameName = attrString(frame.attrs, "name", "") || null;
      const strokes = [];

      for (const element of childNamed(frame, "elements")?.children ?? []) {
        elementStrokes(element, strokes, library, warnings, 0, null);
      }

      if (strokes.length || frameName) {
        layer.drawings.push({ at: index + 1, hold: duration, strokes, name: frameName });
      }
    }
  }

  // A folder owns the layers that follow it in the document order.
  let folderIndex = -1;
  for (let i = 0; i < sheet.length; i += 1) {
    const position = layers.indexOf(sheet[i].layer);
    if (sheet[i].folder) folderIndex = position;
    else if (folderIndex >= 0 && folderIndex < position) sheet[i].layer.parent = folderIndex;
  }

  const project = {
    format: "tvmini",
    version: 3,
    width,
    height,
    background: normalizeColor(attrString(document.attrs, "backgroundColor", "#ffffff")),
    fps: Math.round(fps * 100) / 100,
    startFrame: 1,
    currentLayer: 0,
    currentFrame: 1,
    loop: true,
    camera: null,
    audio: null,
    layers,
  };
  if (warnings.length) project.warnings = warnings;
  return project;
}

/** The children of a timeline: layers, then the layers inside folders. */
function timelineElements(timeline, ...names) {
  function gather(sources) {
    const out = [];
    for (const node of sources) {
      if (names.includes(node.name)) out.push(node);
      if (node.name === "DOMFolderLayer" || node.name === "DOMLayer") {
        const wrapper = childNamed(node, "layers");
        if (wrapper) out.push(...gather(wrapper.children ?? []));
      }
    }
    return out;
  }
  const wrapper = childNamed(timeline, "layers");
  return gather(wrapper ? wrapper.children ?? [] : timeline.children ?? []);
}

/** The frames of a layer: direct children or under a `frames` wrapper. */
function layerElementChildren(layerElement, wrapperName, itemName) {
  const wrapper = childNamed(layerElement, wrapperName);
  const list = [];
  for (const node of wrapper ? wrapper.children ?? [] : layerElement.children ?? []) {
    if (node.name === itemName) list.push(node);
  }
  return list;
}

/**
 * One placed element → strokes. Shapes give edge strings; symbol
 * instances are walked recursively with their matrices; groups are
 * flattened the same way; text and bitmaps arrive as warnings (which
 * is what the reference importer reports for them too).
 */
function elementStrokes(element, out, library, warnings, depth, parentMatrix) {
  if (!element) return;
  if (depth > MAX_SYMBOL_DEPTH) {
    warnings.push("a symbol nesting goes deeper than the import follows; the rest was skipped");
    return;
  }
  switch (element.name) {
    case "DOMShape": {
      const matrix = matrixOf(element, parentMatrix);
      for (const stroke of shapeStrokes(element, warnings)) {
        out.push(matrix ? applyMatrix(stroke, matrix) : stroke);
      }
      return;
    }
    case "DOMGroup": {
      const matrix = matrixOf(element, parentMatrix);
      for (const member of childNamed(element, "members")?.children ?? []) {
        elementStrokes(member, out, library, warnings, depth + 1, matrix);
      }
      return;
    }
    case "DOMSymbolInstance": {
      const ref = attrString(element.attrs, "libraryItemName", "");
      const symbol = library.get(ref);
      if (!symbol) {
        warnings.push(`a symbol instance points at "${ref ?? "(unnamed)"}", which is not in the library`);
        return;
      }
      const matrix = matrixOf(element, parentMatrix);
      const timeline = symbolTimelineIn(symbol);
      if (!timeline) return;
      for (const frame of layerElementChildren(firstChildLayer(timeline), "frames", "DOMFrame")) {
        if (attrInt(frame.attrs, "index", 0) !== 0) continue; // the instance's first frame
        for (const elementInner of childNamed(frame, "elements")?.children ?? []) {
          elementStrokes(elementInner, out, library, warnings, depth + 1, matrix);
        }
      }
      return;
    }
    case "DOMBitmapInstance":
      warnings.push(`a bitmap ("${attrString(element.attrs, "libraryItemName", "") || "unnamed"}") is not imported`);
      return;
    case "DOMStaticText":
    case "DOMDynamicText":
    case "DOMInputText":
      warnings.push(`text "${textContentOf(element).trim().slice(0, 40) || "(empty)"}" is not imported`);
      return;
    default:
      return;
  }
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function matrixOf(element, parentMatrix) {
  const matrixNode = childNamed(element, "matrix")?.children?.find((c) => c.name === "Matrix")
    ?? element.children?.find((c) => c.name === "Matrix");
  if (!matrixNode && depth0(parentMatrix)) return null;
  const matrix = matrixNode
    ? {
        a: attrFloat(matrixNode.attrs, "a", 1),
        b: attrFloat(matrixNode.attrs, "b", 0),
        c: attrFloat(matrixNode.attrs, "c", 0),
        d: attrFloat(matrixNode.attrs, "d", 1),
        tx: attrFloat(matrixNode.attrs, "tx", 0) / TWIPS,
        ty: attrFloat(matrixNode.attrs, "ty", 0) / TWIPS,
      }
    : { ...IDENTITY };
  return parentMatrix ? composeMatrix(parentMatrix, matrix) : matrix;

  function depth0(m) {
    return !m || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0);
  }
}

function composeMatrix(first, second) {
  return {
    a: first.a * second.a + first.b * second.c,
    b: first.a * second.b + first.b * second.d,
    c: first.c * second.a + first.d * second.c,
    d: first.c * second.b + first.d * second.d,
    tx: first.tx * second.a + first.ty * second.c + second.tx,
    ty: first.tx * second.b + first.ty * second.d + second.ty,
  };
}

function applyMatrix(stroke, matrix) {
  if (matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1 && matrix.tx === 0 && matrix.ty === 0) {
    return stroke;
  }
  return {
    ...stroke,
    points: stroke.points.map(([x, y, pressure]) => {
      const nx = matrix.a * x + matrix.c * y + matrix.tx;
      const ny = matrix.b * x + matrix.d * y + matrix.ty;
      return Number.isFinite(pressure) ? [nx, ny, pressure] : [nx, ny];
    }),
  };
}

/* ---------------------------------------------------------------- shapes */

/**
 * A `DOMShape` is its `<edges>` strings plus the styles those edges
 * reference:
 *
 * - `fillStyle0` / `fillStyle1` — the 1-based `FillStyle` index of the
 *   fill on the left/right of each segment.
 * - `strokeStyle` — the 1-based `StrokeStyle` index of the stroke.
 *
 * TVMini draws strokes, so each edge segment arrives as one stroke:
 * stroked segments take the stroke style's colour and width, and
 * segments without a stroke take the fill colour so shapes survive
 * with an outline of what they were filled with.
 */
function shapeStrokes(shape, warnings) {
  const fills = fillStyles(childNamed(shape, "fills"), warnings);
  const strokes = strokeStyles(childNamed(shape, "strokes"), warnings);
  const out = [];

  const edgesContainer = childNamed(shape, "edges");
  if (!edgesContainer) return out;
  for (const edge of edgesContainer.children ?? []) {
    if (edge.name !== "Edge") continue;
    const data = typeof edge.attrs.edges === "string" ? edge.attrs.edges : textOf(edge);
    if (!data) continue;
    const fillA = attrInt(edge.attrs, "fillStyle0", 0);
    const fillB = attrInt(edge.attrs, "fillStyle1", 0);
    const strokeIndex = attrInt(edge.attrs, "strokeStyle", 0);
    const fill = fills[fillA] ?? fills[fillB] ?? null;
    const stroke = strokes[strokeIndex] ?? null;

    for (const segment of parseEdgeString(data)) {
      if (segment.length < 2) continue;
      out.push({
        color: stroke ? stroke.color : fill ? fill.color : "#000000",
        width: stroke ? stroke.width : 1,
        points: segment,
        opacity: 1,
        blend: "normal",
      });
    }
  }
  return out;
}

/** `<fills>`: `FillStyle index → SolidColor color` (gradients: first stop). */
function fillStyles(fillsNode, warnings) {
  const styles = [null]; // index 1-based
  if (!fillsNode) return styles;
  for (const style of fillsNode.children ?? []) {
    if (style.name !== "FillStyle") continue;
    const index = attrInt(style.attrs, "index", styles.length);
    const solid = childNamed(style, "SolidColor");
    const gradient = style.children?.find((c) => /Gradient$/.test(c.name));
    if (solid) {
      styles[index] = { color: normalizeColor(attrString(solid.attrs, "color", "#888888")) };
    } else if (gradient) {
      const stop = (childNamed(gradient, "GradientEntry") ?? gradient.children?.[0]);
      styles[index] = {
        color: normalizeColor(attrString(stop?.attrs ?? {}, "color", "#888888")),
      };
      warnings.push("a gradient fill was imported as its first colour");
    } else {
      styles[index] = { color: "#888888" };
    }
  }
  return styles;
}

/** `<strokes>`: `StrokeStyle index → SolidStroke { weight, color }`. */
function strokeStyles(strokesNode, warnings) {
  const list = [null]; // index 1-based
  if (!strokesNode) return list;
  for (const style of strokesNode.children ?? []) {
    if (style.name !== "StrokeStyle") continue;
    const index = attrInt(style.attrs, "index", list.length);
    const solid = childNamed(style, "SolidStroke");
    if (solid) {
      const fill = solid.children?.find((c) => c.name === "fill" || c.name === "Fill");
      const solidColor = fill ? childNamed(fill, "SolidColor") : null;
      list[index] = {
        color: normalizeColor(attrString(solidColor?.attrs ?? {}, "color", "#000000")),
        width: Math.max(0.5, attrFloat(solid.attrs, "weight", 2)),
      };
    } else {
      warnings.push("an exotic stroke style was imported as a plain line");
      list[index] = { color: "#000000", width: 2 };
    }
  }
  return list;
}

/**
 * The XFL edge-string grammar (confirmed against the reference
 * importer's samples):
 *
 *     moveto : "!" x y
 *     lineto : ("|" | "/") x y
 *     quadto : ("[" | "]") cx cy x y
 *     select : /S[1-7]/          (a hint, ignored)
 *
 * with numbers either decimal or hex fixed-point `#HEX.HEX` in twips.
 * Each `!` starts a segment; quadratics contribute their control point
 * and destination, so the polyline tracks the curve's silhouette.
 */
export function parseEdgeString(data) {
  const tokens = data.match(/[!|/[\]]|(?<!S)-?\d+(?:\.\d+)?|#[A-Fa-f0-9]+\.[A-Fa-f0-9]+/g) ?? [];
  const segments = [];
  let current = null;
  let last = null;

  const nextNumber = () => parseEdgeNumber(tokens[i++]);
  const nextPoint = () => [nextNumber(), nextNumber()];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "!") {
      i += 1;
      if (current && current.length >= 2) segments.push(current);
      current = [];
      last = nextPoint();
      current.push(last);
    } else if (token === "|" || token === "/") {
      i += 1;
      if (!current) {
        current = [];
        segments.push(current);
      }
      last = nextPoint();
      current.push(last);
    } else if (token === "[" || token === "]") {
      i += 1;
      if (!current) {
        current = [];
        segments.push(current);
      }
      const control = nextPoint();
      pushIfDifferent(current, control);
      last = nextPoint();
      pushIfDifferent(current, last);
    } else {
      i += 1; // "S n" hints and anything unrecognised skip
    }
  }
  if (current && current.length >= 2) segments.push(current);

  return segments.filter((segment) => segment.length >= 2);

  function pushIfDifferent(list, point) {
    const previous = list[list.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) list.push(point);
  }
}

/** One XFL edge number: decimal twips or hex fixed-point `#INT.FRAC`. */
function parseEdgeNumber(token) {
  if (token[0] !== "#") return Number.parseFloat(token) / TWIPS;
  const parts = token.slice(1).split(".");
  const intPart = parts[0].padStart(6, "0");
  const fracPart = (parts[1] ?? "").padEnd(2, "0");
  let value = 0;
  for (let c = 0; c < intPart.length + fracPart.length; c += 2) {
    const digits = (intPart + fracPart).slice(c, c + 2);
    value = value * 256 + Number.parseInt(digits, 16);
  }
  const bits = (intPart.length + fracPart.length) * 4 / 2;
  if (value >= 2 ** (bits - 1)) value -= 2 ** bits;
  return value / 256 / TWIPS;
}

/* ---------------------------------------------------------------- symbols */

/** The library: every `LIBRARY/*.xml` whose root is a `DOMSymbolItem`. */
function mapLibrary(files) {
  const library = new Map();
  for (const path of Object.keys(files)) {
    if (!/^LIBRARY\//i.test(path) || !path.endsWith(".xml")) continue;
    const text = new TextDecoder("utf-8").decode(files[path]);
    let document;
    try {
      document = parseXml(text);
    } catch {
      continue;
    }
    if (document.name === "DOMSymbolItem") {
      const name = attrString(document.attrs, "name", "") || path.replace(/^LIBRARY\//i, "").replace(/\.xml$/i, "");
      if (!library.has(name)) library.set(name, document);
    }
  }
  return library;
}

/** The symbol's main timeline, or null. */
function symbolTimelineIn(symbol) {
  const timelines = childNamed(symbol, "timelines");
  return timelines?.children?.find((c) => c.name === "DOMTimeline") ?? null;
}

/** The first layer cell of a timeline (direct or under `layers`). */
function firstChildLayer(timeline) {
  const wrapper = childNamed(timeline, "layers");
  return (wrapper ? wrapper.children ?? [] : timeline.children ?? []).find((c) => c.name === "DOMLayer") ?? timeline;
}

function textContentOf(element) {
  let text = "";
  for (const child of element.children ?? []) {
    if (child.name === "characters") text += textOf(child);
    else text += textContentOf(child);
  }
  return textOf(element) + text;
}

function textOf(node) {
  return typeof node.text === "string" ? node.text : "";
}

/* --------------------------------------------------------------- XML helper */

/**
 * A small XML reader for what a `.fla` needs: element and attribute
 * names, text and nesting. It handles the document prologue, comments
 * and CDATA, and the five standard entities. Namespaces stay in the
 * tag name.
 */
export function parseXml(text) {
  const root = parseNode(text, 0);
  if (!root || !root.name) throw new Error("the XML document is empty or not XML");
  return root;
}

function parseNode(text, start) {
  const stack = [];
  let root = null;
  let index = skipProlog(text, start);

  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open < 0) break;
    if (open > index && stack.length) stack[stack.length - 1].text += text.slice(index, open);
    index = open;

    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index + 9);
      const content = text.slice(index + 9, end < 0 ? undefined : end);
      if (stack.length) stack[stack.length - 1].text += content;
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("</", index)) {
      index = text.indexOf(">", index) + 1;
      const closing = stack.pop();
      if (closing) {
        if (stack.length) stack[stack.length - 1].children.push(closing);
        else if (!root) root = closing;
      }
      if (!stack.length && root) break;
      continue;
    }

    const tag = readTag(text, index);
    if (!tag) break;
    index = tag.end;
    const element = {
      name: tag.name,
      attrs: tag.attrs,
      text: "",
      children: [],
    };
    if (tag.selfClosing) {
      if (stack.length) stack[stack.length - 1].children.push(element);
      else {
        root = element;
        break;
      }
    } else {
      stack.push(element);
    }
  }
  while (!root && stack.length) {
    const closing = stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(closing);
    else root = closing;
  }
  return root;

  function skipProlog(text, from) {
    let i = from;
    while (i < text.length) {
      const nextTag = text.indexOf("<", i);
      if (nextTag < 0) return text.length;
      if (nextTag > i && nextTag > i) {
        const head = text.slice(i, nextTag).trim();
        if (!head) return nextTag;
      }
      if (text.startsWith("<?", nextTag)) {
        i = text.indexOf("?>", nextTag) + 2;
        continue;
      }
      if (text.startsWith("<!", nextTag)) {
        // DOCTYPE with or without an internal subset.
        let end = nextTag;
        let depth = 0;
        while (end < text.length) {
          const ch = text[end];
          if (ch === "<") depth += 1;
          else if (ch === ">") {
            depth -= 1;
            if (depth === 0) {
              end += 1;
              break;
            }
          }
          end += 1;
        }
        i = end;
        continue;
      }
      return nextTag;
    }
    return text.length;
  }
}

function readTag(text, index) {
  const end = text.indexOf(">", index);
  if (end < 0) return null;
  const selfClosing = text[end - 1] === "/";
  const body = text.slice(index + 1, selfClosing ? end - 1 : end);
  const nameMatch = /^[\w.:#\-]+/.exec(body);
  if (!nameMatch) {
    // A declaration or unparseable tag: consume it and try again.
    return nameless(end + 1);
  }
  const attrs = {};
  const attrPattern = /([:\w\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrPattern.exec(body))) attrs[match[1]] = decodeEntities(match[2] ?? match[3]);
  return { name: nameMatch[0], attrs, selfClosing, end: end + 1 };

  function nameless(next) {
    void next;
    return { name: null, attrs: {}, selfClosing: true, end: end + 1 };
  }
}

function decodeEntities(value) {
  if (!value.includes("&")) return value;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------ helpers */

function findEntry(files, name) {
  const lower = name.toLowerCase();
  const keys = Object.keys(files);
  return keys.find((key) => key.toLowerCase() === lower) ?? keys.find((key) => key.toLowerCase().endsWith(`/${lower}`)) ?? null;
}

function childNamed(node, name) {
  return (node.children ?? []).find((c) => c.name === name) ?? null;
}

function childrenNamed(node, name) {
  return (node.children ?? []).filter((c) => c.name === name);
}

function normalizeColor(value) {
  const text = String(value).trim().toLowerCase();
  return text.startsWith("#") ? text : `#${text}`;
}

function attrNumber(attrs, name, fallback) {
  const value = Number.parseFloat(attrs[name]);
  return Number.isFinite(value) ? value : fallback;
}

function attrFloat(attrs, name, fallback) {
  return attrNumber(attrs, name, fallback);
}

function attrInt(attrs, name, fallback) {
  return Math.round(attrNumber(attrs, name, fallback));
}

function attrString(attrs, name, fallback) {
  const value = attrs[name];
  return typeof value === "string" ? value : fallback;
}
