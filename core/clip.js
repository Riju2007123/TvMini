import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { MAX_SIZE, MIN_SIZE, ValidationError } from "./model.js";
import { decodeBlockPayload, parseAttribute } from "./clip-blocks.js";
import {
  actionProperties,
  cellTransformAt,
  celPlacement,
  celPlacementFromKeys,
  readActionBlob,
  readCameraCurves,
  readCelCurve,
  readCelSequence,
  readCellTransform,
  readTrackRange,
} from "./clip-animation.js";
import { frameOfCellName } from "../timeline.js";
import { tickOfFrame } from "./clip-mixer.js";
import { createProject, normalizeProject } from "./model.js";
import { encodeRgbaPng } from "./png.js";

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
 * Whether a row describes the document rather than something to draw on.
 *
 * The paper is the colour of the canvas and the story information is the
 * document's own metadata; neither is a layer the brush can paint. They stay
 * in the layer tree that is reported, but they are not project layers.
 */
function isDocumentRow(node) {
  return node.kind === "paper" || node.kind === "information";
}

/**
 * The colour of the paper, as CSS hex, or null when the document has none.
 *
 * Clip Studio Paint keeps the paper colour in the project settings rather
 * than in pixels, and each channel sits in the top byte of a 32-bit word, so
 * a white paper is 0xffffffff in all three.
 */
function paperColorOf(row) {
  if (!row || row.DefaultPagePaperRed == null) return null;
  const channel = (value) => (Number(value ?? 0) >>> 24) & 0xff;
  const hex = (value) => channel(value).toString(16).padStart(2, "0");
  return `#${hex(row.DefaultPagePaperRed)}${hex(row.DefaultPagePaperGreen)}${hex(row.DefaultPagePaperBlue)}`;
}

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
 * Put a layer's raster on the canvas.
 *
 * A Clip Studio layer keeps its raster at the size of its own canvas, which
 * is not always the size of the document. The raster is **not** scaled to
 * fit: it is put where it is, and the part that falls outside the document
 * is cut away, the way Clip Studio Paint draws it. Scaling it would move
 * every stroke of the layer and squash it.
 *
 * A layer sits at the place its own offset says, and the part of the picture
 * that the offset pushes out of the canvas is cut away with it.
 */
function placeRgba(source, sourceWidth, sourceHeight, width, height, offsetX = 0, offsetY = 0) {
  if (offsetX === 0 && offsetY === 0 && sourceWidth === width && sourceHeight === height) {
    return source;
  }
  const output = Buffer.alloc(width * height * 4);
  const copyWidth = Math.min(sourceWidth, width - offsetX);
  if (copyWidth <= 0) return output;
  for (let y = 0; y < sourceHeight; y += 1) {
    const targetY = y + offsetY;
    if (targetY < 0 || targetY >= height) continue;
    source.copy(
      output,
      targetY * width * 4,
      y * sourceWidth * 4,
      y * sourceWidth * 4 + copyWidth * 4,
    );
  }
  return output;
}

/**
 * Build a TVMini project out of a Clip Studio document.
 *
 * The shape of the document comes over as it is: the folders, the animation
 * folders and the layers inside them. The children of an animation folder
 * are the cells of the animation, and each of them becomes a layer of its
 * own that carries the picture of the cell, so the animation shows up in the
 * timeline the way it shows up in Clip Studio Paint.
 *
 * Clip Studio Paint names a cell after the frame it sits on, so the name of
 * the cell says which frame it belongs to: `1`, `1a`, `2`, `2a` and so on.
 */
