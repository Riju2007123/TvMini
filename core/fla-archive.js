/**
 * Strict reader for the `Page N` / `Symbol N` streams of a legacy binary
 * `.fla`.
 *
 * The streams are a plain MFC `CArchive` object graph:
 *
 *   0x0000                null pointer
 *   0xFFFF <schema u16> <len u16> <name>
 *                         a class seen for the first time; the object of
 *                         that class follows immediately
 *   0x8000 | n            a new object of the class stored at map index n
 *   0x7FFF <u32>          the same with a 32-bit index (bit 31 = class)
 *   n (1 .. 0x7FFE)       a pointer to the object stored at map index n
 *
 * Classes *and* objects share ONE counter, starting at 1 and bumped in
 * stream order (the class first, then the object that introduced it). That
 * is why the second layer of a page is `0x8003 + 2k`-ish and not a fixed id:
 * every frame, shape and sprite in between took a slot. Getting this counter
 * exactly right is what lets the walker tell objects from data, so nothing
 * here scans or guesses: every record is read by the grammar of its class
 * and the walk must land exactly on the end of the stream.
 *
 * Containers (`CPicPage`, `CPicLayer`, `CPicFrame`, `CPicShape`, ...) all
 * start with the same "children list": `u8 flag, u8 extra`, any number of
 * objects, a null pointer, and a flag-dependent payload (8/8/9/10 bytes for
 * flags 1-2/3/4+). Their own fields come after that list.
 */

import {
  BinaryCursor,
  StopDecode,
  readShapeBody,
  shapeToStrokes,
  composeCellBitmaps,
} from "./fla-binary.js";
import { renderDrawingRgba } from "./png.js";

const MAX_DEPTH = 0x100;

/* ----------------------------------------------------------------- the map */

class ObjectMap {
  constructor() {
    this.entries = [null];
  }

  addClass(name) {
    this.entries.push({ kind: "class", name });
    return this.entries.length - 1;
  }

  addObject(className) {
    const object = { kind: "object", className, value: null, index: this.entries.length };
    this.entries.push(object);
    return object;
  }

  get(index) {
    return this.entries[index] ?? null;
  }
}

/* ----------------------------------------------------------------- decoder */

class Archive {
  constructor(data, options = {}) {
    this.cursor = new BinaryCursor(data);
    this.map = new ObjectMap();
    this.warnings = options.warnings ?? new Set();
    this.trace = options.trace ?? null;
    this.depth = 0;
    this.options = options;
    // Layers (and their frames) are registered while they are read, so that a
    // stream that breaks half way still hands back everything before the break.
    this.layerShells = [];
  }

  log(...parts) {
    if (this.trace) this.trace(this.cursor.at, this.depth, ...parts);
  }

  /**
   * Read one class tag. Returns `null` for the null pointer, `{ ref }` for a
   * pointer to an object already stored, or `{ object, className }` for a new
   * object whose body the caller must now read.
   */
  readPointer() {
    const c = this.cursor;
    const tag = c.u16();
    if (tag === 0x0000) return null;

    if (tag === 0xffff) {
      const schema = c.u16();
      const length = c.u16();
      if (length === 0 || length > 0x3f) throw new StopDecode(`a class name of ${length} bytes at 0x${c.at.toString(16)}`);
      const raw = c.bytes(length);
      let name = "";
      for (const byte of raw) {
        if (byte < 0x20 || byte > 0x7e) throw new StopDecode("a class name with a non-ASCII byte");
        name += String.fromCharCode(byte);
      }
      this.map.addClass(name);
      const object = this.map.addObject(name);
      return { object, className: name, schema };
    }

    let index;
    let isClass;
    if (tag === 0x7fff) {
      const wide = c.u32();
      isClass = (wide & 0x80000000) !== 0;
      index = wide & 0x7fffffff;
    } else {
      isClass = (tag & 0x8000) !== 0;
      index = tag & 0x7fff;
    }

    const entry = this.map.get(index);
    if (!entry) throw new StopDecode(`a pointer to unknown map slot ${index} at 0x${(c.at - 2).toString(16)}`);
    if (isClass) {
      if (entry.kind !== "class") throw new StopDecode(`slot ${index} is not a class at 0x${(c.at - 2).toString(16)}`);
      const object = this.map.addObject(entry.name);
      return { object, className: entry.name };
    }
    return { ref: entry };
  }

