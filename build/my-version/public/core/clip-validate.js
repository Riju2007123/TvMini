import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";

/**
 * A referential integrity check for a `.clip` document.
 *
 * A `.clip` file is a SQLite database plus a run of external blobs, and the
 * two halves point at each other: a layer names a mipmap, the mipmap names a
 * chain of mipmap levels, every level names an offscreen, and the offscreen
 * names the blob that holds the pixels. Clip Studio Paint follows those
 * pointers while it loads. A pointer that does not resolve does not raise an
 * error in CSP — the document opens and the layer is simply **empty or
 * transparent**. That failure is invisible from the outside, which is why it
 * has to be caught mechanically.
 *
 * The checks below are the ones that matter when a document is *written*
 * rather than read:
 *
 *  - the layer tree has to be complete: every layer reachable from the root
 *    folder, no sibling chain that loops and no chain that leaves the tree;
 *  - the mipmap chain of a layer has to have exactly as many levels as
 *    `Mipmap.MipmapCount` claims, because CSP walks that count and runs off
 *    the end of the chain if it is wrong;
 *  - every offscreen a layer points at has to have a blob behind it, or the
 *    layer opens transparent;
 *  - every `ExternalChunk` row has to point at a blob that is really in the
 *    file, and the number of rows has to match the number of blobs;
 *  - the storage type of an id matters: `Offscreen.BlockData` is a blob and
 *    `ExternalChunk.ExternalID` is text, and mixing them up breaks CSP
 *    silently.
 *
 * The module has no dependencies beyond the SQLite façade, so it runs under
 * Node and inside the browser, where the writer runs.
 */

const CLIP_MAGIC = "CSFCHUNK";
const CLIP_HEADER_SIZE = 0x18;
const CHUNK_HEADER_SIZE = 16;

/**
 * Walk the CSFCHUNK container and return the chunks it holds.
 *
 * Only the header of each chunk is read; the payloads stay where they are.
 */
function readContainer(data) {
  if (data.length < CLIP_HEADER_SIZE || data.toString("ascii", 0, 8) !== CLIP_MAGIC) {
    throw new Error("not a Clip Studio .clip file");
  }
  const fileSize = Number(data.readBigUInt64BE(8));
  const headerSize = Number(data.readBigUInt64BE(16));
  if (headerSize < CLIP_HEADER_SIZE || headerSize > data.length) {
    throw new Error("this .clip has a damaged container header");
  }

  const chunks = [];
  let offset = headerSize;
  while (offset + CHUNK_HEADER_SIZE <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size)) break;
    if (offset + CHUNK_HEADER_SIZE + size > data.length) break;
    const chunk = { name, size, headerOffset: offset };
    // The database is the only payload that is needed, and a blob only for
    // the id it carries; the rest stays in the file and is never read.
    if (name === "CHNKSQLi") {
      chunk.payload = data.subarray(offset + CHUNK_HEADER_SIZE, offset + CHUNK_HEADER_SIZE + size);
    } else if (name === "CHNKExta") {
      chunk.id = chunkIdOf(data.subarray(offset + CHUNK_HEADER_SIZE, offset + CHUNK_HEADER_SIZE + size));
    }
    chunks.push(chunk);
    offset += CHUNK_HEADER_SIZE + size;
  }

  const database = chunks.find((chunk) => chunk.name === "CHNKSQLi");
  return {
    fileSize,
    headerSize,
    chunks,
    externals: chunks.filter((chunk) => chunk.name === "CHNKExta"),
    database: database ? database.payload : null,
  };
}

/**
 * The id a blob carries.
 *
 * A `CHNKExta` payload opens with the size of the locator, the 40 character
 * id and the length of the blob that follows.
 */
function chunkIdOf(payload) {
  if (!payload || payload.length < 48) return null;
  return payload.toString("ascii", 8, 48);
}

/**
 * The text of an external id.
 *
 * The same 40 character id is stored with a different SQLite type depending
 * on the table it lives in, so it arrives either as a string or as bytes.
 */
function externalIdText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("ascii");
  return null;
}

/**
 * Whether a layer is one that holds drawing pixels.
 *
 * A folder keeps a cache of its children, the paper and the information
 * layer are not drawn, and an adjustment layer or a mask holds something
 * else entirely, so none of them need a blob of their own.
 */
