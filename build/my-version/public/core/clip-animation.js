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
 * The names are what make a track readable: they say which properties the
 * track animates. An animation track carries `ActionNodeClip` with a
 * `TimeClip` (`Start`, `End`, `Rate`), the blend properties `MotionBlend`,
 * `ShiftBlend`, `NextBlend` and `BlendEnable`, `Param` with `ImageCelName`
 * and `Tag`, and one `FCurve` with `Type`, `Frame`, `Value`, `LeftSlope`,
 * `RightSlope`, `Interp` and `Constant`.
 *
 * The keyframes themselves are a list of `PWFCurveKey` records, one per
 * point, and they are not decoded here: the value part of the body still has
 * to be mapped out.
 */

const MAGIC = "cmt ";

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
 * Read the header and the string pool of an action document.
 *
 * Returns null when the bytes are not an action document.
 */
export function parseActionDocument(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (data.length < 20 || data.toString("ascii", 0, 4) !== MAGIC) return null;

  const version = data.toString("ascii", 4, 8);
  const codec = data.toString("ascii", 8, 12);
  const checksum = data.readUInt32LE(12);
  const poolSize = data.readUInt32LE(16);

  const pool = [];
  let cursor = 20;
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
  return { ...document, total, compressed, unpacked: raw.length };
}
