import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { ValidationError } from "./model.js";
import { decodePng, encodePng, renderDrawingRgba, renderLayerRgba, renderProject } from "./png.js";
import { composeMatrix, transformOf, transformRgba } from "./transform.js";
import { parseClipContainer } from "./clip.js";
import { validateClipBytes } from "./clip-validate.js";
import {
  parseActionDocument,
  readActionBlob,
  readAnimationCurves,
  readCelCurve,
} from "./clip-animation.js";
import {
  celCurveFields,
  encodeMixerPayload,
  mixerColumnSize,
  newMixerId,
  replaceCurve,
  setTrackEnd,
  setTrackRange,
  spliceCameraPlan,
  spliceCelPlan,
  withStrings,
} from "./clip-mixer.js";
import {
  ALPHA_TILE,
  BLOCK_BEGIN,
  BLOCK_END,
  BLOCK_SIZE,
  EMPTY_RECORD_SIZE,
  buildBlockRecord,
  buildTrailers,
  encodeRgbaBlock,
  joinAttribute,
  parseAttribute,
  splitAttribute,
  u32,
  u64,
  utf16be,
} from "./clip-blocks.js";

const TEMPLATE_URL = new URL("../assets/clip-template.clip", import.meta.url);
const ANIMATION_TEMPLATE_URL = new URL("../assets/clip-animation-template.clip", import.meta.url);

/**
 * How the blank CSP template is loaded.
 *
 * The browser fetches it over HTTP; under Node the file is read from disk.
 * A caller can override this to supply the bytes another way.
 */
let templateLoader = async () => {
  const response = await fetch(TEMPLATE_URL);
  if (!response.ok) {
    throw new ValidationError("the .clip template could not be read");
  }
  return Buffer.from(await response.arrayBuffer());
};

/**
 * How the document with a real animation is loaded.
 *
 * It is the skeleton an animated export is built from: it holds a track of
 * Clip Studio's own, the tree of that track and the tables the timeline
 * lives in. The browser fetches it over HTTP; under Node the file is read
 * from disk.
 */
let animationTemplateLoader = async () => {
  const response = await fetch(ANIMATION_TEMPLATE_URL);
  if (!response.ok) {
    throw new ValidationError("the .clip animation template could not be read");
  }
  return Buffer.from(await response.arrayBuffer());
};

/** Replace the template loader. Returns a function that restores the old one. */
export function setTemplateLoader(loader) {
  const previous = templateLoader;
  templateLoader = loader;
  return () => {
    templateLoader = previous;
  };
}

/** Replace the animation template loader. Returns a function that restores it. */
export function setAnimationTemplateLoader(loader) {
  const previous = animationTemplateLoader;
  animationTemplateLoader = loader;
  return () => {
    animationTemplateLoader = previous;
  };
}

function grid(width, height) {
  return [Math.ceil(width / BLOCK_SIZE), Math.ceil(height / BLOCK_SIZE)];
}

/**
 * The mip levels CSP writes for a canvas.
 *
 * The public format notes stop after two consecutive 1x1 block grids. In
 * practice CSP EX 3.0.0 also needs at least four levels: files with only three
 * levels (for example 320x200 or 512x512) close while loading. Keeping a
 * fourth, fully transparent level makes those small canvases load normally.
 */
export function mipLevels(width, height) {
  const levels = [];
  let w = width;
  let h = height;
  for (;;) {
    levels.push([w, h]);
    if (
      levels.length >= 4 &&
      grid(...levels.at(-1)).join() === "1,1" &&
      grid(...levels.at(-2)).join() === "1,1"
    ) {
      return levels;
    }
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
}

/** Rebuild an Offscreen.Attribute for a new size, keeping its initial colour. */
function retargetAttribute(attribute, width, height, blockSizes) {
  const { sections } = splitAttribute(attribute);
  const [parameterSource, initColor, blockSize] = sections;
  const [cols, rows] = grid(width, height);
  const count = cols * rows;
  const sizes = blockSizes ?? Array(count).fill(EMPTY_RECORD_SIZE);
  if (sizes.length !== count) {
    throw new ValidationError("the .clip template has an inconsistent block table");
  }

  const parameter = Buffer.from(parameterSource);
  parameter.writeUInt32BE(width, 22);
  parameter.writeUInt32BE(height, 26);
  parameter.writeUInt32BE(cols, 30);
  parameter.writeUInt32BE(rows, 34);

  const channels = blockSize.readUInt32BE(30);
  const newBlockSize = Buffer.concat([
    blockSize.subarray(0, 22),
    u32(12),
    u32(count),
    u32(channels),
    ...sizes.map(u32),
  ]);

  return joinAttribute([parameter, initColor, newBlockSize]);
}

/** Empty every block record in an existing attribute while keeping its size. */
function emptyAttributeBlocks(attribute) {
  const { sections } = splitAttribute(attribute);
  const [parameter, initColor, blockSize] = sections;
  const count = blockSize.readUInt32BE(26);
  const channels = blockSize.readUInt32BE(30);
  const sizes = Array(count).fill(EMPTY_RECORD_SIZE);
  const newBlockSize = Buffer.concat([
    blockSize.subarray(0, 22),
    u32(12),
    u32(count),
    u32(channels),
    ...sizes.map(u32),
  ]);
  return joinAttribute([parameter, initColor, newBlockSize]);
}

/** Change the initial fill colour stored in an Offscreen.Attribute. */
function setInitialColor(attribute, rgba) {
  const { sections } = splitAttribute(attribute);
  const [parameter, initColorSource, blockSize] = sections;
  const initColor = Buffer.from(initColorSource);
  const packed = ((rgba[0] << 24) | (rgba[1] << 16) | (rgba[2] << 8) | rgba[3]) >>> 0;
  initColor.writeUInt32BE(1, 26);
  initColor.writeUInt32BE(packed, 30);
  return joinAttribute([parameter, initColor, blockSize]);
}

/** Replace the BlockSize[] table without moving any other field. */
function patchBlockSizes(attribute, sizes) {
  const { sections } = splitAttribute(attribute);
  const [parameter, initColor, blockSize] = sections;
  const count = blockSize.readUInt32BE(26);
  if (count !== sizes.length) {
    throw new ValidationError("the .clip template has an inconsistent block table");
  }
  const channels = blockSize.readUInt32BE(30);
  const newBlockSize = Buffer.concat([
    blockSize.subarray(0, 22),
    u32(12),
    u32(count),
    u32(channels),
    ...sizes.map(u32),
  ]);
  return joinAttribute([parameter, initColor, newBlockSize]);
}

/** The block codec lives in `clip-blocks.js` so the reader can decode it too. */
export { parseAttribute };


/** Build the CHNKExta payload for one RGBA canvas image. */
function buildPixelPayload(rgba, attribute) {
  const info = parseAttribute(attribute);
  const width = info.blockWidth;
  const height = info.blockHeight;
  const records = [];
  const sizes = [];

  for (let index = 0; index < info.cols * info.rows; index += 1) {
    const row = Math.floor(index / info.cols);
    const col = index % info.cols;
    const tile = Buffer.alloc(width * height * 4);
    const sourceWidth = Math.min(width, info.width - col * width);
    const sourceHeight = Math.min(height, info.height - row * height);
    let hasAlpha = false;

    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const source = ((row * height + y) * info.width + col * width + x) * 4;
        const target = (y * width + x) * 4;
        tile[target] = rgba[source];
        tile[target + 1] = rgba[source + 1];
        tile[target + 2] = rgba[source + 2];
        tile[target + 3] = rgba[source + 3];
        if (rgba[source + 3] !== 0) hasAlpha = true;
      }
    }

    const record = hasAlpha
      ? buildBlockRecord(index, encodeRgbaBlock(tile, width, height), width, height)
      : buildBlockRecord(index, null, width, height);
    records.push(record);
    sizes.push(record.length);
  }

  return {
    payload: Buffer.concat([...records, buildTrailers(records.length)]),
    sizes,
  };
}

function asciiExternalId(value) {
  if (!value) return null;
  const buffer = Buffer.from(value);
  const text = buffer.toString("ascii");
  return /^extrnlid[0-9A-F]{32}$/.test(text) ? text : null;
}

function newExternalId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return Buffer.from(`extrnlid${hex.toUpperCase()}`, "ascii");
}

/**
 * Read the container of the bundled template.
 *
 * The container format itself is shared with the reader, so the template is
 * parsed with the same code that parses a document CSP wrote.
 */
function parseContainer(input) {
  let container;
  try {
    container = parseClipContainer(input);
  } catch {
    throw new ValidationError("the bundled .clip template is not a Clip Studio file");
  }
  const head = container.chunks.find((chunk) => chunk.name === "CHNKHead");
  if (!head || head.size !== 40 || !container.database) {
    throw new ValidationError("the bundled .clip template is incomplete");
  }
  return {
    headerLength: container.headerSize,
    headBody: head.payload,
    database: container.database,
    footLength: container.footSize ?? 0,
  };
}

/**
 * Build the container CSP reads.
 *
 * The layout is the one CSP writes: a 24-byte header, the `CHNKHead` chunk,
 * one `CHNKExta` chunk per external blob, the `CHNKSQLi` database and the
 * `CHNKFoot` terminator. The head chunk records where the database starts,
 * and the header records the size of the whole file.
 */