function isRasterLayer(row) {
  if (!row) return false;
  const type = Number(row.LayerType) || 0;
  const folder = Number(row.LayerFolder) || 0;
  if (folder & 1) return false;
  if (type === 256 || type === 1584 || type === 800) return false;
  if (type & 4096) return false;
  if (type & 2) return false;
  return true;
}

/** A name for a table, so a missing table can be reported rather than crash. */
function tableNames(database) {
  try {
    return new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
  } catch {
    return new Set();
  }
}

/**
 * Check a `.clip` document and report what is wrong with it.
 *
 * Returns `{ ok, problems, notes, stats }`. `problems` holds the findings
 * that would make Clip Studio Paint misbehave; `notes` holds the checks that
 * could not be run because the document does not have the tables or the
 * columns they need.
 */
export async function validateClipBytes(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const problems = [];
  const notes = [];

  let container;
  try {
    container = readContainer(data);
  } catch (error) {
    return { ok: false, problems: [error.message], notes, stats: {} };
  }

  if (!container.database) {
    return {
      ok: false,
      problems: ["this .clip has no embedded canvas database"],
      notes,
      stats: {},
    };
  }

  if (container.fileSize !== data.length) {
    problems.push(
      `the header says the file is ${container.fileSize} bytes but it is ${data.length}`,
    );
  }

  const database = await openDatabase(new Buffer(container.database));
  try {
    const tables = tableNames(database);
    if (!tables.has("Layer")) {
      return {
        ok: false,
        problems: ["this .clip has no Layer table"],
        notes,
        stats: {},
      };
    }

    // --- the layer tree ---------------------------------------------------
    const layerRows = database
      .prepare(
        "SELECT MainId, LayerType, LayerFolder, LayerFirstChildIndex, LayerNextIndex, LayerRenderMipmap, LayerRenderThumbnail FROM Layer",
      )
      .all();
    const layers = new Map();
    for (const row of layerRows) layers.set(Number(row.MainId), row);

    if (tables.has("Canvas")) {
      const canvas = database.prepare("SELECT CanvasRootFolder, CanvasCurrentLayer FROM Canvas").get();
      if (canvas) {
        const root = Number(canvas.CanvasRootFolder) || 0;
        const current = Number(canvas.CanvasCurrentLayer) || 0;
        if (root && !layers.has(root)) {
          problems.push(`Canvas.CanvasRootFolder=${root} is not in Layer`);
        }
        if (current && !layers.has(current)) {
          problems.push(
            `Canvas.CanvasCurrentLayer=${current} is not in Layer (points at a deleted layer)`,
          );
        }
      }
    }

    const seen = new Set();
    const walk = (start) => {
      let node = start;
      while (node) {
        if (seen.has(node)) {
          problems.push(`layer sibling chain loops at #${node}`);
          return;
        }
        if (!layers.has(node)) {
          problems.push(`chain points at missing layer #${node}`);
          return;
        }
        seen.add(node);
        const row = layers.get(node);
        const child = Number(row.LayerFirstChildIndex) || 0;
        if (child) walk(child);
        node = Number(row.LayerNextIndex) || 0;
      }
    };
    const rootRow = tables.has("Canvas")
      ? database.prepare("SELECT CanvasRootFolder FROM Canvas").get()
      : null;
    const root = rootRow ? Number(rootRow.CanvasRootFolder) || 0 : 0;
    if (root && layers.has(root)) {
      seen.add(root);
      walk(Number(layers.get(root).LayerFirstChildIndex) || 0);
    }
    for (const id of layers.keys()) {
      if (!seen.has(id)) problems.push(`layer #${id} is unreachable from the tree`);
    }

    // --- the mipmap chains ------------------------------------------------
    const mipmaps = new Map();
    if (tables.has("Mipmap")) {
      for (const row of database.prepare("SELECT MainId, MipmapCount, BaseMipmapInfo FROM Mipmap").all()) {
        mipmaps.set(Number(row.MainId), row);
      }
    }
    const mipmapInfos = new Map();
    if (tables.has("MipmapInfo")) {
      for (const row of database.prepare("SELECT MainId, Offscreen, NextIndex FROM MipmapInfo").all()) {
        mipmapInfos.set(Number(row.MainId), row);
      }
    }
    const offscreens = new Map();
    if (tables.has("Offscreen")) {
      for (const row of database.prepare("SELECT MainId, BlockData FROM Offscreen").all()) {
        offscreens.set(Number(row.MainId), row);
      }
    }
    const thumbnails = new Map();
    if (tables.has("LayerThumbnail")) {
      for (const row of database.prepare("SELECT MainId, ThumbnailOffscreen FROM LayerThumbnail").all()) {
        thumbnails.set(Number(row.MainId), row);
      }
    }

    // The 100% level of each layer is the one that carries the pixels.
    const renderLevels = new Map();
    for (const row of layerRows) {
      const mipmapId = Number(row.LayerRenderMipmap) || 0;
      if (!mipmapId) continue;
      if (!mipmaps.has(mipmapId)) {
        problems.push(`Layer #${row.MainId}.LayerRenderMipmap=${mipmapId} is not in Mipmap`);
        continue;
      }
      const mipmap = mipmaps.get(mipmapId);
      const base = Number(mipmap.BaseMipmapInfo) || 0;
      const baseInfo = mipmapInfos.get(base);
      if (baseInfo) {
        renderLevels.set(Number(row.MainId), { offscreen: Number(baseInfo.Offscreen) || 0 });
      }
      let node = base;
      let levels = 0;
      while (node) {
        if (!mipmapInfos.has(node)) {
          problems.push(`Layer #${row.MainId} mipmap chain breaks at MipmapInfo #${node}`);
          break;
        }
        const info = mipmapInfos.get(node);
        const offscreen = Number(info.Offscreen) || 0;
        if (!offscreens.has(offscreen)) {
          problems.push(`MipmapInfo #${node}.Offscreen=${offscreen} is missing`);
        }
        node = Number(info.NextIndex) || 0;
        levels += 1;
        if (levels > 64) {
          problems.push(`Layer #${row.MainId} mipmap chain does not terminate`);
          break;
        }
      }
      // The count CSP walks has to match the chain, or CSP runs off the end.
      const count = Number(mipmap.MipmapCount) || 0;
      if (count !== levels) {
        problems.push(
          `Mipmap #${mipmapId}.MipmapCount=${count} != actual levels ${levels} (CSP walks past the end and crashes)`,
        );
      }
    }

    for (const row of layerRows) {
      const thumbnailId = Number(row.LayerRenderThumbnail) || 0;
      if (!thumbnailId) continue;
      if (!thumbnails.has(thumbnailId)) {
        problems.push(`Layer #${row.MainId}.LayerRenderThumbnail=${thumbnailId} is missing`);
        continue;
      }
      const offscreen = Number(thumbnails.get(thumbnailId).ThumbnailOffscreen) || 0;
      if (!offscreens.has(offscreen)) {
        problems.push(`LayerThumbnail #${thumbnailId}.ThumbnailOffscreen=${offscreen} is missing`);
      }
    }

    // --- orphan rows ------------------------------------------------------
    for (const table of ["Offscreen", "Mipmap", "MipmapInfo", "LayerThumbnail"]) {
      if (!tables.has(table)) continue;
      const count = database
        .prepare(
          `SELECT COUNT(*) AS n FROM [${table}] WHERE LayerId NOT IN (SELECT MainId FROM Layer)`,
        )
        .get();
      const orphans = Number(count?.n ?? count?.N ?? 0);
      if (orphans) {
        problems.push(`${table} has ${orphans} orphan rows (LayerId not in Layer)`);
      }
    }

    // --- the storage type of the ids -------------------------------------
    if (tables.has("Offscreen")) {
      const kinds = database
        .prepare("SELECT DISTINCT typeof(BlockData) AS kind FROM Offscreen")
        .all()
        .map((row) => row.kind)
        .filter(Boolean);
      if (kinds.length && (kinds.length !== 1 || kinds[0] !== "blob")) {
        problems.push("Offscreen.BlockData must be stored as blob");
      }
    }

    const externalIds = new Set();
    let externalRows = 0;
    if (tables.has("ExternalChunk")) {
      const kindRows = database
        .prepare("SELECT DISTINCT typeof(ExternalID) AS kind FROM ExternalChunk")
        .all()
        .map((row) => row.kind)
        .filter(Boolean);
      if (kindRows.length && (kindRows.length !== 1 || kindRows[0] !== "text")) {
        problems.push("ExternalChunk.ExternalID must be stored as text");
      }
      for (const row of database.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
        externalRows += 1;
        externalIds.add(externalIdText(row.ExternalID));
      }
    }

    // The columns that hold an external id. The table names them itself, so
    // a blob is looked for in all of them and not only in the offscreens.
    const externalColumns = [];
    if (tables.has("ExternalTableAndColumnName")) {
      for (const row of database
        .prepare("SELECT TableName, ColumnName FROM ExternalTableAndColumnName")
        .all()) {
        externalColumns.push([row.TableName, row.ColumnName]);
      }
    }
    if (!externalColumns.length && tables.has("Offscreen")) {
      externalColumns.push(["Offscreen", "BlockData"]);
    }

    // --- the blobs that are really in the file ----------------------------
    if (tables.has("ExternalChunk")) {
      if (externalRows !== container.externals.length) {
        problems.push(
          `ExternalChunk has ${externalRows} rows but the file has ${container.externals.length} chunks`,
        );
      }
      const offsets = new Set(container.externals.map((chunk) => chunk.headerOffset));
      for (const row of database.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
        const offset = Number(row.Offset);
        if (!offsets.has(offset)) {
          problems.push(
            `ExternalChunk ${externalIdText(row.ExternalID)} points at offset ${offset}, which is not a blob header`,
          );
        }
      }
    }

    // Every blob in the file carries its own id, and the database has to
    // name the same id. When the two disagree the layer that needs the blob
    // cannot find it, and CSP opens the layer empty.
    const chunkIds = new Set();
    for (const chunk of container.externals) {
      const id = chunk.id;
      if (!id) {
        problems.push(`the blob at offset ${chunk.headerOffset} carries no id`);
        continue;
      }
      chunkIds.add(id);
    }
    for (const id of chunkIds) {
      if (!externalIds.has(id)) {
        problems.push(`the file holds the blob ${id} but the database does not name it`);
      }
    }
    for (const id of externalIds) {
      if (!chunkIds.has(id)) {
        problems.push(`the database names the blob ${id} but the file does not hold it`);
      }
    }

    // --- the pixels a layer depends on ------------------------------------
    // Only the 100% level of a mipmap chain carries pixels. The reduced
    // levels are never written out - Clip Studio Paint rebuilds them - and
    // the folder and paper layers keep their pixels elsewhere, so a missing
    // blob only says something on the level a drawing actually lives on.
    // Clip Studio Paint's own files have layers that are empty, so this is
    // reported rather than counted as a fault.
    for (const [layerId, level] of renderLevels) {
      if (!isRasterLayer(layerRows.find((row) => Number(row.MainId) === layerId))) continue;
      const row = offscreens.get(level.offscreen);
      const id = externalIdText(row?.BlockData);
      if (!id) {
        notes.push(`layer #${layerId} has no pixels: offscreen #${level.offscreen} names no blob`);
        continue;
      }
      if (!externalIds.has(id)) {
        notes.push(
          `layer #${layerId} has no pixels in the file: offscreen #${level.offscreen} names ${id}`,
        );
      }
    }

    // A blob that nothing points at is not a fault. Clip Studio Paint keeps
    // them too - they are entities that an edit left behind - so this is
    // only worth saying out loud.
    const referenced = new Set();
    for (const [table, column] of externalColumns) {
      if (!tables.has(table)) continue;
      try {
        for (const row of database.prepare(`SELECT [${column}] AS id FROM [${table}]`).all()) {
          const id = externalIdText(row.id);
          if (id) referenced.add(id);
        }
      } catch {
        // A column the table does not have is a schema difference, not a
        // fault in the document.
      }
    }
    const unreferenced = [...externalIds].filter((id) => !referenced.has(id));
    if (unreferenced.length) {
      notes.push(
        `${unreferenced.length} blob(s) are in the file but no column points at them (Clip Studio Paint's files have those too)`,
      );
    }

    return {
      ok: problems.length === 0,
      problems,
      notes,
      stats: {
        layers: layers.size,
        offscreens: offscreens.size,
        externals: container.externals.length,
        externalRows,
        chunks: container.chunks.length,
        fileSize: data.length,
      },
    };
  } finally {
    await database.close();
  }
}