  /** The Flash "children list" shared by every container. */
  readChildren(each) {
    const c = this.cursor;
    const flag = c.u8();
    const extra = c.u8();
    for (;;) {
      const pointer = this.readPointer();
      if (pointer === null) break;
      if (pointer.ref) {
        each(null, pointer.ref);
        continue;
      }
      const value = this.readObjectBody(pointer);
      each(pointer.className, value, pointer.object);
    }
    // Payload after the null pointer.
    if (flag !== 0) {
      c.skip(8);
      if (flag >= 3) c.skip(1);
      if (flag >= 4) c.skip(1);
    }
    return { flag, extra };
  }

  /** An optional single pointer (parent layer, ease target, ...). */
  readOptionalPointer() {
    const pointer = this.readPointer();
    if (pointer === null) return 0;
    if (pointer.ref) return pointer.ref.index;
    const value = this.readObjectBody(pointer);
    pointer.object.value = value;
    return pointer.object.index;
  }

  readObjectBody(pointer) {
    if (this.depth >= MAX_DEPTH) throw new StopDecode("object nesting is too deep");
    this.depth += 1;
    try {
      const start = this.cursor.at;
      const decoder = DECODERS[pointer.className];
      if (!decoder) throw new StopDecode(`unsupported MFC class ${pointer.className}`);
      this.log("begin", pointer.className, `map#${pointer.object.index}`);
      const value = decoder(this, pointer);
      pointer.object.value = value;
      this.log("end", pointer.className, `${start}..${this.cursor.at}`);
      return value;
    } finally {
      this.depth -= 1;
    }
  }
}

/* ------------------------------------------------------------ class decoders */

function decodeShape(archive) {
  const { flag } = archive.readChildren(() => {
    throw new StopDecode("a shape inside a shape");
  });
  const shape = readShapeBody(archive.cursor, flag, archive.warnings);
  return { kind: "shape", shape };
}

function decodeBitmap(archive) {
  const c = archive.cursor;
  archive.readChildren(() => {
    throw new StopDecode("an object inside a bitmap");
  });
  const schema = c.u8();
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(c.s32());
  const media = c.u16();
  if (schema >= 2) {
    const filter = c.u8();
    if (filter !== 0) throw new StopDecode(`a bitmap uses an unsupported filter mode ${filter}`);
  }
  return { kind: "bitmap", matrix, media };
}

/**
 * A placed movie clip (`CPicSprite`). The head is known (schema, matrix,
 * firstFrame, colour transform, name, library stream id); the tail is read
 * by `readSpriteTail`.
 */
function decodeSprite(archive) {
  const c = archive.cursor;
  archive.readChildren(() => {
    throw new StopDecode("an object inside a sprite");
  });
  const schema = c.u8();
  if (schema !== 0x13) throw new StopDecode(`unsupported CPicSprite schema ${schema}`);
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(c.s32());
  const firstFrame = c.u16();
  c.u16();
  c.u8();
  const colorTransform = [];
  for (let i = 0; i < 8; i += 1) colorTransform.push(c.u16());
  c.u16();
  c.u16();
  c.u32();
  const instanceName = c.readString();
  const streamId = c.u32();
  archive.log("sprite head", { streamId, instanceName, matrix });
  const tail = readSpriteTail(archive, schema);
  return { kind: "sprite", streamId, matrix, firstFrame, instanceName, colorTransform, ...tail };
}

function readSpriteTail(archive) {
  const c = archive.cursor;
  if (archive.options.tailProbe !== undefined) {
    c.skip(archive.options.tailProbe);
    return {};
  }
  // After the library stream id: 24 bytes of fixed flags and a 16-bit id,
  // two counted strings (class / linkage names), 22 bytes of flags and a
  // format number, and the component-metadata XML as a last counted string.
  c.skip(24);
  const linkage = c.readString();
  const className = c.readString();
  c.skip(22);
  const componentXml = c.readString();
  return { linkage, className, componentXml };
}

function decodeSymbolInstance(archive) {
  const c = archive.cursor;
  archive.readChildren(() => {
    throw new StopDecode("an object inside a symbol instance");
  });
  const schema = c.u8();
  const matrix = [];
  for (let i = 0; i < 6; i += 1) matrix.push(c.s32());
  const firstFrame = c.u16();
  let instanceName = "";
  let streamId = 0;
  if (schema < 2) {
    c.u8();
  } else {
    c.u16();
    c.u8();
  }
  if (schema > 10) {
    for (let i = 0; i < 8; i += 1) c.u16();
    c.u16();
    c.u16();
    c.u32();
    instanceName = c.readString();
    streamId = c.u32();
    c.u32();
    c.u8();
    c.u16();
    if (schema === 0x16) c.skip(0x66);
  } else {
    for (let i = 0; i < 4; i += 1) c.u16();
    instanceName = c.readString();
    streamId = c.u32();
  }
  return { kind: "symbol", streamId, matrix, firstFrame, instanceName };
}

