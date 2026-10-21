import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { ValidationError } from "./model.js";
import { decodePng, encodePng, renderDrawingRgba, renderLayerRgba, renderProject } from "./png.js";
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

/** Replace the template loader. Returns a function that restores the old one. */
export function setTemplateLoader(loader) {
  const previous = templateLoader;
  templateLoader = loader;
  return () => {
    templateLoader = previous;
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
    LayerUuid: globalThis.crypto.randomUUID(),
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
  const nodes = layers.map((layer) => ({ layer, layerId: 0, children: [] }));
  const roots = [];
  nodes.forEach((node, index) => {
    const parent = node.layer.parent ?? -1;
    if (parent >= 0 && parent < nodes.length && parent !== index) {
      nodes[parent].children.push(index);
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

/** Link a list of layers as siblings, from the bottom of the canvas up. */
function linkSiblings(database, ids) {
  for (let index = 0; index < ids.length; index += 1) {
    database
      .prepare("UPDATE Layer SET LayerNextIndex = ? WHERE MainId = ?")
      .run(index + 1 < ids.length ? ids[index + 1] : 0, ids[index]);
  }
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
      const kids = [...node.children].reverse();
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
 * The folders of a project that are animation folders, and their cells.
 *
 * The importer marks a cell `preBehavior: "none"`, because a cell only shows
 * on its own frame; an ordinary layer holds. That is the rule used here: a
 * folder whose direct children are cells is an animation folder. A cell that
 * is itself a folder is not looked into again, so its drawing layers are not
 * mistaken for cells of the folder above it.
 */
function animationFolders(tree) {
  const folders = [];
  const seen = new Set();

  // The frame a cell sits on: its own drawing's, or the earliest of the
  // drawings inside it, because a cell that is a folder holds its picture in
  // layers of its own.
  const frameOf = (index, depth = 0) => {
    const layer = tree.nodes[index].layer;
    if (layer.drawings?.length) return layer.drawings[0].at;
    if (depth >= 8) return null;
    const frames = tree.nodes[index].children
      .map((child) => frameOf(child, depth + 1))
      .filter((frame) => frame !== null);
    return frames.length ? Math.min(...frames) : null;
  };

  for (let index = 0; index < tree.nodes.length; index += 1) {
    if (seen.has(index)) continue;
    const node = tree.nodes[index];
    if (node.layer.type !== "group" || node.children.length === 0) continue;
    const children = node.children.map((child) => tree.nodes[child].layer);
    if (!children.some((child) => child.preBehavior === "none")) continue;

    const cells = [];
    for (const child of node.children) {
      const layer = tree.nodes[child].layer;
      const at = frameOf(child);
      if (at === null) continue;
      cells.push({ name: layer.name || String(cells.length + 1), at });
      seen.add(child);
    }
    if (cells.length === 0) continue;
    cells.sort((one, two) => one.at - two.at);
    folders.push({ node, cells });
  }
  return folders;
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

  return { tables, timeline, track, first, second, types: curveFieldTypes(curve) };
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
 * Write the timeline of a project into a `.clip` under construction.
 *
 * The mixer of a track is the action document described in `clip-mixer.js`.
 * Here only the cell curve is replaced: the names of the cells become the
 * `Tag` string values, their frames become the `Frame` times in 60 Hz ticks,
 * and the end of the track follows the end of the project.
 *
 * `skeleton` comes from the document the project was imported from, so every
 * part of the tree the writer does not understand is copied rather than made
 * up. Returns the number of tracks that were written.
 */
function writeAnimation(database, tree, project, skeleton, pixels) {
  if (!columnsOf(database, "Layer").includes("AnimationFolder")) {
    database.exec("ALTER TABLE Layer ADD COLUMN AnimationFolder INTEGER DEFAULT NULL");
  }
  for (const sql of [skeleton.tables.TimeLine, skeleton.tables.Track]) {
    const name = /CREATE TABLE\s+"?(\w+)/i.exec(sql)?.[1];
    if (name && columnsOf(database, name).length === 0) database.exec(sql);
  }

  const folders = animationFolders(tree);
  if (process.env.TVMINI_DEBUG) {
    console.log(
      "folders:",
      JSON.stringify(folders.map((folder) => [folder.node.layer.name, folder.cells.map((cell) => `${cell.name}@${cell.at}`)])),
    );
  }
  if (folders.length === 0) return 0;

  const fps = Math.max(1, Number(project.fps) || 12);
  const startFrame = Number(project.startFrame) || 1;
  const tickOf = (frame) => ((frame - startFrame) * 60) / fps;
  let end = startFrame - 1;
  for (const layer of project.layers ?? []) {
    for (const drawing of layer.drawings ?? []) {
      end = Math.max(end, drawing.at + drawing.hold - 1);
    }
  }
  const endTick = tickOf(Math.max(startFrame, end));

  // The tracks form a list, so their ids are handed out before the rows are
  // written: each one has to name the next.
  const trackIds = folders.map(() => nextId(database, "Track"));
  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];
    const layerId = folder.node.layerId;
    database
      .prepare("UPDATE Layer SET AnimationFolder = 1 WHERE MainId = ?")
      .run(layerId);
    const uuid = readOne(database, "SELECT LayerUuid FROM Layer WHERE MainId = ?", layerId);

    const tags = folder.cells.map((cell) => cell.name);
    const keys = folder.cells.map((cell, order) => ({
      time: tickOf(cell.at),
      value: order,
      tag: cell.name,
    }));
    const pool = withStrings(skeleton.second.pool, tags);
    const curve = replaceCurve(skeleton.second, {
      kind: "ImageCelName",
      fields: celCurveFields(keys, pool, skeleton.types),
      pool,
    });
    const document = setTrackEnd(parseActionDocument(curve), endTick);

    const secondId = newMixerId();
    const firstId = newMixerId();
    pixels.set(secondId, Buffer.from(encodeMixerPayload(document, secondId)).subarray(56));
    pixels.set(firstId, Buffer.from(encodeMixerPayload(skeleton.first.raw, firstId)).subarray(56));

    insertRow(database, "Track", skeleton.track, {
      MainId: trackIds[index],
      TrackNextIndex: trackIds[index + 1] ?? 0,
      TrackActionMixerSize: mixerColumnSize(skeleton.first.raw),
      TrackActionMixer: Buffer.from(firstId, "ascii"),
      TrackActionMixer2Size: mixerColumnSize(document),
      TrackActionMixer2: Buffer.from(secondId, "ascii"),
      TrackUuid: uuidBytes(cryptoId()),
      LayerUuidWithTrack: uuidBytes(uuid.LayerUuid),
      TrackOpen: 0,
      TrackContentOpen: 0,
      TrackKind: 2000,
      TrackOptionFlag: 768,
    });
  }

  insertRow(database, "TimeLine", skeleton.timeline, {
    MainId: nextId(database, "TimeLine"),
    FirstTrack: trackIds[0],
    TimeLineUuid: uuidBytes(cryptoId()),
    TimeLineName: skeleton.timeline.TimeLineName ?? "Timeline 1",
    FrameRate: fps,
    StartFrame: 0,
    EndFrame: Math.max(0, end - startFrame),
    BiggestEndFrame: Math.max(0, end - startFrame),
    CurrentFrame: Math.max(0, (Number(project.currentFrame) || startFrame) - startFrame),
  });
  database
    .prepare("UPDATE AnimationCutBank SET Enable = 1, FirstTimeLine = 1 WHERE MainId = 2")
    .run();
  return folders.length;
}

/** A fresh 16 byte uuid, as the dashed text Clip Studio writes. */
function cryptoId() {
  return globalThis.crypto.randomUUID();
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
 * `animation` is off by default and has to stay off until the mixer of a
 * Clip Studio track can be written. The action data of a track is CSP's own
 * serialised document, and a malformed one is the single thing that could
 * make Clip Studio Paint reject a file that otherwise opens. A static file
 * that opens is worth more than an animated file that does not, so the
 * writer refuses to guess.
 */
export async function createClipBuffer(project, { name = "TVMini export", animation = null, validate = true } = {}) {
  if (animation === true) {
    throw new ValidationError(
      "writing the animation of a .clip is not ready yet; the track it is copied from has to be given as `animation`",
    );
  }
  const template = parseContainer(await loadTemplate());
  let database;
  let source;
  let skeleton = null;

  try {
    if (animation) {
      let container;
      try {
        container = parseClipContainer(Buffer.isBuffer(animation) ? animation : Buffer.from(animation));
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
    const created = [];

    for (let index = 0; index < tree.nodes.length; index += 1) {
      const node = tree.nodes[index];
      if (index === 0) {
        created.push({ ...templateLayer, layerId: templateLayer.MainId });
      } else {
        const folder = node.layer.type === "group";
        created.push(
          cloneLayer(database, templateLayer.MainId, node.layer.name, {
            __width: project.width,
            __height: project.height,
            ...(folder ? { LayerFolder: 1, LayerType: 0 } : {}),
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
      const folder = source.type === "group";
      const opacity = Math.max(0, Math.min(256, Math.round((source.opacity ?? 1) * 256)));
      database
        .prepare(
          "UPDATE Layer SET LayerName = ?, LayerFolder = ?, LayerType = ?, LayerVisibility = ?, LayerLock = ?, LayerOpacity = ?, LayerComposite = 0, LayerSelect = 0, LayerUuid = ? WHERE MainId = ?",
        )
        .run(
          String(source.name || "Layer").slice(0, 80),
          folder ? 1 : 0,
          folder ? 0 : 1,
          source.visible === false ? 0 : 1,
          source.locked ? 1 : 0,
          opacity,
          globalThis.crypto.randomUUID(),
          target.layerId,
        );
      database
        .prepare("UPDATE LayerThumbnail SET ThumbnailCanvasWidth = ?, ThumbnailCanvasHeight = ? WHERE LayerId = ?")
        .run(project.width, project.height, target.layerId);
      // A folder holds no picture of its own. Clip Studio still gives it a
      // mipmap chain, but its block is not in the file, so no pixels are
      // written for it and none are expected.
      if (!folder) {
        setLayerPixels(database, target.layerId, renderLayerRgba(project, source), pixels);
        currentLayerId = target.layerId;
      }
    }

    // Every layer that was filled has to end up with its pixels in the file.
    if (imageLayer) assertLayerHasPixels(database, imageLayer.layerId, pixels);
    for (let index = 0; index < tree.nodes.length; index += 1) {
      if (tree.nodes[index].layer.type === "group") continue;
      assertLayerHasPixels(database, created[index].layerId, pixels);
    }

    if (imageLayer) {
      if (projectLayers.length === 0) currentLayerId = imageLayer.layerId;
    }

    // The paper sits under everything else, so it starts the bottom chain.
    const floor = [paper.MainId];
    if (imageLayer) floor.push(imageLayer.layerId);
    linkTree(database, tree, floor, canvas.CanvasRootFolder);
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

    setTimeline(database, project);

    if (skeleton) writeAnimation(database, tree, project, skeleton, pixels);

    setPreview(database, project);

    const external = updateExternalChunks(database, template.headBody, pixels);

    // The SQLite file is finalised differently by each backend: the Node
    // build writes it to disk, the browser build keeps it in memory.
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
    };
  } finally {
    if (database) await database.close();
    if (source) await source.close();
  }
}