export function clipToProject(document, layers, fallback = {}) {
  const width = Number(document.width) || Number(fallback.width) || 0;
  const height = Number(document.height) || Number(fallback.height) || 0;
  if (width < MIN_SIZE || height < MIN_SIZE) {
    throw new ValidationError("this .clip has no usable canvas size");
  }
  if (width > MAX_SIZE || height > MAX_SIZE) {
    throw new ValidationError(
      `this .clip canvas is ${width}×${height}; TVMini supports up to ${MAX_SIZE} px`,
    );
  }

  const timeline = document.timeline ?? {};
  const startFrame = Math.max(1, Number(timeline.startFrame ?? 0) + 1);
  // `EndFrame` is the number of frames after `StartFrame`, so with a start of
  // 0 it is also the 1-based number of the last frame. Every real document
  // checked agrees: the end of a track's clip, in frames, equals it.
  const endFrame = Math.max(startFrame, Number(timeline.endFrame ?? 0));
  const hold = endFrame - startFrame + 1;

  const rasterById = new Map((layers ?? []).map((layer) => [Number(layer.id), layer]));
  const nodes = new Map((document.layerTree ?? []).map((node) => [Number(node.id), node]));

  /**
   * The cells each animation folder holds, and where each one starts.
   *
   * A track carries the uuid of the layer whose timeline it is. Its cell
   * curve names the cell of every key and gives the time of that key in
   * 60 Hz ticks; the ticks become frames with the frame rate of the
   * document. A track whose curve cannot be read falls back on the run of
   * cell names, which loses the timing but keeps the cells. The same uuid
   * is written with dashes on the layer and without on the track, so the
   * two are compared with the dashes taken out.
   */
  const uuidKey = (value) => String(value ?? "").replace(/-/g, "").toLowerCase();
  const frameRate = Number(timeline.frameRate) > 0 ? Number(timeline.frameRate) : 30;
  const placementsByUuid = new Map();
  const transformsByUuid = new Map();
  for (const track of document.tracks ?? []) {
    const key = uuidKey(track?.layerUuid);
    if (!key) continue;
    // The transform of the cells of a track says where their pictures sit.
    if (track?.action2?.cellTransform && !transformsByUuid.has(key)) {
      transformsByUuid.set(key, track.action2.cellTransform);
    }
    if (placementsByUuid.has(key)) continue;
    // The cell curve lives in the second mixer, but a track that has none
    // there can still carry one in the first.
    const second = track?.action2;
    const action = second?.celKeys?.length || second?.celSequence?.length
      ? second
      : (track?.action ?? second);
    if (!action) continue;
    if (action.celKeys?.length) {
      placementsByUuid.set(key, celPlacementFromKeys(action.celKeys, {
        frameRate,
        startFrame,
        endFrame,
        endTick: action.clipRange?.end,
      }));
    } else if (action.celSequence?.length) {
      placementsByUuid.set(key, celPlacement(action.celSequence, startFrame));
    }
  }

  const placementOf = (node) => placementsByUuid.get(uuidKey(node.uuid)) ?? null;
  const transformOf_ = (node) => transformsByUuid.get(uuidKey(node.uuid)) ?? null;

  /**
   * Where the picture of a cell sits, in the way the project keeps it.
   *
   * Clip Studio Paint says where the middle of the picture is and where it
   * is at home; the difference is how far the picture is from its place. The
   * project turns and grows the picture around the middle of the canvas, so
   * the place is measured from there.
   *
   * @param {{keys: object[]}|null} transform The transform of the track.
   * @param {number} frame The frame of the cell.
   */
  const cellTransform = (transform, frame) => {
    if (!transform) return null;
    const place = cellTransformAt(transform, tickOfFrame(frame, frameRate));
    if (!place) return null;
    const homeX = place.homeX ?? width / 2;
    const homeY = place.homeY ?? height / 2;
    const result = {
      x: place.x - homeX,
      y: place.y - homeY,
      scale: place.scale > 0 ? place.scale : 1,
      rotation: place.rotation,
    };
    if (result.x === 0 && result.y === 0 && result.scale === 1 && result.rotation === 0) {
      return null;
    }
    return result;
  };

  /** The picture of a layer, as the base of a drawing. */
  const pictureOf = (node) => {
    const raster = rasterById.get(Number(node.id));
    if (!raster || !raster.pixels) return null;
    const picture = placeRgba(
      raster.pixels,
      raster.width,
      raster.height,
      width,
      height,
      raster.offsetX ?? 0,
      raster.offsetY ?? 0,
    );
    return {
      data: Buffer.from(encodeRgbaPng(width, height, picture)).toString("base64"),
      width,
      height,
    };
  };

  /**
   * The layers a folder holds.
   *
   * Clip Studio Paint keeps the layers of a folder in a chain that starts
   * at the bottom of the screen, so the chain is turned around here: the
   * first layer of the list is the top one.
   */
  const childrenOf = (node) => {
    const list = [];
    let id = Number(node.firstChildIndex ?? 0);
    while (id) {
      const child = nodes.get(id);
      if (!child) break;
      list.push(child);
      id = Number(child.nextIndex ?? 0);
    }
    return list.reverse();
  };

  /** The same chain the other way round: the order the document stores. */
  const chainOf = (node) => [...childrenOf(node)].reverse();

  /**
   * Build one layer of the document.
   *
   * `inheritedFrame`, `inheritedName` and `inheritedHold` belong to the cell
   * the layer sits in, when the cell holds more than one layer.
   */
  const buildLayer = (
    node,
    insideAnimation,
    inheritedFrame,
    inheritedName,
    placement,
    inheritedHold,
    inheritedTransform,
  ) => {
    const folder = Boolean(node.folder);
    const ownName = node.name || `Layer ${node.id}`;

    // A layer that sits inside a cell belongs to that cell: it is on the
    // frame of the cell and shows for as long as the cell does. Its own name
    // says nothing, even when it happens to be a number. Getting this wrong
    // hides the artwork, because a cell only shows on its own frame.
    const insideCell = inheritedName !== null && inheritedName !== undefined;

    // A cell of an animation folder starts where the track says it starts.
    // The curve of the track is better evidence than the name, because a
    // cell can be held over several frames; the name is only the fallback
    // for a document whose curve cannot be read.
    //
    // A cell the track does not name is not on screen at all: the track says
    // which cells of the folder are shown and when, and a cell that is not in
    // it stays in the folder without a frame. Giving it the frame its name
    // gives would show a cell Clip Studio Paint keeps in the dark.
    const runs = insideAnimation && !insideCell ? placement?.get(ownName) : undefined;
    const cellFrame = insideCell
      ? inheritedFrame
      : insideAnimation
        ? (runs?.[0]?.frame ?? (placement ? null : frameOfCellName(ownName)))
        : null;
    const isCel = cellFrame !== null;

    // A layer that sits inside a cell is on the frame of that cell; a layer
    // that is not a cell is on the first frame and shows from there on.
    const frame = isCel ? cellFrame : (inheritedFrame ?? startFrame);
    const cellName = inheritedName ?? (isCel ? ownName : null);

    // A layer inside a cell only shows while the cell is on screen, so it
    // lasts as long as the cell does. Giving it the length of the whole
    // animation would push its drawing past the end of the timeline (a layer
    // of the cell on frame 5 of a 17 frame file would end on frame 21).
    const span = inheritedHold ?? hold;

    const layer = {
      // The id of the row in the Clip Studio document. It is used to find
      // the layer that was selected and is dropped before the project is
      // handed over.
      id: node.id,
      name: ownName,
      type: folder ? "group" : "anim",
      // The uuid of the layer in the document, so that the track of the
      // layer can be written back out.
      ...(node.uuid ? { uuid: node.uuid } : {}),
      // The camera of a document hangs on a folder of its own, a layer of
      // type 512. The flag keeps that folder a camera folder, so that the
      // camera track of an imported document can be written back on it.
      ...(Number(node.type) === 512 ? { camera: true } : {}),
      visible: node.visible !== false,
      locked: Boolean(node.locked),
      opacity: typeof node.opacity === "number" && Number.isFinite(node.opacity) ? node.opacity : 1,
      blend: "normal",
      // A cell only shows on its own frame; an ordinary layer shows the
      // whole time.
      preBehavior: isCel ? "none" : "hold",
      postBehavior: isCel ? "none" : "hold",
      clip: false,
      parent: -1,
      drawings: [],
    };

    // A cell that is a folder of layers is moved as a whole, so the place its
    // track moves it to belongs to the folder.
    if (folder && isCel) {
      const place = cellTransform(inheritedTransform, cellFrame);
      if (place) layer.transform = place;
    }

    if (!folder) {
      const picture = pictureOf(node);
      // A cell shows on every frame the track names it, so it can carry more
      // than one drawing. Without a track, the name of the cell is the only
      // evidence there is, and it holds a single frame. A layer inside a cell
      // follows the cell it belongs to.
      //
      // A cell of an animation folder that the track does not name stays in
      // the folder without a drawing: the track decides which cells are on
      // screen, and this one is not one of them.
      const spots = insideCell
        ? [{ frame: cellFrame, hold: inheritedHold ?? 1 }]
        : isCel
          ? (runs ?? [{ frame: cellFrame, hold: 1 }])
          : insideAnimation
            ? []
            : [{ frame, hold: span }];
      for (const spot of spots) {
        const drawing = {
          at: spot.frame,
          hold: spot.hold,
          strokes: [],
        };
        // A cell that is moved by its track keeps the place it is moved to.
        const place = isCel ? cellTransform(inheritedTransform, spot.frame) : null;
        if (place) drawing.transform = place;
        if (cellName) drawing.name = cellName;
        if (picture) drawing.image = picture;
        layer.drawings.push(drawing);
      }
    }

    // The children of a folder are drawn from the bottom of the screen up,
    // which is why the chain is turned around for layers. The children of an
    // animation folder are cells, though, and a cell list reads from the
    // first frame down, so those keep the order the document stores and are
    // sorted by the frame their name gives.
    const childPlacement = node.animationFolder ? placementOf(node) : null;
    // The track of an animation folder may move the cells of the folder, so
    // the transform of the track goes down with the placement.
    const childTransform = node.animationFolder ? transformOf_(node) : null;

    let kids = childrenOf(node).filter((child) => !isDocumentRow(child));
    if (node.animationFolder) {
      const frameOf = (child) => {
        const spot = childPlacement?.get(child.name ?? "")?.[0];
        if (spot) return spot.frame;
        const found = frameOfCellName(child.name ?? "");
        return found === null ? Number.MAX_SAFE_INTEGER : found;
      };
      kids = chainOf(node).sort((a, b) => frameOf(a) - frameOf(b));
    }
    const children = kids.map((child) =>
      buildLayer(
        child,
        insideAnimation || Boolean(node.animationFolder),
        isCel ? frame : inheritedFrame,
        isCel ? cellName : inheritedName,
        childPlacement,
        isCel ? (runs?.[0]?.hold ?? 1) : inheritedHold,
        childTransform,
      ),
    );
    if (folder) layer.children = children;
    return layer;
  };

  // The root of the document holds every layer of the canvas.
  const root =
    (document.layerTree ?? []).find((node) => node.kind === "root-folder") ??
    (document.layerTree ?? [])[0] ??
    null;

  const projectLayers = [];
  const flatten = (layer, parent) => {
    const index = projectLayers.length;
    layer.parent = parent;
    projectLayers.push(layer);
    for (const child of layer.children ?? []) flatten(child, index);
  };

  if (root) {
    for (const child of childrenOf(root)) {
      // The paper is the colour of the canvas and the story information is
      // the document's metadata; neither is a layer to draw on.
      if (isDocumentRow(child)) continue;
      flatten(buildLayer(child, false, null), -1);
    }
  }

  // The tree is only a step on the way: the project keeps one flat list of
  // layers, and every layer says which folder holds it.
  const sourceIds = [];
  for (const layer of projectLayers) {
    sourceIds.push(Number(layer.id));
    delete layer.id;
    delete layer.children;
  }

  // A document can start its timeline in the middle of its animation, but a
  // project has to show every drawing it holds. When a drawing sits before
  // the start the document declares, the timeline is stretched back to it,
  // and a layer that shows the whole time is stretched with it.
  let firstFrame = startFrame;
  for (const layer of projectLayers) {
    for (const drawing of layer.drawings ?? []) {
      if (drawing.at < firstFrame) firstFrame = drawing.at;
    }
  }
  if (firstFrame < startFrame) {
    for (const layer of projectLayers) {
      if (layer.preBehavior !== "hold") continue;
      for (const drawing of layer.drawings ?? []) {
        if (drawing.name !== undefined) continue;
        drawing.at = firstFrame;
        drawing.hold = endFrame - firstFrame + 1;
      }
    }
  }

  const project = createProject(width, height, document.paperColor ?? "#ffffff");
  project.fps = Math.max(1, Number(timeline.frameRate ?? 12));
  project.startFrame = firstFrame;
  project.currentFrame = Math.min(
    endFrame,
    Math.max(firstFrame, Number(timeline.currentFrame ?? 0) + 1),
  );
  project.layers = projectLayers.length ? projectLayers : [createProject(width, height).layers[0]];

  // The camera of the document, when it has one.
  //
  // A camera is a track of kind 2005. Its curves give the size of the frame
  // it looks through, where that frame sits on the canvas, how far it is
  // turned and how much of the canvas it shows, and every key of the camera
  // is one row of those numbers. The window the camera shows is the frame
  // scaled by the zoom, with its middle where the position says.
  const cameraTrack = (document.tracks ?? []).find((track) => Number(track?.kind) === 2005);
  const cameraKeys = cameraTrack?.action2?.camera?.keys ?? cameraTrack?.action?.camera?.keys ?? null;
  if (cameraKeys?.length) {
    project.camera = {
      keys: cameraKeys.map((key) => {
        const zoom = (Number(key.scale) || 0) / 100;
        const halfWidth = (Number(key.centreX) || 0) * zoom;
        const halfHeight = (Number(key.centreY) || 0) * zoom;
        return {
          frame: firstFrame + Math.round((Number(key.time) * frameRate) / 60),
          x: (Number(key.positionX) || 0) - halfWidth,
          y: (Number(key.positionY) || 0) - halfHeight,
          width: halfWidth * 2,
          height: halfHeight * 2,
          rotation: Number(key.rotation) || 0,
          // The camera curves carry no easing of their own, so the camera
          // moves at a constant speed between two keys.
          interp: "linear",
        };
      }),
    };
  }

  // The layer that was selected in the document is the one the work was
  // done on, so that is the one the brush starts on.
  const selected = Number(document.currentLayerId ?? 0);
  if (selected) {
    const index = sourceIds.indexOf(selected);
    if (index >= 0) project.currentLayer = index;
  }

  return normalizeProject(project);
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
    const tracks = allRows("Track").map((track) => {
      // The two mixers are pointers to blobs outside the database. Unpacking
      // one gives the names of the properties the track animates.
      const action = (column) => {
        const id = asText(track[column]);
        const chunk = externalById.get(id);
        if (!chunk) return null;
        const document = readActionBlob(chunk.payload);
        if (!document) return null;
        return {
          version: document.version,
          codec: document.codec,
          types: document.types.length,
          properties: actionProperties(document),
          // The cells the track shows, and the time of each key, when it is a
          // track that carries cells at all.
          celKeys: readCelCurve(document)?.keys ?? null,
          clipRange: readTrackRange(document),
          celSequence: readCelSequence(document),
          // The curves of a camera, when this track is one.
          camera: readCameraCurves(document),
          // Where the pictures of the cells of this track sit.
          cellTransform: readCellTransform(document),
        };
      };
      return {
        mainId: Number(track.MainId ?? 0),
        itemId: Number(track.ItemId ?? 0),
        kind: Number(track.TrackKind ?? 0),
        nextIndex: Number(track.TrackNextIndex ?? 0),
        layerUuid: track.LayerUuidWithTrack == null
          ? null
          : Buffer.from(track.LayerUuidWithTrack).toString("hex"),
        actionMixerSize: Number(track.TrackActionMixerSize ?? 0),
        actionMixer2Size: Number(track.TrackActionMixer2Size ?? 0),
        valueMapSize: track.TrackValueMap == null ? 0 : asText(track.TrackValueMap).length,
        action: action("TrackActionMixer"),
        action2: action("TrackActionMixer2"),
      };
    });

    // The blobs that live outside the database were resolved above; the
    // table is reported as it stands in the document.
    const tableDetails = {};
    for (const table of tables) {
      tableDetails[table] = { columns: getColumns(table), rows: countRows(table) };
    }

    return {
      format: "clip-studio-native-container",
      readOnly: true,
      width: Number(canvasRow?.CanvasWidth ?? projectRow?.DefaultPageWidth ?? 0) || null,
      height: Number(canvasRow?.CanvasHeight ?? projectRow?.DefaultPageHeight ?? 0) || null,
      projectName: String(projectRow?.ProjectName ?? ""),
      projectVersion: projectRow?.ProjectInternalVersion == null
        ? null
        : String(projectRow.ProjectInternalVersion),
      paperColor: paperColorOf(projectRow),
      layers,
      layerTree,
      mipmaps,
      timeline,
      // The layer that was selected when the document was saved. It is the
      // one the work was done on, so it is the one the brush belongs on.
      currentLayerId: Number(canvasRow?.CanvasCurrentLayer ?? 0) || null,
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
    let externalRows = [];
    try {
      externalRows = db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all();
    } catch {
      // A document without the table simply has no external blobs.
      externalRows = [];
    }
    for (const row of externalRows) {
      const chunk = container.chunks.find((item) => item.headerOffset === Number(row.Offset));
      if (chunk) externalById.set(asText(row.ExternalID), chunk);
    }

    const mipmapById = new Map();
    try {
      for (const mipmap of db.prepare("SELECT MainId, BaseMipmapInfo FROM Mipmap").all()) {
        mipmapById.set(Number(mipmap.MainId ?? 0), Number(mipmap.BaseMipmapInfo ?? 0));
      }
    } catch {
      // A document without mipmaps simply has no rasters to read.
    }

    const offscreenById = new Map();
    try {
      for (const row of db.prepare("SELECT MainId, Attribute, BlockData FROM Offscreen").all()) {
        offscreenById.set(Number(row.MainId ?? 0), row);
      }
    } catch {
      // No offscreen table, no layers.
    }

    let layerRows = [];
    try {
      // A document may leave the offset columns out, so the columns that are
      // really there are asked for first.
      const columns = db.prepare("PRAGMA table_info(Layer)").all().map((row) => row.name);
      const wanted = [
        "MainId", "LayerName", "LayerType", "LayerFolder", "LayerRenderMipmap",
        "LayerOffsetX", "LayerOffsetY",
      ];
      const present = wanted.filter((name) => columns.includes(name));
      layerRows = db
        .prepare(`SELECT ${present.join(", ")} FROM Layer`)
        .all();
    } catch {
      layerRows = [];
    }

    const results = [];
    for (const layer of layerRows) {
      if (Number(layer.LayerFolder ?? 0) !== 0) continue;
      const isPaper = Number(layer.LayerType ?? 0) === 1584;
      if (isPaper && !includePaper) continue;

      const baseInfo = mipmapById.get(Number(layer.LayerRenderMipmap ?? 0));
      if (!baseInfo) continue;
      let info = null;
      try {
        info = db
          .prepare("SELECT Offscreen FROM MipmapInfo WHERE MainId = ?")
          .get(baseInfo);
      } catch {
        info = null;
      }
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
        // Where the picture sits on the canvas: the place of the layer
        // itself. The offset of the layer's own buffer says where the layer
        // was drawn from, not where its picture is.
        offsetX: Number(layer.LayerOffsetX ?? 0),
        offsetY: Number(layer.LayerOffsetY ?? 0),
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
