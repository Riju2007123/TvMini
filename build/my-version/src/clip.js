import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

let sqliteModule = null;

async function loadSqlite() {
  if (!sqliteModule) {
    try {
      sqliteModule = await import("node:sqlite");
    } catch {
      throw new ValidationError("reading .clip files needs Node 22.5 or newer");
    }
  }
  return sqliteModule;
}

/**
 * Read the canvas preview that Clip Studio Paint stores inside its SQLite
 * database. This is a read-only import: the original .clip is never written.
 */
export async function readClipPreview(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }

  const clean = path.normalize(filePath.trim());
  if (path.extname(clean).toLowerCase() !== ".clip") {
    throw new ValidationError("choose a .clip file");
  }

  const data = await fs.readFile(clean);
  const database = findClipDatabase(data);
  const { DatabaseSync } = await loadSqlite();

  const temp = path.join(
    os.tmpdir(),
    `tvmini-clip-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  await fs.writeFile(temp, database);

  let row;
  try {
    let db;
    try {
      db = new DatabaseSync(temp, { readOnly: true });
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
      db.close();
    }
  } finally {
    await fs.rm(temp, { force: true });
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

  return { path: clean, name: path.basename(clean), width, height, png };
}
