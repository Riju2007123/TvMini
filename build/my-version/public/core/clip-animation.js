import { Buffer } from "./bytes.js";
import { inflateSync } from "./zlib.js";

/**
 * The action document that holds a track's animation.
 *
 * A `.clip` file keeps the keyframes of a track in the `TrackActionMixer` and
 * `TrackActionMixer2` columns. Both are 40 byte pointers to a blob outside
 * the database, and the blob is a zlib stream that unpacks into CSP's own
 * serialised document:
 *
 *   0x00   "cmt "        the magic
 *   0x04   4 characters  the version, "0100" or "0110"
 *   0x08   "binc"        the codec
 *   0x0C   u32           a checksum of the document
 *   0x10   u32           the number of entries in the string pool
 *   0x14                the pool, one length prefixed string per entry
 *
 * The numbers inside the document are little endian, while the numbers of
 * the blob that carries it are big endian.
 *
 * The pool starts with the type names the document uses (`null`, `Byte`,
 * `UInt16`, `Single`, `Float2`, `Matrix44`, `Float3[]` and so on) and is
 * followed by the names of the properties and the string values. The body
 * after the pool refers to those entries by their index.
 *
 * A track that shows cells carries an `ImageCelName` curve, and the curve
 * says on which frame each cell starts. That is what `readCelCurve` reads.
 */

const MAGIC = "cmt ";

/** The smallest mixer document this reader understands. */
const HEADER_SIZE = 20;

/**
 * The type names a document can start its pool with.
 *
 * The pool holds the type names first and the property names after them, so
 * the type names are the leading entries that are in this set.
 */
const TYPE_NAMES = new Set([
  "null", "Byte", "SByte", "UInt16", "Int16", "UInt32", "Int32",
  "Single", "Double", "String", "Float2", "Float3", "Double2", "Double3",
  "Quat", "Matrix44",
  "Single[]", "Byte[]", "Int32[]", "String[]", "Float2[]", "Float3[]",
  "Double[]", "Double2[]", "Double3[]", "Quat[]", "Matrix44[]",
]);

/**
 * The width of one element of each array type, and how to read it.
 *
 * Only the types a curve actually uses are read; the rest are skipped by
 * their width, so a curve with a type this reader does not know still walks
 * to its end instead of losing its place.
 */
const ELEMENTS = {
  "Byte[]": { width: 1, read: (data, at) => data[at] },
  "Single[]": { width: 4, read: (data, at) => data.readFloatLE(at) },
  "String[]": { width: 4, read: (data, at) => data.readUInt32LE(at) },
  "Int32[]": { width: 4, read: (data, at) => data.readUInt32LE(at) },
  "UInt32[]": { width: 4, read: (data, at) => data.readUInt32LE(at) },
  "Double[]": { width: 8, read: (data, at) => data.readDoubleLE(at) },
  "Float2[]": { width: 8 },
  "Float3[]": { width: 12 },
  "Double2[]": { width: 16 },
  "Double3[]": { width: 24 },
  "Quat[]": { width: 16 },
  "Matrix44[]": { width: 64 },
};

/**
 * Read the header and the string pool of an action document.
 *
 * Returns null when the bytes are not an action document.
 */
export function parseActionDocument(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (data.length < HEADER_SIZE || data.toString("ascii", 0, 4) !== MAGIC) return null;

  const version = data.toString("ascii", 4, 8);
  const codec = data.toString("ascii", 8, 12);
  const checksum = data.readUInt32LE(12);
  const poolSize = data.readUInt32LE(16);

  const pool = [];
  let cursor = HEADER_SIZE;
  for (let index = 0; index < poolSize; index += 1) {
    if (cursor >= data.length) break;
    const length = data[cursor];
    cursor += 1;
    if (cursor + length > data.length) break;
    pool.push(data.toString("ascii", cursor, cursor + length));
    cursor += length;
  }

  // The type names are the fixed set the document starts its pool with.
  const types = [];
  let index = 0;
  while (index < pool.length && TYPE_NAMES.has(pool[index])) {
    types.push(pool[index]);
    index += 1;
  }

  // The body starts with the number of type names, as a little endian
  // 32-bit number, and then holds the values.
  const hasCount = cursor + 4 <= data.length;
  const typeCount = hasCount ? data.readUInt32LE(cursor) : null;

  return {
    version,
    codec,
    checksum,
    poolSize,
    pool,
    types,
    properties: pool.slice(types.length),
    body: hasCount ? data.subarray(cursor + 4) : data.subarray(cursor),
    bodyOffset: cursor,
    typeCount,
  };
}

/**
 * The names that say what a track animates.
 *
 * Only the names that look like identifiers are kept, so the string values
 * that sit in the pool as well are left out.
 */
