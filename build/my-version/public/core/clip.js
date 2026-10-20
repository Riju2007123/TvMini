import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { MAX_SIZE, MIN_SIZE, ValidationError } from "./model.js";
import { decodeBlockPayload, parseAttribute } from "./clip-blocks.js";

/** Every Clip Studio Paint document starts with this 8-byte tag. */
export const CLIP_MAGIC = "CSFCHUNK";

/** The size of the container header that precedes the first chunk. */
export const CLIP_HEADER_SIZE = 24;

/** The prefix CSP gives to the id of a blob that lives outside the database. */
export const EXTERNAL_ID_PREFIX = "extrnlid";

const PNG_SIGNATURE = 0x89504e47;

/** The layer types CSP uses, as read out of real documents. */
const LAYER_KIND = {
  1: "raster",
  256: "root-folder",
  800: "information",
  1584: "paper",
};

/**
 * Read the container around the document.
 *
 * A `.clip` file is a flat list of chunks:
 *
 *   0x00  "CSFCHUNK"
 *   0x08  the size of the whole file
 *   0x10  the size of this header
 *   0x18  the first chunk
 *
 * Every chunk is an 8-byte ASCII name, the size of its payload as a
 * big-endian 64-bit number, and then the payload itself.
 *
 * The chunks CSP writes are `CHNKHead`, any number of `CHNKExta` blobs, the
 * `CHNKSQLi` database and a `CHNKFoot` terminator.
 */
export function parseClipContainer(input) {
  // A plain Uint8Array has no readBigUInt64BE, so wrap it first.
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (data.length < CLIP_HEADER_SIZE || data.toString("ascii", 0, 8) !== CLIP_MAGIC) {
    throw new ValidationError("not a Clip Studio .clip file");
  }

  const fileSize = Number(data.readBigUInt64BE(8));
  const headerSize = Number(data.readBigUInt64BE(16));
  if (headerSize < CLIP_HEADER_SIZE || headerSize > data.length) {
    throw new ValidationError("this .clip has a damaged container header");
  }

  const chunks = [];
  let offset = headerSize;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) {
      break;
    }
    chunks.push({
      name,
      size,
      headerOffset: offset,
      payloadOffset: offset + 16,
      payload: data.subarray(offset + 16, offset + 16 + size),
    });
    offset += 16 + size;
  }

  const head = chunks.find((chunk) => chunk.name === "CHNKHead");
  const database = chunks.find((chunk) => chunk.name === "CHNKSQLi");
  const foot = chunks.find((chunk) => chunk.name === "CHNKFoot");

  return {
    size: data.length,
    fileSize,
    headerSize,
    chunks,
    bytesConsumed: offset,
    head: head ? parseHead(head.payload) : null,
    database: database ? database.payload : null,
    databaseOffset: database ? database.headerOffset : null,
    footSize: foot ? foot.size : null,
    externals: chunks.filter((chunk) => chunk.name === "CHNKExta"),
  };
}

/**
 * Read the `CHNKHead` chunk.
 *
 * The chunk carries the format version, the file offset of the `CHNKSQLi`
 * chunk and a 16-byte document id.
 */
function parseHead(payload) {
  if (payload.length < 40) return null;
  return {
    version: Number(payload.readBigUInt64BE(0)),
    databaseOffset: Number(payload.readBigUInt64BE(8)),
    reserved: Number(payload.readBigUInt64BE(16)),
    documentId: payload.subarray(24, 40).toString("hex"),
  };
}

/**
 * Walk the CSFCHUNK container and return the embedded SQLite database.
 *
 * Any byte array is accepted; it is wrapped in a `Buffer` first because a
 * plain `Uint8Array` has neither `readBigUInt64BE` nor `toString("ascii")`.
 */
