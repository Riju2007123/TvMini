import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { MAX_SIZE, MIN_SIZE, ValidationError } from "./model.js";

/** Every Clip Studio Paint document starts with this 8-byte tag. */
export const CLIP_MAGIC = "CSFCHUNK";

const HEADER_BYTES = 0x18;
const PNG_SIGNATURE = 0x89504e47;

/**
 * Walk the CSFCHUNK container and return the embedded SQLite database.
 * Each chunk is: 8-byte ASCII name, 8-byte big-endian length, payload.
 */
export function findClipDatabase(data) {
  if (data.length < HEADER_BYTES || data.toString("ascii", 0, 8) !== CLIP_MAGIC) {
    throw new ValidationError("not a Clip Studio .clip file");
  }

  let offset = HEADER_BYTES;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    if (!/^[\x20-\x7e]{8}$/.test(name)) break;

    const size = Number(data.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(size) || size < 0 || offset + 16 + size > data.length) break;

    if (name === "CHNKSQLi") {
      return data.subarray(offset + 16, offset + 16 + size);
    }
    offset += 16 + size;
  }

  throw new ValidationError("this .clip has no embedded canvas database");
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== PNG_SIGNATURE) {
    throw new ValidationError("the .clip preview is not a PNG image");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Read the canvas preview that Clip Studio Paint stores inside its SQLite
 * database. This is a read-only import: the original .clip is never written.
 *
 * `data` is the raw file content. The caller decides where it came from, so
 * the same code serves the Node server and the browser.
 */
export async function readClipPreviewFromBytes(data) {
  const database = findClipDatabase(data);

  let row;
  let db;
  try {
    db = await openDatabase(database);
  } catch {
    throw new ValidationError("this .clip database cannot be read");
  }

  try {
    row = db
      .prepare("SELECT ImageWidth, ImageHeight, ImageData FROM CanvasPreview ORDER BY _PW_ID LIMIT 1")
      .get();
  } catch {
    throw new ValidationError("this .clip has no readable canvas preview");
  } finally {
    await db.close();
  }

  if (!row || !row.ImageData) {
    throw new ValidationError("this .clip has no canvas preview to import");
  }

  const png = Buffer.from(row.ImageData);
  const { width, height } = pngDimensions(png);

  if (width < MIN_SIZE || height < MIN_SIZE || width > MAX_SIZE || height > MAX_SIZE) {
    throw new ValidationError(
      `the .clip canvas is ${width}×${height}; TVMini supports ${MIN_SIZE}–${MAX_SIZE} px`,
    );
  }

  return { width, height, png };
}
