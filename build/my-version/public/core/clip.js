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
 *
 * Any byte array is accepted; it is wrapped in a `Buffer` first because a
 * plain `Uint8Array` has neither `readBigUInt64BE` nor `toString("ascii")`.
 */
export function findClipDatabase(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
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


/**
 * Inspect the native SQLite-backed structure of a .clip file.
 *
 * This intentionally returns structural metadata and the embedded preview;
 * it does NOT claim to decode CSP's proprietary raster tile payloads. Unknown
 * tables/columns are reported rather than rewritten or discarded.
 */
export async function readClipDocumentFromBytes(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const databaseBytes = findClipDatabase(bytes);
  let db;
  try {
    db = await openDatabase(databaseBytes);
  } catch {
    throw new ValidationError("this .clip database cannot be read");
  }

  try {
    const tableRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    const tables = tableRows.map((row) => row.name).filter((name) => typeof name === "string");
    const tableSet = new Set(tables);
    const getColumns = (table) => {
      // Table names come from sqlite_master, not user input; quote identifiers.
      const quoted = `"${table.replaceAll('"', '\\"')}"`;
      try {
        return db.prepare(`PRAGMA table_info(${quoted})`).all().map((column) => column.name);
      } catch {
        return [];
      }
    };
    const firstRow = (table) => {
      if (!tableSet.has(table)) return null;
      try { return db.prepare(`SELECT * FROM "${table}" LIMIT 1`).get() ?? null; }
      catch { return null; }
    };
    const projectRow = firstRow("Project");
    const canvasRow = firstRow("Canvas");
    const layerColumns = getColumns("Layer");
    const layers = [];
    if (tableSet.has("Layer")) {
      try {
        const rows = db.prepare("SELECT * FROM Layer ORDER BY MainId").all();
        for (const row of rows) {
          const get = (...names) => {
            const key = names.find((name) => Object.hasOwn(row, name));
            return key === undefined ? undefined : row[key];
          };
          // Folder and paper rows are structural records, not paint layers.
          const type = Number(get("LayerType"));
          const folder = Number(get("LayerFolder")) !== 0;
          if (folder || type === 1584) continue;
          layers.push({
            id: get("MainId"),
            name: String(get("LayerName") ?? `Layer ${layers.length + 1}`),
            type: Number.isFinite(type) ? type : null,
            visible: get("LayerVisibility") == null ? true : Boolean(Number(get("LayerVisibility"))),
            locked: Boolean(Number(get("LayerLock") ?? 0)),
            opacity: get("LayerOpacity") == null ? 1 : Number(get("LayerOpacity")) / 256,
            // Tile bytes are not decoded by this metadata reader.
            pixelDataSupported: false,
          });
        }
      } catch {
        // A partial/variant schema should still allow preview and schema inspection.
      }
    }
    return {
      format: "clip-studio-native-container",
      readOnly: true,
      width: Number(projectRow?.DefaultPageWidth ?? canvasRow?.CanvasWidth ?? 0) || null,
      height: Number(projectRow?.DefaultPageHeight ?? canvasRow?.CanvasHeight ?? 0) || null,
      projectName: String(projectRow?.ProjectName ?? ""),
      layers,
      tables,
      layerColumns,
      capabilities: {
        preview: true,
        layerMetadata: tableSet.has("Layer"),
        editableRasterPixels: false,
        masksVectorsAndAnimation: false,
        safeRoundTripOfUnknownData: false,
      },
      limitations: [
        "Raster tile payloads are not decoded into editable pixels.",
        "This reader is inspection-only and does not modify the source file.",
        "Do not round-trip a source .clip through this app expecting unsupported CSP features to be preserved.",
      ],
    };
  } finally {
    await db.close();
  }
}