export function findClipDatabase(bytes) {
  const container = parseClipContainer(bytes);
  if (!container.database) {
    throw new ValidationError("this .clip has no embedded canvas database");
  }
  return container.database;
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
 * Read a value that CSP stores either as text or as a blob.
 *
 * `ExternalChunk.ExternalID` is text while `Offscreen.BlockData` is a blob
 * holding the same 40 characters, so both have to be read the same way.
 */
function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return Buffer.from(value).toString("ascii");
  }
  return String(value);
}

/** Classify a layer row the way CSP does. */
function layerKind(row) {
  if (Number(row.LayerFolder) !== 0) {
    return Number(row.AnimationFolder) === 1 ? "animation-folder" : "folder";
  }
  return LAYER_KIND[Number(row.LayerType)] ?? "other";
}

/**
 * Inspect the native SQLite-backed structure of a .clip file.
 *
 * This reports the structure and, where the schema allows it, the pixels.
 * It does NOT claim to decode CSP's proprietary vector layers, masks or
 * animation folders; unknown tables and columns are reported rather than
 * rewritten or discarded.
 */
export async function readClipDocumentFromBytes(data) {
  const container = parseClipContainer(data);
  if (!container.database) {
    throw new ValidationError("this .clip has no embedded canvas database");
  }

  let db;
  try {
    db = await openDatabase(container.database);
  } catch {
    throw new ValidationError("this .clip database cannot be read");
  }

  try {
    const tableRows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
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
    const countRows = (table) => {
      if (!tableSet.has(table)) return 0;
      try {
        return Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c ?? 0);
      } catch {
        return 0;
      }
    };
    const firstRow = (table) => {
      if (!tableSet.has(table)) return null;
      try {
        return db.prepare(`SELECT * FROM "${table}" LIMIT 1`).get() ?? null;
      } catch {
        return null;
      }
    };
    const allRows = (table) => {
      if (!tableSet.has(table)) return [];
      try {
        return db.prepare(`SELECT * FROM "${table}"`).all();
      } catch {
        return [];
      }
    };

    const projectRow = firstRow("Project");
    const canvasRow = firstRow("Canvas");
    const layerColumns = getColumns("Layer");

    // Every layer row, classified, plus the paint layers on their own.
    const offscreenById = new Map();
    for (const row of allRows("Offscreen")) {
      offscreenById.set(Number(row.MainId ?? 0), asText(row.BlockData));
    }
    const offscreenOfInfo = new Map();
    for (const row of allRows("MipmapInfo")) {
      offscreenOfInfo.set(Number(row.MainId ?? 0), Number(row.Offscreen ?? 0));
    }
    // A layer points at its mipmap chain with `LayerRenderMipmap`, and the
    // chain starts at `Mipmap.BaseMipmapInfo`.
    const mipmapBase = new Map();
    for (const row of allRows("Mipmap")) {
      mipmapBase.set(Number(row.MainId ?? 0), Number(row.BaseMipmapInfo ?? 0));
    }
    const baseOfLayer = new Map();
    for (const row of allRows("Layer")) {
      baseOfLayer.set(Number(row.MainId ?? 0), mipmapBase.get(Number(row.LayerRenderMipmap ?? 0)) ?? 0);
    }

    // The blobs that live outside the database, and where they sit in the file.
    // `ExternalChunk.Offset` is the offset of the `CHNKExta` chunk header.
    const externalChunks = [];
    const externalById = new Map();
    for (const row of allRows("ExternalChunk")) {
      const id = asText(row.ExternalID);
      const chunk = container.chunks.find((item) => item.headerOffset === Number(row.Offset));
      const entry = {
        id,
        offset: Number(row.Offset ?? 0),
        size: chunk ? chunk.size : null,
        present: Boolean(chunk),
      };
      externalChunks.push(entry);
      if (chunk) externalById.set(id, chunk);
    }

    /** The external blob id of the full-resolution mip level of a layer. */
    const baseBlobId = (layerId) => {
      const base = baseOfLayer.get(Number(layerId));
      if (!base) return "";
      const offscreen = offscreenOfInfo.get(base);
      if (!offscreen) return "";
      return offscreenById.get(offscreen) ?? "";
    };

    const layerTree = [];
    for (const row of allRows("Layer")) {
      layerTree.push({
        id: row.MainId,
        name: String(row.LayerName ?? ""),
        kind: layerKind(row),
        type: Number.isFinite(Number(row.LayerType)) ? Number(row.LayerType) : null,
        visible: row.LayerVisibility == null ? true : Boolean(Number(row.LayerVisibility)),
        locked: Boolean(Number(row.LayerLock ?? 0)),
        opacity: row.LayerOpacity == null ? 1 : Number(row.LayerOpacity) / 256,
        folder: Boolean(Number(row.LayerFolder ?? 0)),
        animationFolder: Boolean(Number(row.AnimationFolder ?? 0)),
        uuid: row.LayerUuid == null ? null : String(row.LayerUuid),
        nextIndex: Number(row.LayerNextIndex ?? 0),
        firstChildIndex: Number(row.LayerFirstChildIndex ?? 0),
      });
    }
    const layers = layerTree
      .filter((layer) => !layer.folder && layer.kind !== "paper")
      .map((layer) => ({
        id: layer.id,
        name: layer.name || `Layer ${layer.id}`,
        type: layer.type,
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        // A layer's pixels live in the external blob its base mip level
        // points at, so the flag says whether that blob is really there.
        pixelDataSupported: externalById.has(baseBlobId(layer.id)),
      }));

    // The mipmap chain of every raster layer, so a caller can see which
    // level holds the full-resolution pixels.
    const mipmaps = [];
    for (const mipmap of allRows("Mipmap")) {
      const chain = [];
      let infoId = mipmap.BaseMipmapInfo;
      while (infoId) {
        const info = db
          .prepare("SELECT MainId, ThisScale, Offscreen, NextIndex FROM MipmapInfo WHERE MainId = ?")
          .get(infoId);
        if (!info) break;
        chain.push({
          mainId: info.MainId,
          scale: Number(info.ThisScale ?? 0),
          offscreen: Number(info.Offscreen ?? 0),
        });
        infoId = info.NextIndex;
      }
      mipmaps.push({
        layerId: Number(mipmap.LayerId ?? 0),
        base: chain[0] ?? null,
        chain,
      });
    }

    // The animation: the timeline and the tracks that hang off it.
    const timelineRow = firstRow("TimeLine");
    const timeline = timelineRow
      ? {
          name: String(timelineRow.TimeLineName ?? ""),
          frameRate: Number(timelineRow.FrameRate ?? 0),
          startFrame: Number(timelineRow.StartFrame ?? 0),
          endFrame: Number(timelineRow.EndFrame ?? 0),
          currentFrame: Number(timelineRow.CurrentFrame ?? 0),
        }
      : null;
    const tracks = allRows("Track").map((track) => ({
      mainId: Number(track.MainId ?? 0),
      itemId: Number(track.ItemId ?? 0),
      kind: Number(track.TrackKind ?? 0),
      actionMixerSize: Number(track.TrackActionMixerSize ?? 0),
      actionMixer2Size: Number(track.TrackActionMixer2Size ?? 0),
      valueMapSize: track.TrackValueMap == null ? 0 : asText(track.TrackValueMap).length,
    }));

    // The blobs that live outside the database were resolved above; the
    // table is reported as it stands in the document.
    const tableDetails = {};
    for (const table of tables) {
      tableDetails[table] = { columns: getColumns(table), rows: countRows(table) };
    }

    return {
      format: "clip-studio-native-container",
      readOnly: true,
      width: Number(projectRow?.DefaultPageWidth ?? canvasRow?.CanvasWidth ?? 0) || null,
      height: Number(projectRow?.DefaultPageHeight ?? canvasRow?.CanvasHeight ?? 0) || null,
      projectName: String(projectRow?.ProjectName ?? ""),
      projectVersion: projectRow?.ProjectInternalVersion == null
        ? null
        : String(projectRow.ProjectInternalVersion),
      layers,
      layerTree,
      mipmaps,
      timeline,
      tracks,
      tables,
      tableDetails,
      layerColumns,
      externalChunks,
      container: {
        fileSize: container.fileSize,
        size: container.size,
        headerSize: container.headerSize,
        chunkCount: container.chunks.length,
        documentId: container.head?.documentId ?? null,
        version: container.head?.version ?? null,
        databaseOffset: container.databaseOffset,
        chunks: container.chunks.map((chunk) => ({
          name: chunk.name,
          size: chunk.size,
          offset: chunk.headerOffset,
        })),
      },
      capabilities: {
        preview: true,
        layerMetadata: tableSet.has("Layer"),
        rasterPixels: true,
        mipmaps: tableSet.has("Mipmap"),
        animationTracks: tableSet.has("Track"),
        externalBlobs: externalChunks.length > 0,
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

/**
 * Read the pixels of every raster layer in a .clip file.
 *
 * CSP keeps a layer's tiles in the `CHNKExta` chunk that the layer's
 * `Offscreen.BlockData` id points at. The tiles are decoded here, so the
 * result is a plain RGBA buffer per layer.
 *
 * A layer with no tiles, or one whose blob is missing, comes back with
 * `pixels` set to null rather than an empty image, so a caller can tell the
 * two apart.
 */
export async function readClipLayersFromBytes(data, { includePaper = false } = {}) {
  const container = parseClipContainer(data);
  if (!container.database) {
    throw new ValidationError("this .clip has no embedded canvas database");
  }

  let db;
  try {
    db = await openDatabase(container.database);
  } catch {
    throw new ValidationError("this .clip database cannot be read");
  }

  try {
    const externalById = new Map();
    for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
      const chunk = container.chunks.find((item) => item.headerOffset === Number(row.Offset));
      if (chunk) externalById.set(asText(row.ExternalID), chunk);
    }

    const mipmapById = new Map();
    for (const mipmap of db.prepare("SELECT MainId, BaseMipmapInfo FROM Mipmap").all()) {
      mipmapById.set(Number(mipmap.MainId ?? 0), Number(mipmap.BaseMipmapInfo ?? 0));
    }

    const offscreenById = new Map();
    for (const row of db.prepare("SELECT MainId, Attribute, BlockData FROM Offscreen").all()) {
      offscreenById.set(Number(row.MainId ?? 0), row);
    }

    const results = [];
    for (const layer of db
      .prepare("SELECT MainId, LayerName, LayerType, LayerFolder, LayerRenderMipmap FROM Layer")
      .all()) {
      if (Number(layer.LayerFolder ?? 0) !== 0) continue;
      const isPaper = Number(layer.LayerType ?? 0) === 1584;
      if (isPaper && !includePaper) continue;

      const baseInfo = mipmapById.get(Number(layer.LayerRenderMipmap ?? 0));
      if (!baseInfo) continue;
      const info = db
        .prepare("SELECT Offscreen FROM MipmapInfo WHERE MainId = ?")
        .get(baseInfo);
      if (!info) continue;
      const offscreen = offscreenById.get(Number(info.Offscreen ?? 0));
      if (!offscreen) continue;

      const chunk = externalById.get(asText(offscreen.BlockData));
      if (!chunk) continue;

      let attribute;
      try {
        attribute = parseAttribute(Buffer.from(offscreen.Attribute));
      } catch {
        continue;
      }

      const { pixels, records, decoded } = decodeBlockPayload(chunk.payload, attribute);
      results.push({
        id: Number(layer.MainId ?? 0),
        name: String(layer.LayerName ?? ""),
        width: attribute.width,
        height: attribute.height,
        tiles: records,
        tilesWithPixels: decoded,
        pixels,
      });
    }
    return results;
  } finally {
    await db.close();
  }
}