function buildContainer(headBody, database, externals) {
  let position = 24 + 16 + headBody.length;
  const withOffsets = externals.map(([id, payload]) => {
    const entry = { id, payload, offset: position };
    position += 16 + 56 + payload.length;
    return entry;
  });
  const binarySectionSize = position;

  const head = Buffer.from(headBody);
  head.writeBigUInt64BE(BigInt(binarySectionSize), 8);
  // Every document CSP writes has its own id, so a new one is handed out
  // instead of the one the template came with.
  const documentId = new Uint8Array(16);
  globalThis.crypto.getRandomValues(documentId);
  Buffer.from(documentId).copy(head, 24);

  const parts = [Buffer.alloc(0)];
  parts.push(Buffer.from("CSFCHUNK", "ascii"), u64(0), u64(24));
  parts.push(Buffer.from("CHNKHead", "ascii"), u64(head.length), head);
  for (const entry of withOffsets) {
    parts.push(
      Buffer.from("CHNKExta", "ascii"),
      u64(56 + entry.payload.length),
      u64(40),
      Buffer.from(entry.id, "ascii"),
      u64(entry.payload.length),
      entry.payload,
    );
  }
  parts.push(Buffer.from("CHNKSQLi", "ascii"), u64(database.length), database);
  parts.push(Buffer.from("CHNKFoot", "ascii"), u64(0));
  const output = Buffer.concat(parts);
  output.writeBigUInt64BE(BigInt(output.length), 8);
  return output;
}

function readAll(database, sql, ...params) {
  return database.prepare(sql).all(...params);
}

function readOne(database, sql, ...params) {
  return database.prepare(sql).get(...params);
}

function nextId(database, table) {
  const row = readOne(database, "SELECT MaxIndex FROM ElemScheme WHERE TableName = ?", table);
  let next;
  if (row && row.MaxIndex !== null && row.MaxIndex !== undefined) {
    next = Number(row.MaxIndex) + 1;
    database.prepare("UPDATE ElemScheme SET MaxIndex = ? WHERE TableName = ?").run(next, table);
  } else {
    const maximum = readOne(
      database,
      `SELECT COALESCE(MAX(MainId), 0) AS value FROM [${table}]`,
    );
    next = Number(maximum.value) + 1;
    database
      .prepare("INSERT INTO ElemScheme (TableName, ElemType, MaxIndex) VALUES (?, 0, ?)")
      .run(table, next);
  }
  return next;
}

function columnsOf(database, table) {
  return readAll(database, `PRAGMA table_info([${table}])`)
    .map((column) => column.name)
    .filter((name) => name !== "_PW_ID");
}

/**
 * Give a table of the file the columns a document with an animation has.
 *
 * A blank Clip Studio document does not know about animation folders, the
 * cel a folder shows now, or the colour settings of a cel. A document with
 * an animation does, and Clip Studio reads those columns when it opens the
 * file - so the table of the written file has to have them as well. The
 * columns are added as they are, with the type and the default of the
 * skeleton, and the rows that are already there keep their values.
 */
function alignTable(database, source, table) {
  let wanted;
  try {
    wanted = readAll(source, `PRAGMA table_info([${table}])`);
  } catch {
    return;
  }
  const have = new Set(columnsOf(database, table));
  for (const column of wanted) {
    if (have.has(column.name) || column.name === "_PW_ID") continue;
    const type = column.type || "INTEGER";
    const fallback = column.notnull ? " DEFAULT 0" : "";
    database.exec(`ALTER TABLE [${table}] ADD COLUMN [${column.name}] ${type}${fallback}`);
  }
}

/**
 * Give the layer table of the file the columns a document with an animation
 * has.
 */
function alignLayerTable(database, source) {
  alignTable(database, source, "Layer");
}

/**
 * Copy the settings of a row of the skeleton onto a layer of the file.
 *
 * The identity of a layer is its own: its number, its name, its place in
 * the tree and its picture. Everything else - the flags of a cel, the
 * colour settings of a cell - comes from the row the skeleton has, so the
 * layers of the written file look like the ones Clip Studio wrote.
 */
function copyLayerSettings(database, source, sourceRow, layerId) {
  const skip = new Set([
    "_PW_ID", "MainId", "CanvasId", "LayerName", "LayerUuid", "LayerNextIndex",
    "LayerFirstChildIndex", "LayerRenderMipmap", "LayerRenderThumbnail",
    "LayerLayerMaskMipmap", "LayerLayerMaskThumbnail", "LayerFolder",
    "LayerType", "AnimationFolder", "LayerVisibility", "LayerSelect",
    "LayerLock", "LayerOpacity", "LayerComposite",
  ]);
  const columns = columnsOf(database, "Layer").filter(
    (column) => !skip.has(column) && column in sourceRow && sourceRow[column] !== null,
  );
  if (!columns.length) return;
  database
    .prepare(
      `UPDATE Layer SET ${columns.map((column) => `[${column}] = ?`).join(", ")} WHERE MainId = ?`,
    )
    .run(...columns.map((column) => sourceRow[column]), layerId);
}