function decodeFrame(archive) {
  const c = archive.cursor;
  const elements = [];
  const frame = { kind: "frame", schema: 0, duration: 1, elements };
  try {
    readFrameInto(archive, frame);
  } catch (error) {
    // Keep the cell that was being read: its drawing is already in hand.
    const shell = archive.layerShells[archive.layerShells.length - 1];
    if (shell && frame.hasBody) shell.frames.push(frame);
    throw error;
  }
  return frame;
}

function readFrameInto(archive, frame) {
  const c = archive.cursor;
  const { elements } = frame;
  const { flag } = archive.readChildren((name, value) => {
    if (name) elements.push(value);
  });
  const body = readShapeBody(c, flag, archive.warnings);
  elements.unshift({ kind: "shape", shape: body });
  frame.hasBody = true;

  const schema = c.u8();
  const duration = c.u16();
  frame.schema = schema;
  frame.duration = duration;
  if (schema < 3) {
    c.u8();
    if (schema === 2) c.u16();
  } else {
    c.u16();
    c.u16();
    if (schema >= 5) {
      c.u16();
      if (schema !== 5) {
        const previews = c.u16();
        c.skip(previews * 8);
        if (schema !== 6) {
          c.u16();
          c.u8();
          c.u32();
          c.u32();
          if (schema !== 7) {
            c.u16();
            if (schema !== 8) {
              if (schema >= 0x17) c.readString();
              readTimelineBlock(archive, schema, frame);
            }
          }
        }
      }
    }
  }
}

/** The tween / script block of a schema 0x13+ frame (LAB_140500119). */
function readTimelineBlock(archive, schema, frame) {
  const c = archive.cursor;
  if (schema < 0x13) throw new StopDecode(`unsupported CPicFrame timeline schema ${schema}`);

  const skipWords = (count, what) => {
    if (count > (c.data.length - c.at) / 4) throw new StopDecode(`a frame ${what} runs past the stream`);
    c.skip(count * 4);
  };

  const format = c.u32();
  const variant = c.u32();
  if (format !== 0) {
    c.u32();
    skipWords(c.u32(), "timeline payload");
    if (variant === 0) {
      c.u32();
      skipWords(c.u32(), "timeline payload");
    } else if (variant >= 3) {
      throw new StopDecode(`unsupported timeline format ${variant}`);
    } else if (variant === 1 && format >= 4) {
      if (format > 4) c.u32();
      c.readString();
    }
  } else if (variant !== 1) {
    if (variant === 0) {
      c.u32();
      skipWords(c.u32(), "timeline payload");
    } else if (variant >= 3) {
      throw new StopDecode(`unsupported timeline format ${variant}`);
    }
  }

  c.u32();
  c.u32();
  c.u32();
  archive.readOptionalPointer();
  c.u32();
  archive.readOptionalPointer();

  if (schema < 0x17) {
    if (schema !== 0x13) {
      c.u32();
      if (schema !== 0x14) c.u32();
    }
  } else {
    c.readString();
    c.u32();
    c.u32();
  }
  c.u32();
  if (schema >= 0x18) {
    c.u32();
    const tracks = c.u32();
    if (tracks !== 0 && frame) {
      const easeTracks = [];
      for (let i = 0; i < 6; i += 1) {
        const segments = c.u32();
        if (segments > (c.data.length - c.at) / 0x30) throw new StopDecode(`ease track ${i} runs past the stream`);
        if (segments > 0) {
          // One segment is three (x, y) control points of a cubic bezier
          // piece; pieces share their end point with the next start.
          const points = [];
          for (let s = 0; s < segments * 3; s += 1) {
            points.push([c.f64(), c.f64()]);
          }
          easeTracks.push({ track: i, points });
        } else {
          c.skip(segments * 0x30);
        }
      }
      const ease = customEaseOf(easeTracks);
      if (ease) frame.ease = ease;
    } else if (tracks !== 0) {
      for (let i = 0; i < 6; i += 1) {
        const segments = c.u32();
        if (segments > (c.data.length - c.at) / 0x30) throw new StopDecode(`ease track ${i} runs past the stream`);
        c.skip(segments * 0x30);
      }
    }
  }
}