export function actionProperties(document) {
  if (!document) return [];
  return document.properties.filter((name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name));
}

/**
 * Unpack the action document of one external blob.
 *
 * The blob is the external locator followed by the compressed document:
 * a 40 byte header, the id text, the length of what follows, the length of
 * the compressed part and then the zlib stream.
 */
export function readActionBlob(blob) {
  if (!blob || blob.length < 60) return null;
  const total = Number(blob.readBigUInt64BE(48));
  const compressed = blob.readUInt32LE(56);
  if (60 + compressed > blob.length) return null;
  let raw;
  try {
    raw = inflateSync(blob.subarray(60, 60 + compressed));
  } catch {
    return null;
  }
  const document = parseActionDocument(raw);
  if (!document) return null;
  return { ...document, raw, total, compressed, unpacked: raw.length };
}

/**
 * Read the curve record that starts at `start`, or null when none does.
 *
 * A curve record is a small tree, and none of it is aligned, so the caller
 * tries every byte offset. The record is:
 *
 *   u32   the pool index of "FCurve"
 *   u32   0
 *   u32   how many properties follow (1 to 8)
 *   n x   u32 property name, u32 property value
 *   u32   how many fields follow
 *   n x   u32 the pool index of "Int32[]",
 *         u32 the size of the field,
 *         u32 that size plus four,
 *         u32 the field name, u32 the field type, u32 how many values,
 *         the values, u32 0, u32 0
 *
 * The three words before a field name are metadata about the array that
 * follows. Their second word is the width of the array plus 24, and their
 * third word is four more; both are checked, which is what keeps a chance
 * match from being taken for a curve.
 */
function readCurveAt(data, start, pool) {
  if (start + 12 > data.length) return null;
  if (pool[data.readUInt32LE(start)] !== "FCurve") return null;
  if (data.readUInt32LE(start + 4) !== 0) return null;

  const propertyCount = data.readUInt32LE(start + 8);
  if (propertyCount < 1 || propertyCount > 8) return null;

  let at = start + 12;
  if (at + propertyCount * 8 > data.length) return null;
  const props = new Map();
  for (let index = 0; index < propertyCount; index += 1) {
    const nameId = data.readUInt32LE(at);
    const valueId = data.readUInt32LE(at + 4);
    at += 8;
    if (nameId >= pool.length || valueId >= pool.length) return null;
    if (!props.has(pool[nameId])) props.set(pool[nameId], pool[valueId]);
  }

  // A curve always says what it animates, so a record without a `Type`
  // property is not a curve.
  const kind = props.get("Type");
  if (kind === undefined) return null;

  if (at + 4 > data.length) return null;
  const fieldCount = data.readUInt32LE(at);
  at += 4;
  if (fieldCount < 1 || fieldCount > 32) return null;

  const fields = new Map();
  for (let index = 0; index < fieldCount; index += 1) {
    if (at + 24 > data.length) return null;

    const metaType = data.readUInt32LE(at);
    const metaSize = data.readUInt32LE(at + 4);
    const metaEnd = data.readUInt32LE(at + 8);
    if (pool[metaType] !== "Int32[]") return null;

    const nameId = data.readUInt32LE(at + 12);
    const typeId = data.readUInt32LE(at + 16);
    const count = data.readUInt32LE(at + 20);
    if (nameId >= pool.length || typeId >= pool.length) return null;

    const name = pool[nameId];
    const type = pool[typeId];
    const element = ELEMENTS[type];
    if (!element) return null;

    const width = count * element.width;
    if (!Number.isSafeInteger(width) || at + 24 + width + 8 > data.length) return null;
    if (metaSize !== width + 24 || metaEnd !== metaSize + 4) return null;

    const values = [];
    const valueAt = at + 24;
    for (let item = 0; item < count; item += 1) {
      values.push(element.read ? element.read(data, valueAt + item * element.width) : null);
    }

    const tail = valueAt + width;
    if (data.readUInt32LE(tail) !== 0 || data.readUInt32LE(tail + 4) !== 0) return null;

    fields.set(name, { type, values });
    at = tail + 8;
  }

  return { kind, axis: props.get("Axis") ?? null, props, fields, start, end: at };
}

/**
 * Every curve a track document holds, in the order the document stores them.
 *
 * The records are not aligned to four bytes anywhere, so every offset is
 * tried. A record that is found is stepped over, which keeps a run of zeroes
 * inside it from being read as a second curve.
 */