function copyRow(database, table, whereColumn, whereValue, overrides) {
  const columns = columnsOf(database, table);
  const row = readOne(
    database,
    `SELECT ${columns.map((column) => `[${column}]`).join(", ")} FROM [${table}] WHERE [${whereColumn}] = ?`,
    whereValue,
  );
  if (!row) {
    throw new ValidationError(`the .clip template has no ${table} row to copy`);
  }
  const values = columns.map((column) =>
    Object.prototype.hasOwnProperty.call(overrides, column) ? overrides[column] : row[column],
  );
  database
    .prepare(
      `INSERT INTO [${table}] (${columns.map((column) => `[${column}]`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...values);
  return row;
}

function mipmapChain(database, mipmapId) {
  const chain = [];
  let infoId = readOne(database, "SELECT BaseMipmapInfo FROM Mipmap WHERE MainId = ?", mipmapId)
    ?.BaseMipmapInfo;
  while (infoId) {
    const info = readOne(
      database,
      "SELECT MainId, ThisScale, Offscreen, NextIndex FROM MipmapInfo WHERE MainId = ?",
      infoId,
    );
    if (!info) break;
    chain.push(info);
    infoId = info.NextIndex;
  }
  return chain;
}

/**
 * Take the settings of the canvas and of the page from the document the
 * animation is written from.
 *
 * The file is built from the blank template, and a blank document is an
 * illustration: it counts the frames of a timeline from zero, it has no
 * crop frame, and its page is the size of the canvas. A document with an
 * animation is different, and Clip Studio Paint reads these settings when
 * it opens the file, so they are taken from the document the animation
 * comes from: the file the project was imported from, or the document with
 * an animation in it that ships with the program.
 *
 * The size of the canvas is the writer's own. The crop frame is a rectangle
 * inside the canvas, and the page can be bigger than the canvas, so both
 * are only taken when the canvas is the size it was.
 */
function copyDocumentSettings(database, source, width, height) {
  // A document does not have to have a canvas or a page row: a skeleton
  // without them simply has nothing to copy.
  const rowOf = (db, sql) => {
    try {
      return readOne(db, sql);
    } catch {
      return null;
    }
  };
  // A blank document has no crop frame and no way of counting the frames of
  // a timeline, so the tables are given the columns of the document the
  // animation comes from first.
  alignTable(database, source, "Canvas");
  alignTable(database, source, "Project");
  const canvasRow = rowOf(source, "SELECT * FROM Canvas ORDER BY MainId LIMIT 1");
  const ownCanvas = rowOf(database, "SELECT * FROM Canvas ORDER BY MainId LIMIT 1");
  if (canvasRow && ownCanvas) {
    const sameSize =
      Number(canvasRow.CanvasWidth) === width && Number(canvasRow.CanvasHeight) === height;
    const skip = new Set([
      "_PW_ID", "MainId", "CanvasRootFolder", "CanvasCurrentLayer", "CanvasWidth", "CanvasHeight",
    ]);
    const updates = [];
    const values = [];
    for (const column of columnsOf(database, "Canvas")) {
      if (skip.has(column) || !(column in canvasRow) || canvasRow[column] === null) continue;
      if (!sameSize && /^(CropFrame|SafeFrame)/.test(column)) continue;
      updates.push(`[${column}] = ?`);
      values.push(canvasRow[column]);
    }
    if (updates.length) {
      database
        .prepare(`UPDATE Canvas SET ${updates.join(", ")} WHERE MainId = ?`)
        .run(...values, ownCanvas.MainId);
    }
  }

  // The page is a row of the Project table, which is keyed by its own
  // number and not by a MainId.
  const projectRow = rowOf(source, "SELECT * FROM Project ORDER BY _PW_ID LIMIT 1");
  const ownProject = rowOf(database, "SELECT * FROM Project ORDER BY _PW_ID LIMIT 1");
  if (projectRow && ownProject) {
    const sameSize =
      Number(canvasRow?.CanvasWidth) === width && Number(canvasRow?.CanvasHeight) === height;
    const skip = new Set(["_PW_ID", "MainId", "ProjectName"]);
    const updates = [];
    const values = [];
    for (const column of columnsOf(database, "Project")) {
      if (skip.has(column) || !(column in projectRow) || projectRow[column] === null) continue;
      // The size of the page is the size of the canvas unless the document
      // has a page of its own.
      if (!sameSize && /^DefaultPage(Width|Height|Resolution)/.test(column)) continue;
      if (!sameSize && /^DefaultPage(Crop|SafeMargin|UseCropFrame)/.test(column)) continue;
      updates.push(`[${column}] = ?`);
      values.push(projectRow[column]);
    }
    if (updates.length) {
      database
        .prepare(`UPDATE Project SET ${updates.join(", ")} WHERE _PW_ID = ?`)
        .run(...values, ownProject._PW_ID);
    }
  }
}

function cloneLayer(database, copyFrom, name, overrides) {
  const source = readOne(
    database,
    "SELECT LayerRenderMipmap, LayerRenderThumbnail FROM Layer WHERE MainId = ?",
    copyFrom,
  );
  if (!source) throw new ValidationError("the .clip template has no raster layer");
  const canvas = readOne(database, "SELECT MainId, CanvasRootFolder FROM Canvas");
  const layerId = nextId(database, "Layer");
  const mipmapId = nextId(database, "Mipmap");
  const thumbnailId = nextId(database, "LayerThumbnail");

  const chain = mipmapChain(database, source.LayerRenderMipmap);
  const infoIds = chain.map(() => nextId(database, "MipmapInfo"));
  const offscreenIds = chain.map(() => nextId(database, "Offscreen"));
  for (let index = 0; index < chain.length; index += 1) {
    copyRow(database, "Offscreen", "MainId", chain[index].Offscreen, {
      MainId: offscreenIds[index],
      CanvasId: canvas.MainId,
      LayerId: layerId,
      BlockData: newExternalId(),
    });
    copyRow(database, "MipmapInfo", "MainId", chain[index].MainId, {
      MainId: infoIds[index],
      CanvasId: canvas.MainId,
      LayerId: layerId,
      Offscreen: offscreenIds[index],
      NextIndex: index + 1 < infoIds.length ? infoIds[index + 1] : 0,
    });
  }
  copyRow(database, "Mipmap", "MainId", source.LayerRenderMipmap, {
    MainId: mipmapId,
    CanvasId: canvas.MainId,
    LayerId: layerId,
    BaseMipmapInfo: infoIds[0],
  });

  const thumbnail = readOne(
    database,
    "SELECT ThumbnailOffscreen FROM LayerThumbnail WHERE MainId = ?",
    source.LayerRenderThumbnail,
  );
  const newThumbnailOffscreen = nextId(database, "Offscreen");
  copyRow(database, "Offscreen", "MainId", thumbnail.ThumbnailOffscreen, {
    MainId: newThumbnailOffscreen,
    CanvasId: canvas.MainId,
    LayerId: layerId,
    BlockData: newExternalId(),
  });
  const thumbnailOverrides = {
    MainId: thumbnailId,
    CanvasId: canvas.MainId,
    LayerId: layerId,
    ThumbnailOffscreen: newThumbnailOffscreen,
    ThumbnailCanvasWidth: overrides.__width,
    ThumbnailCanvasHeight: overrides.__height,
  };
  // Keep these in sync with the CSP generation counter used by clipparse.
  for (const column of columnsOf(database, "LayerThumbnail")) {
    if (column.includes("NeedRefresh")) thumbnailOverrides[column] = 50;
  }
  copyRow(database, "LayerThumbnail", "MainId", source.LayerRenderThumbnail, thumbnailOverrides);

  const layerOverrides = {
    MainId: layerId,
    CanvasId: canvas.MainId,
    LayerName: name,
    LayerUuid: cryptoId(),
    LayerFirstChildIndex: 0,
    LayerNextIndex: 0,
    LayerRenderMipmap: mipmapId,
    LayerRenderThumbnail: thumbnailId,
    LayerLayerMaskMipmap: 0,
    LayerLayerMaskThumbnail: 0,
    LayerSelect: 0,
    LayerVisibility: 1,
    LightTableInfo: null,
    ...overrides,
  };
  delete layerOverrides.__width;
  delete layerOverrides.__height;
  copyRow(database, "Layer", "MainId", copyFrom, layerOverrides);

  return { layerId, mipmapId, thumbnailId };
}

function resizeCanvas(database, width, height, dpi = 72) {
  const canvas = readOne(database, "SELECT MainId, CanvasRootFolder FROM Canvas");
  const levels = mipLevels(width, height);
  database
    .prepare("UPDATE Canvas SET CanvasWidth = ?, CanvasHeight = ?, CanvasUnit = 0, CanvasResolution = ? WHERE MainId = ?")
    .run(width, height, dpi, canvas.MainId);

  const mipmaps = readAll(database, "SELECT MainId FROM Mipmap");
  for (const { MainId } of mipmaps) {
    const chain = mipmapChain(database, MainId);
    if (chain.length === 0) continue;
    const layerId = readOne(
      database,
      "SELECT LayerId FROM MipmapInfo WHERE MainId = ?",
      chain[0].MainId,
    ).LayerId;

    while (chain.length > levels.length) {
      const removed = chain.pop();
      database.prepare("DELETE FROM MipmapInfo WHERE MainId = ?").run(removed.MainId);
      database.prepare("DELETE FROM Offscreen WHERE MainId = ?").run(removed.Offscreen);
    }
    while (chain.length < levels.length) {
      const last = chain.at(-1);
      const offscreenId = nextId(database, "Offscreen");
      const infoId = nextId(database, "MipmapInfo");
      copyRow(database, "Offscreen", "MainId", last.Offscreen, {
        MainId: offscreenId,
        CanvasId: canvas.MainId,
        LayerId: layerId,
        BlockData: newExternalId(),
      });
      copyRow(database, "MipmapInfo", "MainId", last.MainId, {
        MainId: infoId,
        CanvasId: canvas.MainId,
        LayerId: layerId,
        Offscreen: offscreenId,
        NextIndex: 0,
      });
      chain.push({ MainId: infoId, ThisScale: 0, Offscreen: offscreenId, NextIndex: 0 });
    }

    for (let index = 0; index < chain.length; index += 1) {
      const info = chain[index];
      const [levelWidth, levelHeight] = levels[index];
      database
        .prepare("UPDATE MipmapInfo SET ThisScale = ?, NextIndex = ?, CanvasId = ?, LayerId = ? WHERE MainId = ?")
        .run(
          100 / 2 ** index,
          index + 1 < chain.length ? chain[index + 1].MainId : 0,
          canvas.MainId,
          layerId,
          info.MainId,
        );
      const offscreen = readOne(
        database,
        "SELECT Attribute FROM Offscreen WHERE MainId = ?",
        info.Offscreen,
      );
      const attribute = retargetAttribute(Buffer.from(offscreen.Attribute), levelWidth, levelHeight);
      database
        .prepare("UPDATE Offscreen SET Attribute = ?, CanvasId = ?, LayerId = ? WHERE MainId = ?")
        .run(attribute, canvas.MainId, layerId, info.Offscreen);
    }

    database
      .prepare("UPDATE Mipmap SET BaseMipmapInfo = ?, MipmapCount = ?, CanvasId = ?, LayerId = ? WHERE MainId = ?")
      .run(chain[0].MainId, chain.length, canvas.MainId, layerId, MainId);
  }

  // Thumbnails stay 512x512. Empty their block tables and let CSP rebuild them.
  const thumbnails = readAll(
    database,
    "SELECT o.MainId, o.Attribute FROM Offscreen o JOIN LayerThumbnail t ON t.ThumbnailOffscreen = o.MainId",
  );
  for (const thumbnail of thumbnails) {
    database
      .prepare("UPDATE Offscreen SET Attribute = ? WHERE MainId = ?")
      .run(emptyAttributeBlocks(Buffer.from(thumbnail.Attribute)), thumbnail.MainId);
  }
  database
    .prepare("UPDATE LayerThumbnail SET ThumbnailCanvasWidth = ?, ThumbnailCanvasHeight = ?")
    .run(width, height);
}

function setLayerPixels(database, layerId, rgba, pixels) {
  const layer = readOne(database, "SELECT LayerRenderMipmap FROM Layer WHERE MainId = ?", layerId);
  const mipmap = readOne(
    database,
    "SELECT BaseMipmapInfo FROM Mipmap WHERE MainId = ?",
    layer.LayerRenderMipmap,
  );
  const info = readOne(
    database,
    "SELECT Offscreen FROM MipmapInfo WHERE MainId = ?",
    mipmap.BaseMipmapInfo,
  );
  const offscreen = readOne(
    database,
    "SELECT Attribute, BlockData FROM Offscreen WHERE MainId = ?",
    info.Offscreen,
  );
  const attribute = Buffer.from(offscreen.Attribute);
  const dimensions = parseAttribute(attribute);
  if (rgba.length !== dimensions.width * dimensions.height * 4) {
    throw new ValidationError("a layer image does not match the .clip canvas");
  }
  const { payload, sizes } = buildPixelPayload(rgba, attribute);
  const id = asciiExternalId(offscreen.BlockData) ?? newExternalId().toString("ascii");
  database
    .prepare("UPDATE Offscreen SET Attribute = ?, BlockData = ? WHERE MainId = ?")
    .run(patchBlockSizes(attribute, sizes), Buffer.from(id, "ascii"), info.Offscreen);
  pixels.set(id, payload);
}

/**
 * The colour of the paper.
 *
 * Clip Studio Paint does not draw the paper from pixels: it reads the
 * colour from the document settings and from the draw colour of the paper
 * layer. Each channel sits in the top byte of a 32 bit word, so a paper that
 * is white has 0xffffffff in every one of them.
 */
function paperChannel(value) {
  return (value << 24) >>> 0;
}

function setPaperColor(database, rgba) {
  const [red, green, blue] = [rgba[0], rgba[1], rgba[2]].map(paperChannel);
  database
    .prepare("UPDATE Project SET DefaultPagePaperRed = ?, DefaultPagePaperGreen = ?, DefaultPagePaperBlue = ?")
    .run(red, green, blue);
  database
    .prepare(
      "UPDATE Layer SET DrawColorMainRed = ?, DrawColorMainGreen = ?, DrawColorMainBlue = ? WHERE LayerType = 1584",
    )
    .run(red, green, blue);

  const paper = readOne(
    database,
    "SELECT MainId, LayerRenderMipmap FROM Layer WHERE LayerType = 1584 ORDER BY MainId LIMIT 1",
  );
  if (!paper) return;
  const mipmap = readOne(
    database,
    "SELECT BaseMipmapInfo FROM Mipmap WHERE MainId = ?",
    paper.LayerRenderMipmap,
  );
  const info = readOne(
    database,
    "SELECT Offscreen FROM MipmapInfo WHERE MainId = ?",
    mipmap.BaseMipmapInfo,
  );
  const offscreen = readOne(
    database,
    "SELECT Attribute FROM Offscreen WHERE MainId = ?",
    info.Offscreen,
  );
  database
    .prepare("UPDATE Offscreen SET Attribute = ? WHERE MainId = ?")
    .run(setInitialColor(Buffer.from(offscreen.Attribute), rgba), info.Offscreen);
}

function setPreview(database, project) {
  const preview = renderProject(project);
  const png = encodePng(preview.width, preview.height, preview.data);
  const canvas = readOne(database, "SELECT MainId FROM Canvas");
  const existing = readOne(database, "SELECT MainId FROM CanvasPreview ORDER BY _PW_ID LIMIT 1");
  if (existing) {
    database
      .prepare("UPDATE CanvasPreview SET CanvasId = ?, ImageType = 1, ImageWidth = ?, ImageHeight = ?, ImageData = ? WHERE MainId = ?")
      .run(canvas.MainId, project.width, project.height, png, existing.MainId);
  } else {
    database
      .prepare("INSERT INTO CanvasPreview (CanvasId, ImageType, ImageWidth, ImageHeight, ImageData) VALUES (?, 1, ?, ?, ?)")
      .run(canvas.MainId, project.width, project.height, png);
  }
}

/**
 * Write the frame rate and the frame range of the project into the timeline.
 *
 * The template carries the timeline of the document it was made from, so the
 * numbers are replaced with the ones the project actually has. A document
 * without a timeline (the bundled template is a static one) is left alone.
 */
function setTimeline(database, project) {
  const hasTimeline = readAll(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'TimeLine'",
  );
  if (hasTimeline.length === 0) return;
  const timeline = readOne(database, "SELECT MainId FROM TimeLine LIMIT 1");
  if (!timeline) return;
  let end = project.startFrame - 1;
  for (const layer of project.layers ?? []) {
    for (const drawing of layer.drawings ?? []) {
      end = Math.max(end, drawing.at + drawing.hold - 1);
    }
  }
  if (project.camera && Array.isArray(project.camera.keys)) {
    for (const key of project.camera.keys) {
      end = Math.max(end, key.frame);
    }
  }
  database
    .prepare(
      "UPDATE TimeLine SET FrameRate = ?, StartFrame = ?, EndFrame = ?, CurrentFrame = ? WHERE MainId = ?",
    )
    .run(
      Math.max(1, Math.round(project.fps ?? 12)),
      project.startFrame ?? 1,
      Math.max(project.startFrame ?? 1, end),
      project.currentFrame ?? project.startFrame ?? 1,
      timeline.MainId,
    );
}

/**
 * Put the project layers into the tree their `parent` fields describe.
 *
 * The project keeps its layers in one list, top first, and every layer says
 * which folder holds it. A layer whose folder is missing sits at the top
 * level, so nothing is lost.
 */
function buildTree(layers) {
  const nodes = layers.map((layer) => ({ layer, layerId: 0, children: [], parent: -1 }));
  const roots = [];
  nodes.forEach((node, index) => {
    const parent = node.layer.parent ?? -1;
    if (parent >= 0 && parent < nodes.length && parent !== index) {
      nodes[parent].children.push(index);
      node.parent = parent;
    } else {
      roots.push(index);
    }
  });

  // A parent chain that loops would hide its layers, so anything the roots do
  // not reach is put at the top level as well.
  const reached = new Set();
  const walk = (index) => {
    if (reached.has(index)) return;
    reached.add(index);
    for (const child of nodes[index].children) walk(child);
  };
  roots.forEach(walk);
  for (let index = 0; index < nodes.length; index += 1) {
    if (!reached.has(index)) roots.push(index);
  }
  return { nodes, roots };
}

/**
 * The node of the tree that holds a layer of a given uuid.
 *
 * The uuid of a layer is written with dashes on the layer and without them
 * on the track, so the two are compared with the dashes taken out.
 */
function nodeOfUuid(tree, uuid) {
  if (!uuid) return null;
  const key = String(uuid).replace(/-/g, "").toLowerCase();
  for (const node of tree.nodes) {
    const layer = node.layer;
    if (!layer?.uuid) continue;
    if (String(layer.uuid).replace(/-/g, "").toLowerCase() === key) return node;
  }
  return null;
}

/**
 * The transforms of the folders above a layer.
 *
 * A cell that is a folder of layers is moved as a whole, so the layers
 * inside it are moved with it.
 */
function transformsAbove(tree, index) {
  const transforms = [];
  const seen = new Set();
  let at = tree.nodes[index].parent;
  while (at >= 0 && at < tree.nodes.length && !seen.has(at)) {
    seen.add(at);
    const layer = tree.nodes[at].layer;
    if (layer?.transform) transforms.unshift(layer.transform);
    at = tree.nodes[at].parent;
  }
  return transforms;
}

/** Link a list of layers as siblings, from the bottom of the canvas up. */
function linkSiblings(database, ids) {
  for (let index = 0; index < ids.length; index += 1) {
    database
      .prepare("UPDATE Layer SET LayerNextIndex = ? WHERE MainId = ?")
      .run(index + 1 < ids.length ? ids[index + 1] : 0, ids[index]);
  }
}

/**
 * Write the composition of the canvas: the layers it holds, in the order
 * they are stacked.
 *
 * The `LayerComp` table holds a blob with one entry per layer of the
 * canvas: the 16 bytes of its uuid and four words of settings. A document
 * that was written without this says that its canvas holds the layers of
 * the template, and Clip Studio Paint then shows a canvas without the
 * layers that were added - the cells of an animation among them.
 *
 * The order is the order of the canvas, from the bottom up: the paper
 * first, then the children of a folder before the folder itself. The root
 * of the tree and the story information are not layers of the canvas and
 * are left out, the way Clip Studio Paint leaves them out.
 */
function writeComposition(database, tree, floor, rootId) {
  const comp = readOne(database, "SELECT MainId, CompLayerInfo FROM LayerComp ORDER BY _PW_ID LIMIT 1");
  if (!comp) return;

  // The words every entry carries around its uuid. The template's own entry
  // is the model: the size of an entry, the size of a uuid, and eight bytes
  // of settings. A document without a composition is left alone.
  //
  // The blob is a header of two words - the version and the number of
  // entries - and then the entries, one after the other.
  const previous = Buffer.from(comp.CompLayerInfo ?? Buffer.alloc(0));
  const entryPrefix = previous.length >= 40 ? previous.subarray(8, 16) : null;
  const entrySettings = previous.length >= 40 ? previous.subarray(32, 40) : null;
  if (!entryPrefix || !entrySettings) return;

  // The layers of the canvas, from the bottom up.
  const order = [];
  const byId = new Map();
  for (const node of tree.nodes) byId.set(node.layerId, node);
  const rowOf = (layerId) =>
    readOne(database, "SELECT LayerUuid, LayerType, LayerName FROM Layer WHERE MainId = ?", layerId);

  const walk = (layerId, depth) => {
    const row = rowOf(layerId);
    if (!row) return;
    const type = Number(row.LayerType ?? 0);
    // The story information is the document's own metadata, not a layer.
    if (type === 800) return;
    const children = [];
    let at = Number(
      readOne(database, "SELECT LayerFirstChildIndex FROM Layer WHERE MainId = ?", layerId)
        ?.LayerFirstChildIndex ?? 0,
    );
    const seen = new Set();
    while (at && !seen.has(at)) {
      seen.add(at);
      children.push(at);
      at = Number(
        readOne(database, "SELECT LayerNextIndex FROM Layer WHERE MainId = ?", at)?.LayerNextIndex ?? 0,
      );
    }
    for (const child of children) walk(child, depth + 1);
    order.push(row);
  };

  for (const layerId of floor) walk(layerId, 0);
  for (const index of [...tree.roots].reverse()) walk(tree.nodes[index].layerId, 0);

  const parts = [];
  const header = Buffer.from(previous.subarray(0, 8));
  header.writeUInt32BE(order.length, 4);
  parts.push(header);
  for (const row of order) {
    parts.push(entryPrefix, uuidBytes(row.LayerUuid), entrySettings);
  }
  database
    .prepare("UPDATE LayerComp SET CompLayerInfo = ? WHERE MainId = ?")
    .run(Buffer.concat(parts), comp.MainId);
}

/**
 * Link the layers the way Clip Studio stores them.
 *
 * The tree is a linked list: a folder points at its first child, and every
 * layer points at the next sibling. A chain starts at the bottom of the
 * canvas, so each list is turned around here. `floor` holds the layers that
 * sit under everything else, the paper first.
 */
function linkTree(database, tree, floor, rootId) {
  const top = [...tree.roots].reverse();
  const chain = [...floor, ...top.map((index) => tree.nodes[index].layerId)];
  linkSiblings(database, chain);
  database
    .prepare("UPDATE Layer SET LayerFirstChildIndex = ? WHERE MainId = ?")
    .run(chain[0] ?? 0, rootId);

  const walk = (indexes) => {
    for (const index of indexes) {
      const node = tree.nodes[index];
      // The children of a folder are stacked the way the canvas stacks
      // them: the first child is the lowest one. The cells of a row are
      // the exception: Clip Studio keeps them in the order they play, so
      // the first cell is the one that shows first.
      const kids =
        node.row === true || node.playOrder === true
          ? [...node.children]
          : [...node.children].reverse();
      linkSiblings(database, kids.map((child) => tree.nodes[child].layerId));
      database
        .prepare("UPDATE Layer SET LayerFirstChildIndex = ? WHERE MainId = ?")
        .run(kids.length > 0 ? tree.nodes[kids[0]].layerId : 0, node.layerId);
      walk(kids);
    }
  };
  walk(top);
}

/**
 * Whether a node of the tree is a folder in Clip Studio.
 *
 * A group of the project is a folder, and so is a row of the timeline: the
 * cells of a row live in a folder of their own.
 */
function isFolderNode(node) {
  return node.layer.type === "group" || node.row === true;
}

/**
 * How the cells of a row are ordered: by number, a letter after its number.
 *
 * Clip Studio names the cells of a row with the numbers of the frames they
 * show, so "5" comes before "5a" and both come before "6".
 */
function cellOrderKey(name) {
  const match = /^(\d+)(.*)$/.exec(String(name ?? "").trim());
  return match
    ? { number: Number(match[1]), suffix: match[2] }
    : { number: Infinity, suffix: String(name ?? "") };
}

/**
 * The rows of the timeline a project turns into, and the cells on them.
 *
 * Clip Studio keeps the cells of a row inside an animation folder: a cell
 * is a layer of its own, and the track of the folder says which cell shows
 * when. A TVMini layer that holds drawings is such a row - every drawing
 * becomes a cell of its folder. A group whose children are cells is a row
 * as well: that is the shape a document that came from Clip Studio already
 * has, and those cells are layers that are already there.
 *
 * The frame a cell sits on is its own drawing's, or the earliest of the
 * drawings inside it, because a cell that is a folder holds its picture in
 * layers of its own.
 */
function animationRows(tree) {
  const frameOf = (index, depth = 0) => {
    const layer = tree.nodes[index].layer;
    if (layer.drawings?.length) return layer.drawings[0].at;
    if (depth >= 8) return null;
    const frames = tree.nodes[index].children
      .map((child) => frameOf(child, depth + 1))
      .filter((frame) => frame !== null);
    return frames.length ? Math.min(...frames) : null;
  };

  // The last frame the artwork of a node covers. A cell of a row can be a
  // folder of its own, and then its picture sits in the layers inside it, so
  // the frames are looked for down there as well.
  const lastFrameOf = (index, depth = 0) => {
    const layer = tree.nodes[index].layer;
    let last = -Infinity;
    for (const drawing of layer.drawings ?? []) {
      last = Math.max(last, drawing.at + drawing.hold - 1);
    }
    if (last !== -Infinity) return last;
    if (depth >= 8) return -Infinity;
    for (const child of tree.nodes[index].children) {
      last = Math.max(last, lastFrameOf(child, depth + 1));
    }
    return last;
  };

  // The parent of every node, so a node that sits inside a row can be found.
  const parentOf = new Map();
  tree.nodes.forEach((node, index) => {
    for (const child of node.children) parentOf.set(child, index);
  });

  // A group whose children are cells is a row of cells. A folder may also
  // hold layers that are not cells of it - a document can hold a cell that
  // its track does not show - and those stay ordinary layers of the folder.
  const candidates = [];
  for (let index = 0; index < tree.nodes.length; index += 1) {
    const node = tree.nodes[index];
    if (node.layer.type !== "group" || node.children.length === 0) continue;
    const cells = [];
    for (const child of node.children) {
      const childLayer = tree.nodes[child].layer;
      if (childLayer.preBehavior !== "none") continue;
      const at = frameOf(child);
      if (at === null) continue;
      const drawing = childLayer.drawings?.[0] ?? null;
      // How long the cell shows. Clip Studio holds a cell until the next one
      // starts, and the last cell of a row until the end of its track, so the
      // writer has to know how far the cell reaches.
      const last = lastFrameOf(child);
      const hold = last === -Infinity ? (drawing?.hold ?? 1) : last - at + 1;
      cells.push({ name: childLayer.name || String(cells.length + 1), at, hold, drawing, child });
    }
    if (cells.length === 0) continue;
    cells.sort((one, two) => one.at - two.at);
    candidates.push({ index, node, cells });
  }

  // A group that sits inside another group of cells is a cell of that one:
  // the cells of an animation folder can be folders of their own, and the
  // layers inside such a cell are not rows of their own.
  const candidateNodes = new Set(candidates.map((one) => one.node));
  const insideAny = (index, nodes) => {
    let at = parentOf.get(index);
    while (at !== undefined) {
      if (nodes.has(tree.nodes[at])) return true;
      at = parentOf.get(at);
    }
    return false;
  };
  const rows = candidates.filter((one) => !insideAny(one.index, candidateNodes));

  // The cells of a row that came from a Clip Studio document are stored in
  // the order they play: 1, 2, 3, 5, 5a, 6. The project keeps them in the
  // order the timeline shows them, which is not the order of the document
  // (a cell that is not on the timeline sorts by its name, among the ones
  // that are), so the chain is written the way Clip Studio writes it: by
  // cell name, numbers first, a letter after its number.
  for (const row of rows) {
    const order = new Map(row.node.children.map((child, position) => [child, position]));
    row.node.children = [...row.node.children].sort((one, two) => {
      const a = cellOrderKey(tree.nodes[one].layer.name);
      const b = cellOrderKey(tree.nodes[two].layer.name);
      return (
        a.number - b.number ||
        (a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0) ||
        order.get(one) - order.get(two)
      );
    });
    row.node.playOrder = true;
  }

  // A layer with more than one cell is a row of cells as well, and the cells
  // are made here: one layer for every drawing. A layer with a single
  // drawing stays an ordinary layer, and a layer that sits inside a row is a
  // cell of that row and not a row of its own.
  const rowNodes = new Set(rows.map((row) => row.node));
  for (let index = 0; index < tree.nodes.length; index += 1) {
    const node = tree.nodes[index];
    const drawings = node.layer.drawings ?? [];
    if (node.layer.type === "group" || drawings.length < 2) continue;
    if (insideAny(index, rowNodes)) continue;
    const cells = drawings.map((drawing, order) => ({
      name: drawing.name || String(order + 1),
      at: drawing.at,
      hold: drawing.hold ?? 1,
      drawing,
    }));
    cells.sort((one, two) => one.at - two.at);
    node.row = true;
    rows.push({ node, cells });
  }

  rows.sort((one, two) => tree.nodes.indexOf(one.node) - tree.nodes.indexOf(two.node));
  return rows;
}

/**
 * Give every row the cell layers it needs.
 *
 * The cells of a row that came from a Clip Studio document are layers that
 * are already there. The cells of a row that came from a layer with
 * drawings are made here: each one is a layer of its own that holds the
 * picture of its drawing.
 */
function expandRows(tree, rows) {
  for (const row of rows) {
    if (row.cells.some((cell) => cell.child !== undefined)) continue;
    const indexes = [];
    for (const cell of row.cells) {
      indexes.push(tree.nodes.length);
      tree.nodes.push({
        layer: {
          name: cell.name,
          type: "anim",
          visible: true,
          locked: false,
          opacity: 1,
          drawings: cell.drawing ? [cell.drawing] : [],
        },
        layerId: 0,
        children: [],
        cel: cell,
      });
    }
    row.node.children.push(...indexes);
  }
  return tree;
}

/** The types of the fields of a curve, so a rewrite keeps the document's own. */
function curveFieldTypes(curve) {
  const types = {};
  for (const [name, field] of curve.fields) types[name] = field.type;
  return types;
}

/**
 * The parts of a real document a written animation is copied from.
 *
 * A new track needs Clip Studio Paint's own `TimeClip` and `Param` tree, and
 * inventing that tree is the one thing that could make Paint reject a file
 * that otherwise opens. The `.clip` the project was imported from already
 * holds a cell track, so that track is used as the skeleton: its table
 * definitions are reused as they are, and its documents are copied with only
 * the cell curve replaced.
 *
 * The track of the paper is copied as well. It holds the range of the whole
 * timeline - the start, the end and the rate - so the document says how long
 * the animation runs.
 */
function animationSkeleton(source, container) {
  const tables = {};
  for (const name of ["TimeLine", "Track"]) {
    const row = readOne(
      source,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      name,
    );
    if (!row?.sql) return null;
    tables[name] = row.sql;
  }

  const timeline = readOne(source, "SELECT * FROM TimeLine ORDER BY _PW_ID LIMIT 1");
  const track = readOne(
    source,
    "SELECT * FROM Track WHERE TrackKind = 2000 ORDER BY _PW_ID LIMIT 1",
  );
  if (!timeline || !track) return null;

  const blobOf = (value) => {
    if (!value) return null;
    const id = Buffer.from(value).toString("ascii");
    const chunk = container.chunks.find(
      (entry) => entry.name === "CHNKExta" && entry.payload.toString("ascii", 8, 48) === id,
    );
    return chunk ? readActionBlob(chunk.payload) : null;
  };

  const second = blobOf(track.TrackActionMixer2);
  const first = blobOf(track.TrackActionMixer);
  if (!second || !first) return null;
  const curve = readAnimationCurves(second).find((entry) => entry.kind === "ImageCelName");
  if (!curve) return null;

  // The paper's own track: it carries the range of the timeline.
  const paperRow = readOne(
    source,
    "SELECT * FROM Track WHERE TrackKind = 2003 ORDER BY _PW_ID LIMIT 1",
  );
  const paper = paperRow
    ? {
        track: paperRow,
        first: blobOf(paperRow.TrackActionMixer),
        second: blobOf(paperRow.TrackActionMixer2),
      }
    : null;

  // The rows of a document with an animation: the folder that holds the
  // cells, and one of the cells itself. Their settings are copied onto the
  // layers of the written file, so those look like the ones Clip Studio
  // wrote rather than like the ones of a blank document. A skeleton
  // without a layer table simply has nothing to copy.
  const layerRow = (sql, ...params) => {
    try {
      return readOne(source, sql, ...params);
    } catch {
      return null;
    }
  };
  const folderRow = layerRow(
    "SELECT * FROM Layer WHERE AnimationFolder = 1 ORDER BY MainId LIMIT 1",
  );
  const celRow = folderRow
    ? layerRow(
        "SELECT * FROM Layer WHERE LayerFirstChildIndex <> 0 AND MainId <> ? ORDER BY MainId LIMIT 1",
        folderRow.MainId,
      )
    : null;
  // The paper: the layer the background of the document is drawn on.
  const paperLayerRow = layerRow(
    "SELECT * FROM Layer WHERE LayerType = 1584 ORDER BY MainId LIMIT 1",
  );

  // The camera of the document, when it has one: the track of kind 2005 with
  // its two mixers, and the folder (a layer of type 512) it hangs on. A
  // camera's tree is copied from a real document the same way a cell track
  // is, because the only part of it this writer understands is the six
  // curves; the rest is carried over untouched.
  const cameraRow = layerRow(
    "SELECT * FROM Track WHERE TrackKind = 2005 ORDER BY _PW_ID LIMIT 1",
  );
  const camera = cameraRow
    ? {
        track: cameraRow,
        first: blobOf(cameraRow.TrackActionMixer),
        second: blobOf(cameraRow.TrackActionMixer2),
      }
    : null;
  const cameraLayerRow = layerRow(
    "SELECT * FROM Layer WHERE LayerType = 512 ORDER BY MainId LIMIT 1",
  );

  // The tracks of a document that are not cell tracks: the track of a layer
  // (kind 2001), the track of the cel folder (kind 1000) and the track of
  // the play time (kind 4000). They hold no cells, so the cells of a
  // document do not depend on them, but Clip Studio Paint shows a layer in
  // its timeline only when the layer has a track.
  const extraTracks = [];
  for (const row of readAll(
    source,
    "SELECT * FROM Track WHERE TrackKind IN (1000, 2001, 4000) ORDER BY _PW_ID",
  )) {
    const first = blobOf(row.TrackActionMixer);
    const second = blobOf(row.TrackActionMixer2);
    if (!first || !second) continue;
    extraTracks.push({
      kind: Number(row.TrackKind),
      flags: Number(row.TrackOptionFlag),
      uuid: row.LayerUuidWithTrack
        ? Buffer.from(row.LayerUuidWithTrack).toString("hex")
        : null,
      first,
      second,
    });
  }

  return {
    tables,
    timeline,
    track,
    paper,
    first,
    second,
    types: curveFieldTypes(curve),
    folderRow,
    celRow,
    paperLayerRow,
    camera: camera?.first && camera?.second ? camera : null,
    cameraLayerRow,
    extraTracks,
  };
}

/** The 16 bytes a layer uuid string stands for. */
function uuidBytes(value) {
  const hex = String(value).replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Insert a row built from a row that was read, with some fields replaced. */
function insertRow(database, table, source, overrides) {
  const row = { ...source, ...overrides };
  const keys = Object.keys(row).filter((key) => key !== "_PW_ID");
  database
    .prepare(
      `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(", ")}) ` +
      `VALUES (${keys.map(() => "?").join(", ")})`,
    )
    .run(...keys.map((key) => row[key]));
}

/**
 * Write the animation of a project into a `.clip` under construction.
 *
 * The mixer of a track is the action document described in `clip-mixer.js`.
 * Here the cell curve is replaced: the names of the cells become the `Tag`
 * string values, their frames become the `Frame` times in 60 Hz ticks, and
 * the range of the track follows the range of the project. Both mixers of a
 * track are written, the newer one and the older one, so that whichever of
 * the two Clip Studio reads, it reads the same cells.
 *
 * The camera of the project is a track of kind 2005: the six curves of its
 * mixer (`ImageCenter`, `ImagePosition`, `ImageRotation`, `ImageScale`) are
 * spliced from the keys of `project.camera` into the camera track the
 * skeleton carries, and the track is bound to the folder of the project that
 * says it is the camera (a layer of type 512). A skeleton with no camera
 * track has no tree to copy, so a project exported from one gets no camera.
 *
 * `skeleton` comes from a real document, so every part of the tree the
 * writer does not understand is copied rather than made up. Returns the
 * number of cell tracks that were written; the paper's track and the camera
 * are not counted.
 */
function writeAnimation(database, tree, project, skeleton, pixels, rows, source) {
  if (!columnsOf(database, "Layer").includes("AnimationFolder")) {
    database.exec("ALTER TABLE Layer ADD COLUMN AnimationFolder INTEGER DEFAULT NULL");
  }
  // A document with an animation has more columns in its layer table than a
  // blank one, and Clip Studio reads them when it opens the file.
  if (source) alignLayerTable(database, source);
  for (const sql of [skeleton.tables.TimeLine, skeleton.tables.Track]) {
    const name = /CREATE TABLE\s+"?(\w+)/i.exec(sql)?.[1];
    if (name && columnsOf(database, name).length === 0) database.exec(sql);
  }
  // A document whose whole timeline is a camera still has a track to write.
  const cameraKeys = Array.isArray(project.camera?.keys) ? project.camera.keys : [];
  if (!rows.length && !(cameraKeys.length && skeleton.camera)) return 0;

  const fps = Math.max(1, Number(project.fps) || 12);
  const startFrame = Number(project.startFrame) || 1;
  const tickOf = (frame) => ((frame - startFrame) * 60) / fps;
  let end = startFrame - 1;
  for (const layer of project.layers ?? []) {
    for (const drawing of layer.drawings ?? []) {
      end = Math.max(end, drawing.at + drawing.hold - 1);
    }
  }
  if (project.camera && Array.isArray(project.camera.keys)) {
    for (const key of project.camera.keys) {
      end = Math.max(end, key.frame);
    }
  }
  // The range of the track runs from the first frame of the project to the
  // end of the last one. The end of a range is a boundary, not a frame: a
  // timeline of 120 frames at 24 fps ends on tick 300 in every document
  // Clip Studio wrote, so the boundary is the start of the frame after the
  // last one.
  const range = { start: tickOf(startFrame), end: tickOf(end + 1), rate: 60 };

  const trackIds = [];

  // The paper's own track holds the range of the whole timeline. It comes
  // first in the list of tracks, the way Clip Studio writes it.
  if (skeleton.paper?.first && skeleton.paper?.second) {
    const first = setTrackRange(parseActionDocument(skeleton.paper.first.raw), range);
    const second = setTrackRange(parseActionDocument(skeleton.paper.second.raw), range);
    const firstId = newMixerId();
    const secondId = newMixerId();
    pixels.set(firstId, Buffer.from(encodeMixerPayload(first, firstId)).subarray(56));
    pixels.set(secondId, Buffer.from(encodeMixerPayload(second, secondId)).subarray(56));

    const paper = readOne(
      database,
      "SELECT MainId, LayerUuid FROM Layer WHERE LayerType = 1584 ORDER BY MainId LIMIT 1",
    );
    // The paper takes the settings of the paper of the skeleton, so that the
    // background of the written document is the one of the document the
    // animation comes from.
    if (source && skeleton.paperLayerRow && paper) {
      copyLayerSettings(database, source, skeleton.paperLayerRow, paper.MainId);
    }
    const id = nextId(database, "Track");
    trackIds.push(id);
    insertRow(database, "Track", skeleton.paper.track, {
      MainId: id,
      TrackNextIndex: 0,
      TrackActionMixerSize: mixerColumnSize(first),
      TrackActionMixer: Buffer.from(firstId, "ascii"),
      TrackActionMixer2Size: mixerColumnSize(second),
      TrackActionMixer2: Buffer.from(secondId, "ascii"),
      TrackUuid: uuidBytes(cryptoId()),
      LayerUuidWithTrack: uuidBytes(paper?.LayerUuid ?? cryptoId()),
      TrackOpen: 0,
      TrackContentOpen: 0,
      TrackKind: 2003,
      TrackOptionFlag: 256,
    });
  }

  for (const row of rows) {
    database
      .prepare("UPDATE Layer SET AnimationFolder = 1 WHERE MainId = ?")
      .run(row.node.layerId);
    const uuid = readOne(database, "SELECT LayerUuid FROM Layer WHERE MainId = ?", row.node.layerId);

    // The folder and its cells take the settings of the ones the skeleton
    // has, so they look like the layers Clip Studio wrote.
    if (source && skeleton.folderRow) {
      copyLayerSettings(database, source, skeleton.folderRow, row.node.layerId);
    }
    if (source && skeleton.celRow) {
      for (const child of row.node.children) {
        copyLayerSettings(database, source, skeleton.celRow, tree.nodes[child].layerId);
      }
    }

    // The plan of the row: the cells it shows, and the frame each one
    // starts on. The frames become ticks of the document's timebase.
    const keys = row.cells.map((cell) => ({ frame: cell.at, tag: cell.name }));
    // The range of a row is the frames its own cells cover. Clip Studio holds
    // the last cell of a row until the end of its track, so a track that ran
    // to the end of the document would keep that cell on screen for every
    // frame after it and the animation would stand still.
    const firstCell = row.cells[0];
    const lastCell = row.cells[row.cells.length - 1];
    const lastFrame = lastCell.at + (lastCell.hold ?? 1) - 1;
    const rowRange = {
      start: tickOf(firstCell.at),
      // The end is the boundary after the last cell, the way Clip Studio
      // writes it: the cell shows up to that boundary and no longer.
      end: tickOf(Math.max(lastFrame, firstCell.at) + 1),
      rate: 60,
    };
    const first = setTrackRange(
      parseActionDocument(spliceCelPlan(skeleton.first, { keys, frameRate: fps })),
      rowRange,
    );
    const second = setTrackRange(
      parseActionDocument(spliceCelPlan(skeleton.second, { keys, frameRate: fps })),
      rowRange,
    );
    const firstId = newMixerId();
    const secondId = newMixerId();
    pixels.set(firstId, Buffer.from(encodeMixerPayload(first, firstId)).subarray(56));
    pixels.set(secondId, Buffer.from(encodeMixerPayload(second, secondId)).subarray(56));

    const id = nextId(database, "Track");
    trackIds.push(id);
    insertRow(database, "Track", skeleton.track, {
      MainId: id,
      TrackNextIndex: 0,
      TrackActionMixerSize: mixerColumnSize(first),
      TrackActionMixer: Buffer.from(firstId, "ascii"),
      TrackActionMixer2Size: mixerColumnSize(second),
      TrackActionMixer2: Buffer.from(secondId, "ascii"),
      TrackUuid: uuidBytes(cryptoId()),
      LayerUuidWithTrack: uuidBytes(uuid.LayerUuid),
      TrackOpen: 0,
      TrackContentOpen: 0,
      TrackKind: 2000,
      TrackOptionFlag: 768,
    });
  }

  // The camera of the document: a track of kind 2005, hung on the folder
  // that holds the camera - the layer of type 512 that the reader marked.
  // Its six curves are spliced into the mixers of the camera track the
  // skeleton has, the same way the cells of a row are spliced into a cell
  // track, so the parts of the camera a track carries beyond its curves are
  // copied rather than made up.
  //
  // A skeleton without a camera track has no tree to copy, so a project
  // with camera keys and no camera track in its skeleton does not get one.
  if (cameraKeys.length && skeleton.camera) {
    const cameraLayer = readOne(
      database,
      "SELECT MainId, LayerUuid FROM Layer WHERE LayerType = 512 ORDER BY MainId LIMIT 1",
    );
    if (cameraLayer) {
      if (source && skeleton.cameraLayerRow) {
        copyLayerSettings(database, source, skeleton.cameraLayerRow, cameraLayer.MainId);
      }
      const plan = { keys: cameraKeys, frameRate: fps, startFrame };
      const cameraRange = {
        start: tickOf(cameraKeys[0].frame),
        end: tickOf(cameraKeys[cameraKeys.length - 1].frame + 1),
        rate: 60,
      };
      const first = setTrackRange(
        parseActionDocument(spliceCameraPlan(parseActionDocument(skeleton.camera.first.raw), plan)),
        cameraRange,
      );
      const second = setTrackRange(
        parseActionDocument(spliceCameraPlan(parseActionDocument(skeleton.camera.second.raw), plan)),
        cameraRange,
      );
      const firstId = newMixerId();
      const secondId = newMixerId();
      pixels.set(firstId, Buffer.from(encodeMixerPayload(first, firstId)).subarray(56));
      pixels.set(secondId, Buffer.from(encodeMixerPayload(second, secondId)).subarray(56));

      const id = nextId(database, "Track");
      trackIds.push(id);
      insertRow(database, "Track", skeleton.camera.track, {
        MainId: id,
        TrackNextIndex: 0,
        TrackActionMixerSize: mixerColumnSize(first),
        TrackActionMixer: Buffer.from(firstId, "ascii"),
        TrackActionMixer2Size: mixerColumnSize(second),
        TrackActionMixer2: Buffer.from(secondId, "ascii"),
        TrackUuid: uuidBytes(cryptoId()),
        LayerUuidWithTrack: uuidBytes(cameraLayer.LayerUuid),
        TrackOpen: 0,
        TrackContentOpen: 0,
        TrackKind: 2005,
      });
    }
  }

  // The tracks of the layers of the document: the track of a layer (kind
  // 2001), the track of the cel folder (kind 1000) and the track of the play
  // time (kind 4000). They hold no cells, but Clip Studio Paint shows a
  // layer in its timeline only when the layer has a track, so the tracks of
  // the layers of an imported document are written out again.
  for (const extra of skeleton.extraTracks ?? []) {
    const node = nodeOfUuid(tree, extra.uuid);
    if (!node) continue;
    const layer = readOne(database, "SELECT MainId, LayerUuid FROM Layer WHERE MainId = ?", node.layerId);
    if (!layer) continue;

    // The tree of the track is carried over as it is, with the range of the
    // document instead of the one it had.
    const first = setTrackRange(parseActionDocument(extra.first.raw), range);
    const second = setTrackRange(parseActionDocument(extra.second.raw), range);
    const firstId = newMixerId();
    const secondId = newMixerId();
    pixels.set(firstId, Buffer.from(encodeMixerPayload(first, firstId)).subarray(56));
    pixels.set(secondId, Buffer.from(encodeMixerPayload(second, secondId)).subarray(56));

    const id = nextId(database, "Track");
    trackIds.push(id);
    insertRow(database, "Track", skeleton.track, {
      MainId: id,
      TrackNextIndex: 0,
      TrackActionMixerSize: mixerColumnSize(first),
      TrackActionMixer: Buffer.from(firstId, "ascii"),
      TrackActionMixer2Size: mixerColumnSize(second),
      TrackActionMixer2: Buffer.from(secondId, "ascii"),
      TrackUuid: uuidBytes(cryptoId()),
      LayerUuidWithTrack: uuidBytes(layer.LayerUuid),
      TrackOpen: 0,
      TrackContentOpen: 0,
      TrackKind: extra.kind,
      TrackOptionFlag: extra.flags,
    });
  }

  // The tracks form a list, so each one names the one behind it.
  for (let index = 0; index < trackIds.length; index += 1) {
    database
      .prepare("UPDATE Track SET TrackNextIndex = ? WHERE MainId = ?")
      .run(trackIds[index + 1] ?? 0, trackIds[index]);
  }

  const timelineId = nextId(database, "TimeLine");
  insertRow(database, "TimeLine", skeleton.timeline, {
    MainId: timelineId,
    FirstTrack: trackIds[0] ?? 0,
    TimeLineUuid: uuidBytes(cryptoId()),
    TimeLineName: skeleton.timeline.TimeLineName ?? "Timeline 1",
    FrameRate: fps,
    // Clip Studio counts the frames of a timeline from zero, and the end
    // frame is the number of frames the timeline holds.
    StartFrame: Math.max(0, startFrame - 1),
    EndFrame: Math.max(1, end - startFrame + 1),
    CurrentFrame: Math.max(0, (Number(project.currentFrame) || startFrame) - startFrame),
    SmallestStartFrame: Math.max(0, startFrame - 1),
    BiggestEndFrame: Math.max(1, end - startFrame + 1),
  });
  database
    .prepare("UPDATE AnimationCutBank SET Enable = 1, FirstTimeLine = ?")
    .run(timelineId);
  // The tracks of the cells, without the paper's own track.
  return rows.length;
}

/**
 * A fresh uuid, written the way Clip Studio Paint writes it.
 *
 * The 16 bytes of a uuid are grouped in ten, four, four, four and ten
 * characters - `afa1c8536c-c74e-4eb7-ae68-e562d6e525` - and not in the
 * eight, four, four, four and twelve the usual form uses. The bytes are
 * the same, but the text is not, and a document that Clip Studio Paint
 * wrote groups them its own way.
 */
function cryptoId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return [
    hex.slice(0, 10),
    hex.slice(10, 14),
    hex.slice(14, 18),
    hex.slice(18, 22),
    hex.slice(22, 32),
  ].join("-");
}

function updateExternalChunks(database, headBody, pixels) {
  let position = 24 + 16 + headBody.length;
  const entries = [];
  for (const [id, payload] of pixels) {
    entries.push([id, payload, position]);
    position += 16 + 56 + payload.length;
  }
  const binarySectionSize = position;
  database.prepare("DELETE FROM ExternalChunk").run();
  for (const [id, , offset] of entries) {
    database.prepare("INSERT INTO ExternalChunk (ExternalID, Offset) VALUES (?, ?)").run(id, offset);
  }
  const head = Buffer.from(headBody);
  head.writeBigUInt64BE(BigInt(binarySectionSize), 8);
  return { entries: entries.map(([id, payload]) => [id, payload]), head, binarySectionSize };
}

/** Read the blank CSP document that every generated .clip is built from. */
/**
 * Make sure a layer really has its pixels behind it.
 *
 * A `.clip` that names a blob the file does not hold does not fail in Clip
 * Studio Paint - the document opens and the layer is empty. The writer knows
 * which layers it filled, so it can say so instead of leaving a broken file
 * behind.
 */
function assertLayerHasPixels(database, layerId, pixels) {
  const row = readOne(
    database,
    `SELECT o.BlockData AS blockData
     FROM Layer l
     JOIN Mipmap m ON m.MainId = l.LayerRenderMipmap
     JOIN MipmapInfo mi ON mi.MainId = m.BaseMipmapInfo
     JOIN Offscreen o ON o.MainId = mi.Offscreen
     WHERE l.MainId = ?`,
    layerId,
  );
  if (!row) {
    throw new ValidationError(`layer ${layerId} has no offscreen to hold its pixels`);
  }
  const id = asciiExternalId(row.blockData);
  if (!id || !pixels.has(id)) {
    throw new ValidationError(
      `layer ${layerId} would open empty: its pixels are not in the file`,
    );
  }
}

async function loadTemplate() {
  return templateLoader();
}

/**
 * Build a CSP-openable .clip from a TVMini project.
 *
 * `animation` says how the animation of the project is written. `true` uses
 * the bundled document with a real animation in it as the skeleton, and the
 * bytes of a `.clip` are used as the skeleton as they are. The skeleton
 * holds a track of Clip Studio's own - the tree of it, the tables the
 * timeline lives in and the range of the document - so that the parts of the
 * format the writer does not understand are copied rather than made up.
 *
 * Without it the file is a static one: the layers of the project, one
 * picture each.
 */
export async function createClipBuffer(project, { name = "TVMini export", animation = null, validate = true } = {}) {
  const template = parseContainer(await loadTemplate());
  let database;
  let source;
  let skeleton = null;

  try {
    if (animation) {
      let bytes;
      if (animation === true) {
        try {
          bytes = await animationTemplateLoader();
        } catch (error) {
          throw new ValidationError(
            `the .clip animation template could not be read: ${error.message}`,
          );
        }
      } else {
        bytes = Buffer.isBuffer(animation) ? animation : Buffer.from(animation);
      }
      let container;
      try {
        container = parseClipContainer(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      } catch {
        throw new ValidationError("the .clip given as the animation skeleton is not a Clip Studio file");
      }
      if (!container.database) {
        throw new ValidationError("the .clip given as the animation skeleton has no database");
      }
      source = await openDatabase(container.database);
      skeleton = animationSkeleton(source, container);
      if (!skeleton) {
        throw new ValidationError(
          "the .clip given as the animation skeleton has no cell track to copy",
        );
      }
    }

    database = await openDatabase(template.database);
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    // Everything below is one transaction. Without it every statement is its
    // own commit, and with `synchronous = FULL` each of them waits for the
    // disk: a document with a few hundred layers spent most of its time
    // there. The file is the same either way.
    database.exec("BEGIN");

    const canvas = readOne(database, "SELECT MainId, CanvasRootFolder, CanvasCurrentLayer FROM Canvas");
    const templateLayer = readOne(
      database,
      "SELECT MainId FROM Layer WHERE LayerType = 1 AND LayerFolder = 0 ORDER BY MainId LIMIT 1",
    );
    if (!templateLayer) throw new ValidationError("the .clip template has no raster layer");

    resizeCanvas(database, project.width, project.height);

    const paper = readOne(
      database,
      "SELECT MainId FROM Layer WHERE LayerType = 1584 ORDER BY MainId LIMIT 1",
    );
    if (!paper) throw new ValidationError("the .clip template has no paper layer");

    const projectLayers = project.layers.length
      ? project.layers
      : [{ name: "Layer 1", visible: true, locked: false, opacity: 1, drawings: [] }];
    // Every project layer becomes a Clip Studio layer, folders included: a
    // folder is a row with the folder flag set, and the layers inside it are
    // linked below it. The tree is built from each layer's `parent`.
    const tree = buildTree(projectLayers);
    // The rows of the timeline are worked out before the layers are made,
    // because the cells of a row are layers of their own. Without a skeleton
    // there is no timeline to write, so the layers are left as they are.
    const rows = skeleton ? animationRows(tree) : [];
    expandRows(tree, rows);
    const created = [];

    for (let index = 0; index < tree.nodes.length; index += 1) {
      const node = tree.nodes[index];
      const folder = isFolderNode(node);
      // A camera is a folder of its own but a layer of type 512, so the
      // timeline of the document can hang its camera track on it.
      const camera = node.layer.camera === true;
      if (index === 0) {
        created.push({ ...templateLayer, layerId: templateLayer.MainId });
      } else {
        created.push(
          cloneLayer(database, templateLayer.MainId, node.layer.name, {
            __width: project.width,
            __height: project.height,
            LayerFolder: folder ? 1 : 0,
            LayerType: camera ? 512 : folder ? 0 : 1,
          }),
        );
      }
      node.layerId = created[index].layerId;
    }

    const imageLayer = project.image
      ? cloneLayer(database, templateLayer.MainId, "Imported .clip image", {
          __width: project.width,
          __height: project.height,
        })
      : null;

    const background = [
      parseInt(project.background.slice(1, 3), 16),
      parseInt(project.background.slice(3, 5), 16),
      parseInt(project.background.slice(5, 7), 16),
      255,
    ];
    setPaperColor(database, background);

    const pixels = new Map();
    if (imageLayer) {
      const image = decodePng(Buffer.from(project.image.data, "base64"));
      if (image.width !== project.width || image.height !== project.height) {
        throw new ValidationError("the imported .clip image does not match the canvas");
      }
      setLayerPixels(database, imageLayer.layerId, image.data, pixels);
    }

    let currentLayerId = imageLayer?.layerId ?? templateLayer.MainId;
    for (let index = 0; index < tree.nodes.length; index += 1) {
      const source = tree.nodes[index].layer;
      const target = created[index];
      const folder = isFolderNode(tree.nodes[index]);
      const camera = source.camera === true;
      const opacity = Math.max(0, Math.min(256, Math.round((source.opacity ?? 1) * 256)));
      database
        .prepare(
          "UPDATE Layer SET LayerName = ?, LayerFolder = ?, LayerType = ?, LayerVisibility = ?, LayerLock = ?, LayerOpacity = ?, LayerComposite = 0, LayerSelect = 0, LayerUuid = ? WHERE MainId = ?",
        )
        .run(
          String(source.name || "Layer").slice(0, 80),
          folder ? 1 : 0,
          camera ? 512 : folder ? 0 : 1,
          source.visible === false ? 0 : 1,
          source.locked ? 1 : 0,
          opacity,
          cryptoId(),
          target.layerId,
        );
      database
        .prepare("UPDATE LayerThumbnail SET ThumbnailCanvasWidth = ?, ThumbnailCanvasHeight = ? WHERE LayerId = ?")
        .run(project.width, project.height, target.layerId);
      // A folder holds no picture of its own. Clip Studio still gives it a
      // mipmap chain, but its block is not in the file, so no pixels are
      // written for it and none are expected.
      if (!folder) {
        // A cell shows on its own frame, so the picture of the layer it
        // holds is the picture of that cell's own drawing. A cell of a row
        // that was made here knows its drawing; a cell that came from a
        // Clip Studio document is a layer that holds one drawing.
        const cel = tree.nodes[index].cel;
        const drawing = cel?.drawing ?? (source.preBehavior === "none" ? source.drawings?.[0] : null);
        const rgba = drawing
          ? renderDrawingRgba(project, drawing)
          : renderLayerRgba(project, source);
        // A layer that is moved, made bigger or turned carries its picture
        // with it, and so do the folders above it: a cell that is a folder
        // of layers is moved as a whole. A `.clip` has no layer of its own
        // for a turn or a size, so the picture is put where it belongs.
        const placed = transformRgba(
          rgba,
          project.width,
          project.height,
          composeMatrix(
            [...transformsAbove(tree, index), transformOf(source)],
            project.width,
            project.height,
          ),
          "nearest",
        );
        setLayerPixels(database, target.layerId, placed, pixels);
        currentLayerId = target.layerId;
      }
    }

    // Every layer that was filled has to end up with its pixels in the file.
    if (imageLayer) assertLayerHasPixels(database, imageLayer.layerId, pixels);
    for (let index = 0; index < tree.nodes.length; index += 1) {
      if (isFolderNode(tree.nodes[index])) continue;
      assertLayerHasPixels(database, created[index].layerId, pixels);
    }

    if (imageLayer) {
      if (projectLayers.length === 0) currentLayerId = imageLayer.layerId;
    }

    // The paper sits under everything else, so it starts the bottom chain.
    const floor = [paper.MainId];
    if (imageLayer) floor.push(imageLayer.layerId);
    linkTree(database, tree, floor, canvas.CanvasRootFolder);
    writeComposition(database, tree, floor, canvas.CanvasRootFolder);
    const layerCount = floor.length + created.length;

    const refreshColumns = columnsOf(database, "LayerThumbnail").filter((column) =>
      column.includes("NeedRefresh"),
    );
    if (refreshColumns.length > 0) {
      database
        .prepare(
          `UPDATE LayerThumbnail SET ${refreshColumns.map((column) => `[${column}] = 50`).join(", ")}`,
        )
        .run();
    }

    database
      .prepare("UPDATE Layer SET LayerSelect = CASE WHEN MainId = ? THEN 1 ELSE 0 END")
      .run(currentLayerId);
    database
      .prepare("UPDATE Canvas SET CanvasCurrentLayer = ?, CanvasRootFolder = ? WHERE MainId = ?")
      .run(currentLayerId, canvas.CanvasRootFolder, canvas.MainId);
    database
      .prepare(
        "UPDATE Project SET ProjectName = ?, DefaultPageWidth = ?, DefaultPageHeight = ?, DefaultPageResolution = 72",
      )
      .run(String(name).slice(0, 200), project.width, project.height);

    // The settings of the canvas and of the page come from the document the
    // animation is written from: a document with an animation counts its
    // frames the way Clip Studio Paint does, and has a crop frame and a
    // page of its own.
    if (source) copyDocumentSettings(database, source, project.width, project.height);

    setTimeline(database, project);

    // The tracks that were written, so the caller can say whether the file
    // carries a timeline.
    const tracks = skeleton
      ? writeAnimation(database, tree, project, skeleton, pixels, rows, source)
      : 0;

    setPreview(database, project);

    const external = updateExternalChunks(database, template.headBody, pixels);

    // The SQLite file is finalised differently by each backend: the Node
    // build writes it to disk, the browser build keeps it in memory.
    database.exec("COMMIT");
    const bytes = database.export ? await database.export() : null;
    await database.close();
    database = null;

    const output = buildContainer(external.head, bytes, external.entries);

    // The document is checked before it is handed over. A `.clip` that has a
    // dangling pointer does not fail in Clip Studio Paint - it opens and the
    // layer is simply empty - so a broken file has to be caught here, where
    // there is still something to say about it.
    if (validate) {
      const report = await validateClipBytes(output);
      if (!report.ok) {
        throw new ValidationError(
          `the .clip that was written is not consistent: ${report.problems.join("; ")}`,
        );
      }
    }

    return {
      buffer: output,
      width: project.width,
      height: project.height,
      layers: layerCount,
      // The rows of the timeline that were written as tracks of cells.
      tracks,
    };
  } finally {
    if (database) await database.close();
    if (source) await source.close();
  }
}