/**
 * The custom ease curve of a tween span, from the six per-property tracks a
 * schema 0x18+ frame records.
 *
 * Every track is a chain of cubic bezier pieces in the unit square (x = the
 * time of the span, y = how far the walk has come). A track left at its
 * default is the diagonal - the walk at even pace - so the track whose shape
 * leaves that default is the ease the author drew. When several differ the
 * first one wins; a span without a differing track walks at even pace.
 */
function customEaseOf(easeTracks) {
  if (!easeTracks || !easeTracks.length) return null;
  for (const track of easeTracks) {
    const points = track.points.filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (points.length < 2) continue;
    if (isDefaultEase(points)) continue;
    return sanitizeEase(points);
  }
  return null;
}

/**
 * Hold an ease curve to a walk that only goes forward.
 *
 * An ease that dips - a knot sitting lower than the one before it, whether a
 * number this reader reads slightly short or a quirk of the file - would
 * make the picture step back mid-walk and shake. The knots are held at the
 * height the walk has reached, and a piece's handles are held between its
 * two ends, so the curve climbs from 0 to 1 and never falls back.
 */
function sanitizeEase(points) {
  const clean = points.map((point) => [point[0], point[1]]);
  let reached = clean[0][1];
  for (const point of clean) {
    if (point[1] < reached) point[1] = reached;
    else reached = point[1];
  }
  for (let at = 0; at + 3 <= clean.length - 1; at += 3) {
    const low = Math.min(clean[at][1], clean[at + 3][1]);
    const high = Math.max(clean[at][1], clean[at + 3][1]);
    for (const handle of [clean[at + 1], clean[at + 2]]) {
      if (handle[1] < low) handle[1] = low;
      if (handle[1] > high) handle[1] = high;
    }
  }
  return clean;
}

/** Whether an ease track's points are the untouched diagonal default. */
function isDefaultEase(points) {
  if (points.length !== 6) return false;
  const stations = [0, 0, 1 / 3, 2 / 3, 1, 1];
  return points.every((p, i) => Math.abs(p[0] - stations[i]) < 1e-9 && Math.abs(p[1] - stations[i]) < 1e-9);
}

function decodeLayer(archive, pointer) {
  const c = archive.cursor;
  const frames = [];
  const shell = { kind: "layer", name: "", frames, mapIndex: pointer.object.index, partial: true };
  archive.layerShells.push(shell);
  archive.readChildren((name, value) => {
    if (name === "CPicFrame") frames.push(value);
    else if (name) throw new StopDecode(`${name} directly inside a layer`);
  });

  const schema = c.u8();
  const name = c.readString();
  let rawType = 0;
  let locked = false;
  let hidden = false;
  let current = false;
  let layerType = 0;

  let flagA = 0; // d4
  if (schema < 4) {
    c.skip(1);
  } else if (schema <= 0x1e) {
    flagA = c.u8();
    let d0 = c.u8();
    let cc = c.u8();
    if (schema === 0x0b) [d0, cc] = [cc, d0];
    locked = d0 !== 0;
    hidden = cc !== 0;
    rawType = flagA;
    if (schema === 0x0b) {
      c.u32();
      c.u32();
      c.u32();
      c.u32();
    } else {
      if (schema >= 5 && schema <= 0x1e) c.u32();
      if (schema >= 6 && schema <= 0x1e) {
        c.u32();
        c.u32();
        if (schema >= 8 && schema <= 0x1e) c.u32();
      }
    }
  }

  const c8 = c.u8();
  const parent = archive.readOptionalPointer();
  let c4 = 0;
  if (schema === 7 || schema === 8) {
    archive.readOptionalPointer();
    c.skip(1);
  } else if (schema >= 2 && schema <= 5) {
    c.skip(1);
    if (schema >= 3) c.skip(1);
  } else if (schema === 6) {
    c.skip(1);
  } else if (schema >= 9) {
    c4 = c.u8();
    if (schema !== 9) {
      c.u8();
      if (schema === 0x0d) {
        const animation = c.u8();
        if (animation >= 2) throw new StopDecode(`unsupported CS4 layer animation type ${animation}`);
      } else if (schema === 0x0b) {
        if (c8 < 2 || c8 === 3) {
          const index = c8 - 1;
          layerType = index >= 0 && index <= 3 ? [1, 0, 5, 3][index] : 0;
        } else if (c8 === 4) {
          layerType = 3;
        } else {
          throw new StopDecode(`unsupported Flash 8 layer mode ${c8}`);
        }
      }
    }
  }
  current = flagA === 1;
  void c4;
  void rawType;
  Object.assign(shell, { schema, name, locked, hidden, current, layerType, parent, partial: false });
  return shell;
}