export function readAnimationCurves(document) {
  if (!document?.body || !document.pool) return [];
  const { body, pool } = document;
  if (pool.indexOf("FCurve") < 0) return [];

  const curves = [];
  let start = 0;
  while (start + 12 <= body.length) {
    const curve = readCurveAt(body, start, pool);
    if (!curve) {
      start += 1;
      continue;
    }
    curves.push(curve);
    start = Math.max(start + 1, curve.end);
  }
  return curves;
}

/**
 * The cell curve of a track: on which frame each cell starts, and which cell.
 *
 * Clip Studio Paint keeps the frame in `Frame` and the name of the cell in
 * `Tag`; the two arrays line up one for one. `Frame` is a time in the 60 Hz
 * ticks the whole action document uses, so a track of a 24 fps document
 * steps by 2.5 ticks per frame and a track of a 30 fps document by 2.
 *
 * Returns null when the track shows no cells, or when its curve cannot be
 * read, so the caller can fall back on the names of the cells.
 */
export function readCelCurve(document) {
  const curve = readAnimationCurves(document).find((entry) => entry.kind === "ImageCelName");
  if (!curve) return null;

  const frames = curve.fields.get("Frame")?.values ?? [];
  const tags = curve.fields.get("Tag")?.values ?? [];
  const values = curve.fields.get("Value")?.values ?? [];
  if (!frames.length || !tags.length) return null;

  const keys = [];
  for (let index = 0; index < frames.length; index += 1) {
    const tagId = tags[index];
    const tag = tagId === undefined ? null : (document.pool[tagId] ?? null);
    // A tag is a pool index of a name; an index outside the pool is not one.
    if (tag === null) break;
    keys.push({
      // In 1/60 second, the unit of every time in an action document.
      time: Number(frames[index]),
      // The cell's index in its folder, as Clip Studio Paint numbers it.
      value: values[index] === undefined ? null : Number(values[index]),
      tag,
    });
  }
  if (!keys.length) return null;

  return { keys, start: curve.start, end: curve.end };
}

/**
 * The range a track covers, in 60 Hz ticks.
 *
 * The `TimeClip` of the track carries `Start`, `End` and `Rate` as plain
 * doubles. `End` is the last frame of the track, so a 24 fps track that ends
 * on frame 60 carries 150. The cell curve says when each cell starts, but it
 * cannot say how long the last one is held; the end of the track is that
 * answer.
 */
export function readTrackRange(document) {
  if (!document?.body || !document.pool) return null;
  const { body, pool } = document;
  const range = {};
  for (const name of ["Start", "End", "Rate"]) {
    const id = pool.indexOf(name);
    if (id < 0) continue;
    // A plain double is written as its name, its type, and the value.
    for (let at = 0; at + 12 <= body.length; at += 1) {
      if (body.readUInt32LE(at) !== id) continue;
      if (pool[body.readUInt32LE(at + 4)] !== "Double") continue;
      range[name.toLowerCase()] = body.readDoubleLE(at + 8);
      break;
    }
  }
  return Object.keys(range).length ? range : null;
}

/**
 * Where each cell of a track sits on the timeline of a project.
 *
 * A cell starts on its key and is held until the next key starts, so the
 * gaps between the keys are the holds. The last cell is held to the end of
 * the track: Clip Studio Paint keeps a cell on screen until another cell
 * replaces it, and the `End` of the track says where that stops.
 *
 * `frameRate` and `tickRate` turn the 60 Hz time of the document into
 * frames. `startFrame` is the first frame of the project, and `endFrame` is
 * its last one, used when the track does not say where it ends.
 */
export function celPlacementFromKeys(
  keys,
  { frameRate = 30, tickRate = 60, startFrame = 1, endFrame = startFrame, endTick = null } = {},
) {
  const placement = new Map();
  if (!keys?.length) return placement;

  const fps = Number(frameRate) > 0 ? Number(frameRate) : 30;
  const ticks = Number(tickRate) > 0 ? Number(tickRate) : 60;
  const frameOf = (time) => startFrame + Math.round((Number(time) * fps) / ticks);

  // Two keys can land on the same frame when the document plays slower than
  // its ticks. The later one is the cell that is left on screen.
  const byFrame = new Map();
  for (const key of keys) {
    const frame = frameOf(key.time);
    if (!Number.isFinite(frame) || !key.tag) continue;
    byFrame.set(Math.max(startFrame, frame), key.tag);
  }

  const spots = [...byFrame].map(([frame, name]) => ({ frame, name })).sort((a, b) => a.frame - b.frame);
  if (!spots.length) return placement;

  const last = Number.isFinite(endTick) ? frameOf(endTick) : Number(endFrame);
  const stop = Math.max(spots[spots.length - 1].frame, Number.isFinite(last) ? last : endFrame);

  for (let index = 0; index < spots.length; index += 1) {
    const spot = spots[index];
    const next = spots[index + 1];
    const until = next ? next.frame : stop + 1;
    const hold = Math.max(1, until - spot.frame);
    if (!placement.has(spot.name)) placement.set(spot.name, []);
    placement.get(spot.name).push({ frame: spot.frame, hold });
  }
  return placement;
}