function decodePage(archive) {
  const c = archive.cursor;
  const layers = [];
  archive.readChildren((name, value) => {
    if (name === "CPicLayer") layers.push(value);
    else if (name) throw new StopDecode(`${name} directly inside a page`);
  });

  const schema = c.u8();
  const entries = [];
  let hasCount = true;
  if (schema !== 4) {
    c.u16();
    if (schema < 5) {
      if (schema !== 3) hasCount = false;
    } else {
      c.u16();
      if (schema > 6) c.u32();
    }
  }
  if (hasCount) {
    const count = c.u32();
    if (count > (c.data.length - c.at) / 8) throw new StopDecode(`page entry count ${count} exceeds the stream`);
    for (let i = 0; i < count; i += 1) entries.push([c.u32(), c.u32()]);
  }
  return { kind: "page", schema, layers, entries };
}

function decodeObList(archive) {
  const c = archive.cursor;
  let count = c.u16();
  if (count === 0xffff) count = c.u32();
  if (count > 0x1000) throw new StopDecode(`an implausible CObList count ${count}`);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const pointer = archive.readPointer();
    if (pointer && !pointer.ref) items.push(archive.readObjectBody(pointer));
  }
  return { kind: "list", items };
}

const DECODERS = {
  CPicPage: decodePage,
  CPicLayer: decodeLayer,
  CPicFrame: decodeFrame,
  CPicShape: decodeShape,
  CPicBitmap: decodeBitmap,
  CPicSprite: decodeSprite,
  CPicSymbol: decodeSymbolInstance,
  CObList: decodeObList,
  CMorphHintItem: (archive) => {
    archive.cursor.skip(0x14);
    return { kind: "morph-hint" };
  },
};

/* ------------------------------------------------------------------ public */

const MAX_HOLD = 10000;

/**
 * Walk a whole `Page N` / `Symbol N` stream. Returns the decoded page object
 * and how far the walk got; throws `StopDecode` when a record does not follow
 * the grammar.
 */
export function walkPageStream(bytes, options = {}) {
  const archive = new Archive(bytes, options);
  const c = archive.cursor;
  if (c.u8() !== 0x01) throw new StopDecode("the stream does not start with the archive marker");
  const pointer = archive.readPointer();
  if (!pointer || pointer.ref || pointer.className !== "CPicPage") {
    throw new StopDecode("the stream does not start with a CPicPage object");
  }
  const page = archive.readObjectBody(pointer);
  return { page, bytesRead: c.at, bytesTotal: bytes.length, archive };
}

/** The layer type TVMini uses for a Flash layer mode. */
function tvminiLayerType(mode) {
  if (mode === 1) return "guide";
  if (mode === 3) return "mask";
  if (mode === 5) return "group";
  return "anim";
}

/** The stage a page that does not say its size is drawn on. */
const DEFAULT_STAGE = { width: 550, height: 400 };

/** Mix every field of two placement matrices (16.16 + twips) at `p` of the way. */
const lerpMatrix = (a, b, p) => a.map((v, i) => v + (b[i] - v) * p);

/**
 * The placed instances of a keyframe that tween into the placed instances of
 * the next one.
 *
 * A classic motion tween moves the instances a layer places, so a span
 * between two keyframes can walk them when both keyframes place the same
 * instances in the same order - the same kind of placement with the same
 * library stream id. Frames that place anything else do not tween.
 */
function tweenPairs(from, to) {
  const placed = (frame) =>
    (frame?.elements ?? []).filter(
      (element) =>
        (element.kind === "sprite" || element.kind === "symbol") &&
        Array.isArray(element.matrix),
    );
  const starts = placed(from);
  const ends = placed(to);
  if (starts.length === 0 || starts.length !== ends.length) return null;
  const pairs = new Map();
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i].streamId !== ends[i].streamId || starts[i].kind !== ends[i].kind) return null;
    pairs.set(starts[i], [starts[i], ends[i]]);
  }
  return pairs;
}

/**
 * The centre of a list of strokes in the space their points sit in, without
 * any canvas clipping. Strokes passed here are already placed by their
 * instance matrix, so the centre is in canvas (Flash) pixels.
 */
function strokeCentre(strokes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0;
  for (const stroke of strokes ?? []) {
    const pts = stroke.points ?? (stroke.paths ? stroke.paths.flat() : []);
    for (const [x, y] of pts) {
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return count ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
}

/**
 * The walk between two placement matrices as one transform of a picture.
 *
 * A picture that is placed by the `from` matrix and walks to the `to` one
 * moves along the relative matrix `to ∘ from⁻¹`. That walk fits the
 * transform of a TVMini cell - a place, one size and one turn around the
 * middle of the canvas - when the relative matrix is a size and a turn
 * without skew: a matrix a renderer cannot express as those three is not a
 * walk a cell can say.
 *
 * Returns `{ x, y, scale, rotation }`, the transform the picture carries
 * when the walk is over, or null when it cannot be said that way.
 */
function tweenTransformOf(from, to, resolveInstance, width, height) {
  const placed = (matrix) =>
    Array.isArray(matrix) && matrix.length === 6 &&
    matrix.every((n) => Number.isFinite(n))
      ? {
          a: matrix[0] / 65536,
          b: matrix[1] / 65536,
          c: matrix[2] / 65536,
          d: matrix[3] / 65536,
          tx: matrix[4] / 20,
          ty: matrix[5] / 20,
        }
      : null;
  const A = placed(from.matrix);
  const B = placed(to.matrix);
  if (!A || !B) return null;

  const detA = A.a * A.d - A.b * A.c;
  if (!Number.isFinite(detA) || Math.abs(detA) < 1e-9) return null;
  const inverse = {
    a: A.d / detA,
    b: -A.b / detA,
    c: -A.c / detA,
    d: A.a / detA,
    tx: (A.c * A.ty - A.d * A.tx) / detA,
    ty: (A.b * A.tx - A.a * A.ty) / detA,
  };

  // The relative matrix `B ∘ A⁻¹`.
  const relative = {
    a: B.a * inverse.a + B.c * inverse.b,
    b: B.b * inverse.a + B.d * inverse.b,
    c: B.a * inverse.c + B.c * inverse.d,
    d: B.b * inverse.c + B.d * inverse.d,
    tx: B.a * inverse.tx + B.c * inverse.ty + B.tx,
    ty: B.b * inverse.tx + B.d * inverse.ty + B.ty,
  };

  const scale = Math.sqrt(relative.a * relative.d - relative.b * relative.c);
  if (!Number.isFinite(scale) || scale < 1e-6 || scale > 1e6) return null;
  const reach = Math.max(1, Math.abs(relative.a), Math.abs(relative.b), Math.abs(relative.c), Math.abs(relative.d));
  if (Math.abs(relative.a - relative.d) * (1 / reach) > 1e-3) return null;
  if (Math.abs(relative.b + relative.c) * (1 / reach) > 1e-3) return null;

  // Where the same picture sits on the canvas at the start and at the end of
  // the span. Strokes are already baked by their instance matrix, so their
  // centres are in canvas (Flash) pixels with no canvas clipping - a picture
  // placed off-stage still has a real centre.
  const startStrokes = resolveInstance(from, { frameOffset: 0 });
  const endStrokes = resolveInstance(to, { frameOffset: 0 });
  const start = strokeCentre(startStrokes.strokes ?? []);
  const end = strokeCentre(endStrokes.strokes ?? []);
  if (!start || !end) return null;

  return {
    // The walk is the move of the point the picture is placed by (its
    // registration point, `tx`/`ty` of the placement matrix): Flash slides
    // that point along a straight line and turns and grows the picture around
    // it. `pivotX`/`pivotY` are where that point sat when the span started,
    // in canvas pixels. `startX`/`startY` stay the middle of the picture,
    // which a `.clip` export uses as the position of the cell.
    x: B.tx - A.tx,
    y: B.ty - A.ty,
    scale,
    rotation: (Math.atan2(relative.b, relative.a) * 180) / Math.PI,
    pivotX: A.tx,
    pivotY: A.ty,
    startX: start.x,
    startY: start.y,
  };
}

/**
 * Whether a tween span between two keyframes is one cell that moves.
 *
 * The span is such a cell when every piece of it is the same picture from
 * one end to the other - the placed instances resolve to the same strokes,
 * and both keyfields draw the same shapes of their own - and the walk
 * between the placements is one place, one size and one turn. Only then
 * does the whole walk fit in the `tween` of a single cell; anything else is
 * baked, a cell for every frame of the span.
 */
function tweenWalk(frame, next, pairs, hold, options, warnings) {
  const placed = [...pairs.keys()];
  if (placed.length !== 1) return null;
  const [from, to] = pairs.get(placed[0]);
  const resolveInstance = options.resolveInstance;
  if (!resolveInstance) return null;

  const width = Number(options.stage?.width) || 0;
  const height = Number(options.stage?.height) || 0;
  const target = tweenTransformOf(from, to, resolveInstance, width, height);
  if (!target) return null;

  // The cell that walks the span shows only the picture of its start
  // keyframe. A shape the start keyframe draws itself has no placement of
  // its own to walk, so a span whose start keyframe draws any shape of its
  // own is not one moving cell - the walking instance would drag shapes
  // that stand still in Flash. What the end keyframe adds is its own cell:
  // the walk ends on the frame the next keyframe sits on.
  const own = (frame.elements ?? []).find((el) => el.kind === "shape");
  const bodyFrom = [];
  if (own?.shape) {
    try {
      shapeToStrokes(own.shape, bodyFrom, warnings);
    } catch (error) {
      warnings.add(`a tween span could not be checked: ${error.message}`);
      return null;
    }
  }
  if (bodyFrom.length !== 0) return null;

  // The placed instance: its picture has to be the same on every frame of
  // the span - a graphic that plays its own timeline while the cell moves
  // is not a still picture.
  const pictureAt = (offset) => {
    try {
      return JSON.stringify(
        resolveInstance({ ...from, matrix: [65536, 0, 0, 65536, 0, 0] }, { frameOffset: offset }),
      );
    } catch (error) {
      warnings.add(`a tween span could not be checked: ${error.message}`);
      return null;
    }
  };
  const still = pictureAt(0);
  const stillEnd = pictureAt(hold - 1);
  if (!still || !stillEnd || still !== stillEnd) return null;
  // The pace of the walk: the custom ease the author drew for the span, if
  // the start keyframe carries one. Without it the walk is at even pace.
  if (frame.ease) target.ease = frame.ease;
  return target;
}

/**
 * Decode a page or symbol stream into the shape `binaryPageToProject` takes:
 * layers (top layer first, the way the Flash timeline shows them) whose
 * `drawings` are the keyframes of the layer.
 *
 * - `media`: `Map<mediaId, stream>` for placed bitmaps
 * - `resolveInstance(instance)`: strokes of a placed symbol / sprite, already
 *   moved by the instance matrix (the caller owns the symbol library)
 * - `trace`: optional diagnostic callback
 *
 * A stream that breaks half way still returns every layer and cell read
 * before the break, with a warning that says where it stopped.
 */
export function decodeArchivePage(pageBytes, options = {}) {
  const warnings = new Set();
  const media = options.media ?? new Map();
  const archive = new Archive(pageBytes, { warnings, trace: options.trace });
  const cursor = archive.cursor;

  let page = null;
  let failure = null;
  try {
    if (cursor.u8() !== 0x01) throw new StopDecode("the stream does not start with the archive marker");
    const pointer = archive.readPointer();
    if (!pointer || pointer.ref || pointer.className !== "CPicPage") {
      throw new StopDecode("the stream does not start with a CPicPage object");
    }
    page = archive.readObjectBody(pointer);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure = error;
    warnings.add(
      `the page stream stopped at byte ${cursor.at} of ${pageBytes.length} (${error.message}); ` +
        "everything before it was imported",
    );
  }

  const raw = page ? page.layers : archive.layerShells;
  const symbolInstances = [];

  // Flash lists layers bottom first; TVMini keeps the topmost layer at index 0.
  const ordered = [...raw].reverse();
  const positionByMap = new Map();
  ordered.forEach((layer, position) => positionByMap.set(layer.mapIndex, position));

  const layers = ordered.map((layer, position) => {
    const drawings = [];
    let at = 1;
    /**
     * Paint one frame of a layer: the strokes of its shapes and bitmaps and
     * the placed symbols resolved against their library pages. The frame
     * gets the span it was recorded with; a cell that shows nothing is not
     * written at all.
     */
    const paintFrame = (frame, offset, hold, frameAt = at, tween) => {
      const strokes = [];
      const bitmaps = [];
      for (const element of frame.elements) {
        if (element.kind === "shape") {
          shapeToStrokes(element.shape, strokes, warnings);
        } else if (element.kind === "bitmap") {
          bitmaps.push({ matrix: element.matrix, media: element.media });
        } else if (element.kind === "sprite" || element.kind === "symbol") {
          symbolInstances.push({ layerIndex: position, at: frameAt, ...element, firstFrame: (element.firstFrame ?? 0) + offset });
          if (options.resolveInstance) {
            try {
              const placed = options.resolveInstance(element, { frameOffset: offset });
              if (Array.isArray(placed)) {
                strokes.push(...placed);
              } else if (placed) {
                strokes.push(...(placed.strokes ?? []));
                bitmaps.push(...(placed.bitmaps ?? []));
              }
            } catch (error) {
              warnings.add(`a symbol instance could not be placed: ${error.message}`);
            }
          }
        }
      }
      if (strokes.length || bitmaps.length) {
        drawings.push({
          at: frameAt,
          hold,
          strokes,
          bitmaps: bitmaps.length ? bitmaps : undefined,
          ...(tween ? { tween } : {}),
        });
      }
    };

    for (let index = 0; index < layer.frames.length; index += 1) {
      const frame = layer.frames[index];
      const next = layer.frames[index + 1];
      const hold = Math.max(1, Math.min(MAX_HOLD, frame.duration || 1));
      // A span whose both ends place the same instances in the same order is
      // a tween of those instances (and a graphic that plays while it is
      // held): every frame of the span shows a state of its own, so each one
      // is painted as a cell. The matrix walks from the span's start to the
      // one of the next keyframe - a classic motion tween - and the placed
      // graphics walk the frames of their own timeline as the playhead
      // moves. The frames of a span that shows the same thing twice are
      // skipped.
      const tweened = hold > 1 && next ? tweenPairs(frame, next) : null;
      // A tween whose picture is the same from one end of the span to the
      // other, and whose walk is a place, a size and a turn, is the thing a
      // motion tween is: it stays one cell that moves, the way Flash shows
      // it, and the whole walk is in the `tween` of the cell. A tween whose
      // picture itself changes over the span - a graphic that plays, or
      // pieces that appear and go - has no single cell that says it, so
      // every frame of the span is baked as a cell of its own.
      const walking = tweened && options.resolveInstance
        ? tweenWalk(frame, next, tweened, hold, options, warnings)
        : null;
      if (!tweened) {
        paintFrame(frame, 0, hold);
      } else if (walking) {
        paintFrame(frame, 0, hold, at, walking);
      } else {
        for (let step = 0; step < hold; step += 1) {
          // The two ends of the span place the same instances in the same
          // order: the matrix of every one walks from its state at the start
          // of the span to its state at the next keyframe - a classic motion
          // tween - and the placed graphic walks the frames of its own
          // timeline as the playhead of the document moves. Every frame of
          // the span is painted as a cell; the next keyframe paints itself
          // when the walk reaches it.
          const tweenedFrame = {
            schema: frame.schema,
            elements: frame.elements.map((element) => {
              const pair = tweened.get(element);
              if (!pair) return element;
              const [from, to] = pair;
              return {
                ...element,
                matrix: step === 0 ? from.matrix : lerpMatrix(from.matrix, to.matrix, step / hold),
              };
            }),
          };
          paintFrame(tweenedFrame, step, 1, at + step);
        }
      }
      at += hold;
    }

    const parentPosition = layer.parent ? positionByMap.get(layer.parent) : undefined;
    const type = tvminiLayerType(layer.layerType);
    return {
      name: layer.name || `Layer ${position + 1}`,
      type,
      visible: !layer.hidden,
      locked: Boolean(layer.locked),
      opacity: 1,
      blend: "normal",
      preBehavior: "none",
      postBehavior: "none",
      clip: false,
      parent: parentPosition === undefined ? -1 : parentPosition,
      current: layer.current || undefined,
      drawings,
    };
  });

  // A folder has to come before the layers it holds. Flash writes folder
  // children first, so after the reversal that already holds; anything that
  // still points the wrong way is taken out of its folder.
  layers.forEach((layer, index) => {
    const parent = layer.parent;
    if (parent === -1) return;
    if (parent >= index || layers[parent]?.type !== "group") layer.parent = -1;
  });

  const active = layers.findIndex((layer) => layer.current);
  const currentLayer = active === -1 ? 0 : active;
  for (const layer of layers) delete layer.current;

  return {
    layers,
    currentLayer,
    warnings: [...warnings],
    media,
    mediaCache: new Map(),
    bytesRead: cursor.at,
    bytesTotal: pageBytes.length,
    complete: failure === null && cursor.at === pageBytes.length,
    symbolInstances,
    frameCount: layers.reduce((n, l) => n + l.drawings.length, 0),
  };
}

export { shapeToStrokes, composeCellBitmaps };