/**
 * The curves of a camera track.
 *
 * A camera is a track of kind 2005. Its curves say how big the frame the
 * camera looks through is (`ImageCenter`, the half width on the X axis and
 * the half height on the Y axis), where that frame sits on the canvas
 * (`ImagePosition`), how far the camera is turned (`ImageRotation`) and how
 * much of the canvas it shows (`ImageScale`, in percent).
 *
 * Every curve carries the times of its keys and the value of every key, so
 * the keys of the camera are the keys that all of them share.
 */
export function readCameraCurves(document) {
  const curves = readAnimationCurves(document);
  const find = (kind, axis = null) =>
    curves.find((curve) => curve.kind === kind && (curve.axis ?? null) === axis) ?? null;

  const centreX = find("ImageCenter", "X");
  const centreY = find("ImageCenter", "Y");
  const positionX = find("ImagePosition", "X");
  const positionY = find("ImagePosition", "Y");
  const rotation = find("ImageRotation");
  const scale = find("ImageScale");
  if (!positionX || !positionY || !scale) return null;

  const frames = positionX.fields.get("Frame")?.values ?? [];
  if (!frames.length) return null;
  const value = (curve, index) => {
    const numbers = curve?.fields.get("Value")?.values ?? [];
    return numbers[index] === undefined ? null : Number(numbers[index]);
  };

  const keys = [];
  for (let index = 0; index < frames.length; index += 1) {
    const zoom = value(scale, index);
    if (zoom === null) continue;
    keys.push({
      // The time of the key, in the 60 Hz ticks of the document.
      time: Number(frames[index]),
      // The half size of the frame the camera looks through.
      centreX: value(centreX, index),
      centreY: value(centreY, index),
      // Where the middle of that frame sits on the canvas.
      positionX: value(positionX, index) ?? 0,
      positionY: value(positionY, index) ?? 0,
      rotation: value(rotation, index) ?? 0,
      // How much of the canvas the camera shows, in percent.
      scale: zoom,
    });
  }
  return keys.length ? { keys } : null;
}

/** A cell name: a frame number, with a letter for a second cell on it. */
const CELL_NAME = /^\d{1,6}[a-z]?$/i;

/**
 * The run of cell names an action document holds, in the order it stores them.
 *
 * This is the fallback for a document whose curve cannot be read. It takes
 * the longest run of consecutive pool indices that name cells, which in a
 * real file is the `Tag` array of the cell curve. The run says which cells
 * the track shows, but it does **not** say on which frame each one starts;
 * that is what the curve is for.
 *
 * Returns null when there is no run of at least two cells. A single cell is
 * indistinguishable from the other small numbers in the body.
 */
export function readCelSequence(document, accept = () => true) {
  if (!document) return null;
  const { body, pool } = document;
  if (!body || !pool || body.length < 8) return null;

  const cells = new Map();
  for (let index = 0; index < pool.length; index += 1) {
    const name = pool[index];
    if (CELL_NAME.test(name) && accept(name)) cells.set(index, name);
  }
  if (cells.size === 0) return null;

  let best = null;
  for (let start = 0; start + 8 <= body.length; start += 1) {
    // No run that starts here can beat the best one found so far.
    if (best && (body.length - start) / 4 <= best.length) break;
    const run = [];
    let at = start;
    while (at + 4 <= body.length) {
      const name = cells.get(body.readUInt32LE(at));
      if (name === undefined) break;
      run.push(name);
      at += 4;
    }
    if (run.length >= 2 && (!best || run.length > best.length)) best = run;
  }
  return best;
}

/**
 * Where each cell of a sequence sits, one frame apart.
 *
 * This is the fallback used when a track has no readable curve: the sequence
 * names the cell of every single frame, so a cell that shows on several
 * frames in a row is one drawing held for that many frames, and a cell that
 * comes back after other cells is a drawing of its own.
 */
export function celPlacement(sequence, startFrame = 1) {
  const placement = new Map();
  if (!sequence) return placement;
  let index = 0;
  while (index < sequence.length) {
    const name = sequence[index];
    let run = 1;
    while (index + run < sequence.length && sequence[index + run] === name) {
      run += 1;
    }
    if (!placement.has(name)) placement.set(name, []);
    placement.get(name).push({ frame: startFrame + index, hold: run });
    index += run;
  }
  return placement;
}
