import { BEHAVIORS, CAMERA_INTERP, LAYER_TYPES, isBehavior } from "../timeline.js";
import { Buffer } from "./bytes.js";

export const FORMAT = "tvmini";
export const VERSION = 3;
export const MAX_STROKES = 10000;
export const MAX_LAYERS = 500;
export const MAX_DRAWINGS_PER_LAYER = 2000;
export const MAX_TOTAL_DRAWINGS = 20000;
export const MAX_FPS = 120;
export const MAX_START_FRAME = 100000;
export const MAX_HOLD = 10000;
export const MIN_SIZE = 16;
export const MAX_SIZE = 8192;
/**
 * The largest canvas a project may hold, in pixels.
 *
 * A side of up to `MAX_SIZE` alone is not enough: an 8192 by 8192 canvas is
 * 67 million pixels, and a layer of that costs 268 MB before any drawing.
 * Clip Studio documents of 4152 by 3400 are common, and they fit here.
 */
export const MAX_PIXELS = 40_000_000;

/** Camera keyframes on the timeline (a moving view over the canvas). */
export const MAX_CAMERA_KEYS = 1000;
/** Largest embedded audio track, in base64 characters. */
export const MAX_AUDIO_CHARS = 12_000_000;

/** Shape tools store their geometry kind on the stroke (absent = freehand). */
export const STROKE_KINDS = ["line", "rect", "ellipse", "fill"];
/** Per-stroke blend modes (absent = "normal"). */
export const BLEND_MODES = ["normal", "multiply", "screen"];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return value;
}

function numberInRange(value, label, min, max) {
  const n = finiteNumber(value, label);
  if (n < min || n > max) {
    throw new ValidationError(`${label} must be between ${min} and ${max}`);
  }
  return n;
}

function integerInRange(value, label, min, max) {
  const n = finiteNumber(value, label);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${label} must be a boolean`);
  }
  return value;
}

function color(value, label) {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new ValidationError(`${label} must look like #rrggbb`);
  }
  return value.toLowerCase();
}

function points(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${label} must contain at least one point`);
  }
  if (value.length > 200000) {
    throw new ValidationError(`${label} has too many points`);
  }
  return value.map((point, index) => {
    if (!Array.isArray(point) || (point.length !== 2 && point.length !== 3)) {
      throw new ValidationError(`${label}[${index}] must be [x, y] or [x, y, pressure]`);
    }
    const x = finiteNumber(point[0], `${label}[${index}][0]`);
    const y = finiteNumber(point[1], `${label}[${index}][1]`);
    if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) {
      throw new ValidationError(`${label}[${index}] is out of range`);
    }
    if (point.length === 2) return [x, y];

    const pressure = finiteNumber(point[2], `${label}[${index}][2]`);
    if (pressure < 0 || pressure > 1) {
      throw new ValidationError(`${label}[${index}][2] must be between 0 and 1`);
    }
    return [x, y, pressure];
  });
}

function normalizeStrokes(value, label) {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`);
  }
  if (value.length > MAX_STROKES) {
    throw new ValidationError(`too many strokes (max ${MAX_STROKES})`);
  }

  const strokes = value.map((stroke, index) => {
    if (!stroke || typeof stroke !== "object" || Array.isArray(stroke)) {
      throw new ValidationError(`${label}[${index}] must be an object`);
    }

    const clean = {
      color: color(stroke.color, `${label}[${index}].color`),
      width: finiteNumber(stroke.width, `${label}[${index}].width`),
      points: points(stroke.points, `${label}[${index}].points`),
    };

    if (stroke.eraser !== undefined) {
      if (typeof stroke.eraser !== "boolean") {
        throw new ValidationError(`${label}[${index}].eraser must be a boolean`);
      }
      if (stroke.eraser) clean.eraser = true;
    }

    if (stroke.hard !== undefined) {
      if (typeof stroke.hard !== "boolean") {
        throw new ValidationError(`${label}[${index}].hard must be a boolean`);
      }
      if (stroke.hard) clean.hard = true;
    }

    if (stroke.kind !== undefined) {
      if (!STROKE_KINDS.includes(stroke.kind)) {
        throw new ValidationError(
          `${label}[${index}].kind must be one of ${STROKE_KINDS.join(", ")}`,
        );
      }
      if (stroke.kind === "fill" && clean.eraser) {
        throw new ValidationError(`${label}[${index}] cannot be both a fill and an eraser`);
      }
      clean.kind = stroke.kind;
    }

    if (stroke.opacity !== undefined) {
      const opacity = numberInRange(stroke.opacity, `${label}[${index}].opacity`, 0, 1);
      if (opacity < 1) clean.opacity = opacity;
    }

    if (stroke.blend !== undefined) {
      if (!BLEND_MODES.includes(stroke.blend)) {
        throw new ValidationError(
          `${label}[${index}].blend must be one of ${BLEND_MODES.join(", ")}`,
        );
      }
      if (stroke.blend !== "normal") clean.blend = stroke.blend;
    }

    // A stroke remembers the brush it was made with, the way Clip Studio
    // Paint does, so that changing the brush afterwards does not change the
    // strokes that are already on the paper.
    if (stroke.brush !== undefined) {
      const brush = normalizeBrush(stroke.brush, 8_000_000, `${label}[${index}].brush`);
      // A stroke that was made without a picture says so, and that is kept.
      clean.brush = brush;
    }

    return clean;
  });

  for (let i = 0; i < strokes.length; i += 1) {
    if (strokes[i].width < 1 || strokes[i].width > 200) {
      throw new ValidationError(`${label}[${i}].width must be between 1 and 200`);
    }
  }

  return strokes;
}

export function createLayer(name = "Layer 1") {
  return {
    name,
    type: "anim",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    preBehavior: "none",
    postBehavior: "hold",
    clip: false,
    parent: -1,
    drawings: [],
  };
}

/**
 * Create an empty folder.
 *
 * A folder holds other layers. It has no cells of its own; the cells of the
 * layers inside it show up on the folder's row in the timeline.
 */
export function createGroup(name = "Group") {
  return {
    ...createLayer(name),
    type: "group",
    preBehavior: "hold",
    postBehavior: "hold",
    drawings: [],
  };
}

/**
 * Check that a canvas of this size fits the limits, and return it.
 *
 * Both limits matter: a side may not pass `MAX_SIZE`, and the whole canvas
 * may not pass `MAX_PIXELS`, so a very wide and a very tall canvas are
 * refused even when each side is within range.
 */
function canvasInRange(width, height) {
  const w = integerInRange(width, "width", MIN_SIZE, MAX_SIZE);
  const h = integerInRange(height, "height", MIN_SIZE, MAX_SIZE);
  const pixels = w * h;
  if (pixels > MAX_PIXELS) {
    throw new ValidationError(
      `the canvas is ${w}×${h} = ${pixels} pixels; TVMini supports up to ${MAX_PIXELS} pixels`,
    );
  }
  return { width: w, height: h };
}

/** Create a blank, already-valid project. */
export function createProject(width = 960, height = 600, background = "#ffffff") {
  const size = canvasInRange(width, height);
  return {
    format: FORMAT,
    version: VERSION,
    width: size.width,
    height: size.height,
    background: color(background, "background"),
    image: null,
    fps: 12,
    startFrame: 1,
    currentLayer: 0,
    currentFrame: 1,
    loop: true,
    camera: null,
    audio: null,
    layers: [createLayer("Layer 1")],
  };
}

function normalizeImage(value, width, height, maxBase64 = 8_000_000, label = "image") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }

  const imageWidth = integerInRange(value.width, `${label}.width`, MIN_SIZE, MAX_SIZE);
  const imageHeight = integerInRange(value.height, `${label}.height`, MIN_SIZE, MAX_SIZE);

  if (imageWidth !== width || imageHeight !== height) {
    throw new ValidationError(`${label} size must match the canvas`);
  }
  if (typeof value.data !== "string" || value.data.length === 0) {
    throw new ValidationError(`${label}.data must be base64 text`);
  }
  if (value.data.length > maxBase64) {
    throw new ValidationError(`${label}.data is too large`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
    throw new ValidationError(`${label}.data must be base64 text`);
  }

  const bytes = Buffer.from(value.data, "base64");
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new ValidationError(`${label}.data must be a PNG`);
  }

  return { data: value.data, width: imageWidth, height: imageHeight };
}

/**
 * Check a brush image.
 *
 * A brush keeps its own size, not the size of the canvas, so it is checked
 * on its own. The size is read out of the picture itself rather than taken
 * on trust.
 */
function normalizeBrush(value, maxBase64, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  if (typeof value.data !== "string" || value.data.length === 0) {
    throw new ValidationError(`${label}.data must be base64 text`);
  }
  if (value.data.length > maxBase64) {
    throw new ValidationError(`${label}.data is too large`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
    throw new ValidationError(`${label}.data must be base64 text`);
  }
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new ValidationError(`${label}.data must be a PNG`);
  }
  const brush = {
    data: value.data,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
  // A brush that comes from Clip Studio Paint has a size and a strength of
  // its own, and they are kept with it.
  if (Number.isFinite(value.size) && value.size > 0) brush.size = value.size;
  if (Number.isFinite(value.opacity) && value.opacity > 0) brush.opacity = value.opacity;
  return brush;
}

function normalizeLayer(value, index, startFrame, projectWidth, projectHeight) {
  const label = `layers[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }

  if (typeof value.name !== "string") {
    throw new ValidationError(`${label}.name must be text`);
  }
  const name = value.name.trim();
  if (name.length === 0) {
    throw new ValidationError(`${label}.name must not be empty`);
  }
  if (name.length > 80) {
    throw new ValidationError(`${label}.name must be 80 characters or fewer`);
  }

  const type = value.type === undefined ? "anim" : value.type;
  if (!LAYER_TYPES.includes(type)) {
    throw new ValidationError(`${label}.type must be one of ${LAYER_TYPES.join(", ")}`);
  }

  const visible = value.visible === undefined ? true : boolean(value.visible, `${label}.visible`);
  const locked = value.locked === undefined ? false : boolean(value.locked, `${label}.locked`);
  const opacity =
    value.opacity === undefined ? 1 : numberInRange(value.opacity, `${label}.opacity`, 0, 1);
  const blend = value.blend === undefined ? "normal" : value.blend;
  if (blend !== "normal") {
    throw new ValidationError(`${label}.blend must be "normal"`);
  }

  const clip = value.clip === undefined ? false : boolean(value.clip, `${label}.clip`);
  const parent =
    value.parent === undefined
      ? -1
      : integerInRange(value.parent, `${label}.parent`, -1, 1_000_000);

  const preBehavior = value.preBehavior === undefined ? "none" : value.preBehavior;
  const postBehavior = value.postBehavior === undefined ? "hold" : value.postBehavior;
  if (!isBehavior(preBehavior)) {
    throw new ValidationError(`${label}.preBehavior must be one of ${BEHAVIORS.join(", ")}`);
  }
  if (!isBehavior(postBehavior)) {
    throw new ValidationError(`${label}.postBehavior must be one of ${BEHAVIORS.join(", ")}`);
  }

  if (!Array.isArray(value.drawings)) {
    throw new ValidationError(`${label}.drawings must be an array`);
  }
  if (value.drawings.length > MAX_DRAWINGS_PER_LAYER) {
    throw new ValidationError(
      `${label}.drawings has too many entries (max ${MAX_DRAWINGS_PER_LAYER})`,
    );
  }

  const drawings = value.drawings.map((drawing, drawingIndex) => {
    const dLabel = `${label}.drawings[${drawingIndex}]`;
    if (!drawing || typeof drawing !== "object" || Array.isArray(drawing)) {
      throw new ValidationError(`${dLabel} must be an object`);
    }

    const at = integerInRange(drawing.at, `${dLabel}.at`, 1, 10_000_000);
    if (at < startFrame) {
      throw new ValidationError(`${dLabel}.at must be at or after startFrame`);
    }
    const hold = integerInRange(drawing.hold, `${dLabel}.hold`, 1, MAX_HOLD);
    const strokes = normalizeStrokes(drawing.strokes, `${dLabel}.strokes`);

    const clean = { at, hold, strokes };
    // A cell can carry a name, the way Clip Studio Paint names the cells of
    // an animation folder. A name that is not text is refused.
    if (drawing.name !== undefined && drawing.name !== null) {
      if (typeof drawing.name !== "string") {
        throw new ValidationError(`${dLabel}.name must be text`);
      }
      const cellLabel = drawing.name.trim();
      if (cellLabel.length > 80) {
        throw new ValidationError(`${dLabel}.name must be 80 characters or fewer`);
      }
      if (cellLabel.length > 0) clean.name = cellLabel;
    }
    // A drawing may carry a raster base (imported .tvpp frames render through
    // it). Regular drawings simply never set this field.
    if (drawing.image !== undefined) {
      const image = normalizeImage(
        drawing.image,
        projectWidth,
        projectHeight,
        24_000_000,
        `${dLabel}.image`,
      );
      if (image) clean.image = image;
    }
    // A drawing may carry a brush image, the way a Clip Studio Paint brush
    // does. Its alpha is the shape of the brush.
    if (drawing.brush !== undefined) {
      const brush = normalizeBrush(drawing.brush, 8_000_000, `${dLabel}.brush`);
      if (brush) clean.brush = brush;
    }
    // A stroke remembers the brush it was made with, so that changing the
    // brush does not change the strokes that are already on the paper. A
    // drawing that was made before that was so gets the brush of the drawing
    // put on its strokes, so that the strokes keep the brush they were made
    // with from now on.
    if (clean.brush) {
      for (const stroke of clean.strokes) {
        if (!("brush" in stroke)) stroke.brush = clean.brush;
      }
    }
    return clean;
  });

  drawings.sort((a, b) => a.at - b.at);
  for (let i = 1; i < drawings.length; i += 1) {
    const previous = drawings[i - 1];
    if (drawings[i].at < previous.at + previous.hold) {
      throw new ValidationError(`${label}.drawings overlap at frame ${drawings[i].at}`);
    }
  }

  return {
    name,
    type,
    visible,
    locked,
    opacity,
    blend,
    preBehavior,
    postBehavior,
    clip,
    parent,
    drawings,
  };
}

/**
 * Check that every layer sits in a folder that exists.
 *
 * A layer points at the folder that holds it, so a folder comes before the
 * layers it holds and a layer may not hold itself.
 */
function normalizeLayerParents(layers) {
  for (let index = 0; index < layers.length; index += 1) {
    const parent = layers[index].parent;
    if (parent === -1) continue;
    if (parent === index) {
      throw new ValidationError(`layers[${index}].parent must not be the layer itself`);
    }
    if (parent < 0 || parent >= layers.length) {
      throw new ValidationError(`layers[${index}].parent must be a layer in this project`);
    }
    if (layers[parent].type !== "group") {
      throw new ValidationError(`layers[${index}].parent must be a folder`);
    }
    if (parent >= index) {
      throw new ValidationError(`layers[${index}].parent must come before the layer it holds`);
    }
    // The chain of folders must not loop.
    const seen = new Set([index]);
    let walk = parent;
    while (walk !== -1) {
      if (seen.has(walk)) {
        throw new ValidationError(`layers[${index}].parent makes a loop in the folders`);
      }
      seen.add(walk);
      walk = layers[walk].parent;
    }
  }
}

/**
 * Validate the camera track: a list of keyframes, each one a window over
 * the canvas. The camera holds the last key until the next one arrives.
 */
function normalizeCamera(value, label, width, height) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  if (!Array.isArray(value.keys)) {
    throw new ValidationError(`${label}.keys must be an array`);
  }
  if (value.keys.length > MAX_CAMERA_KEYS) {
    throw new ValidationError(`${label}.keys has too many entries (max ${MAX_CAMERA_KEYS})`);
  }

  const keys = value.keys.map((key, index) => {
    const kLabel = `${label}.keys[${index}]`;
    if (!key || typeof key !== "object" || Array.isArray(key)) {
      throw new ValidationError(`${kLabel} must be an object`);
    }
    const frame = integerInRange(key.frame, `${kLabel}.frame`, 1, 10_000_000);
    const x = finiteNumber(key.x === undefined ? 0 : key.x, `${kLabel}.x`);
    const y = finiteNumber(key.y === undefined ? 0 : key.y, `${kLabel}.y`);
    const keyWidth = numberInRange(
      key.width === undefined ? width : key.width,
      `${kLabel}.width`,
      1,
      MAX_SIZE * 4,
    );
    const keyHeight = numberInRange(
      key.height === undefined ? height : key.height,
      `${kLabel}.height`,
      1,
      MAX_SIZE * 4,
    );
    const rotation = finiteNumber(
      key.rotation === undefined ? 0 : key.rotation,
      `${kLabel}.rotation`,
    );
    const interp = key.interp === undefined ? "linear" : key.interp;
    if (!CAMERA_INTERP.includes(interp)) {
      throw new ValidationError(`${kLabel}.interp must be one of ${CAMERA_INTERP.join(", ")}`);
    }
    return { frame, x, y, width: keyWidth, height: keyHeight, rotation, interp };
  });

  keys.sort((a, b) => a.frame - b.frame);
  for (let i = 1; i < keys.length; i += 1) {
    if (keys[i].frame === keys[i - 1].frame) {
      throw new ValidationError(`${label}.keys has two keys on frame ${keys[i].frame}`);
    }
  }

  return { keys };
}

/** Validate the optional audio track stored with the project. */
function normalizeAudio(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  if (typeof value.data !== "string" || value.data.length === 0) {
    throw new ValidationError(`${label}.data must be a base64 string`);
  }
  if (value.data.length > MAX_AUDIO_CHARS) {
    throw new ValidationError(`${label}.data is too large (max ${MAX_AUDIO_CHARS} characters)`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new ValidationError(`${label}.name must be text`);
  }
  const name = value.name.trim();
  if (name.length > 120) {
    throw new ValidationError(`${label}.name must be 120 characters or fewer`);
  }
  const duration = numberInRange(
    value.duration === undefined ? 0 : value.duration,
    `${label}.duration`,
    0,
    24 * 60 * 60,
  );
  const offset = numberInRange(
    value.offset === undefined ? 0 : value.offset,
    `${label}.offset`,
    -24 * 60 * 60,
    24 * 60 * 60,
  );
  return { name, data: value.data, duration, offset };
}

/**
 * Validate an untrusted object and return a clean copy.
 *
 * Version 1 files (a flat `strokes` array) are migrated to the current
 * version: the strokes become one drawing at frame 1 on a single animation
 * layer. Version 2 files are the same, except that their layers have no
 * folder, no clip mask and their cells have no name.
 */
export function normalizeProject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("project must be an object");
  }
  if (input.format !== FORMAT) {
    throw new ValidationError(`not a ${FORMAT} project (format=${JSON.stringify(input.format)})`);
  }
  if (input.version !== 1 && input.version !== 2 && input.version !== VERSION) {
    throw new ValidationError(`unsupported project version ${JSON.stringify(input.version)}`);
  }

  const { width, height } = canvasInRange(input.width, input.height);
  const background = color(input.background, "background");
  const image = normalizeImage(input.image, width, height);

  if (input.version === 1) {
    const strokes = normalizeStrokes(input.strokes, "strokes");
    const layer = createLayer("Layer 1");
    if (strokes.length > 0) layer.drawings.push({ at: 1, hold: 1, strokes });

    return {
      format: FORMAT,
      version: VERSION,
      width,
      height,
      background,
      image,
      fps: 12,
      startFrame: 1,
      currentLayer: 0,
      currentFrame: 1,
      loop: true,
      camera: null,
      audio: null,
      layers: [layer],
    };
  }

  const fps = numberInRange(input.fps, "fps", 1, MAX_FPS);
  const startFrame = integerInRange(input.startFrame, "startFrame", 1, MAX_START_FRAME);
  const loop = boolean(input.loop, "loop");

  if (!Array.isArray(input.layers)) {
    throw new ValidationError("layers must be an array");
  }
  if (input.layers.length === 0) {
    throw new ValidationError("at least one layer is required");
  }
  if (input.layers.length > MAX_LAYERS) {
    throw new ValidationError(`too many layers (max ${MAX_LAYERS})`);
  }

  const layers = input.layers.map((layer, index) =>
    normalizeLayer(layer, index, startFrame, width, height),
  );
  normalizeLayerParents(layers);

  let totalDrawings = 0;
  let totalStrokes = 0;
  for (const layer of layers) {
    totalDrawings += layer.drawings.length;
    for (const drawing of layer.drawings) totalStrokes += drawing.strokes.length;
  }
  if (totalDrawings > MAX_TOTAL_DRAWINGS) {
    throw new ValidationError(`too many drawings (max ${MAX_TOTAL_DRAWINGS})`);
  }
  if (totalStrokes > MAX_STROKES) {
    throw new ValidationError(`too many strokes (max ${MAX_STROKES})`);
  }

  const currentLayer = integerInRange(input.currentLayer, "currentLayer", 0, layers.length - 1);
  const currentFrame = integerInRange(input.currentFrame, "currentFrame", 1, 10_000_000);
  if (currentFrame < startFrame) {
    throw new ValidationError("currentFrame must be at or after startFrame");
  }

  // The camera track and the audio track are optional; an older file simply
  // has neither and opens with the plain canvas view and no sound.
  const camera =
    input.camera === undefined || input.camera === null
      ? null
      : normalizeCamera(input.camera, "camera", width, height);
  const audio =
    input.audio === undefined || input.audio === null
      ? null
      : normalizeAudio(input.audio, "audio");

  return {
    format: FORMAT,
    version: VERSION,
    width,
    height,
    background,
    image,
    fps,
    startFrame,
    currentLayer,
    currentFrame,
    loop,
    camera,
    audio,
    layers,
  };
}

/**
 * Normalize a user-supplied project path.
 *
 * The browser build has no filesystem paths, so this only appends the
 * extension. The Node build layers `path.normalize` on top of it.
 */
export function projectPath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = filePath.trim();
  return /\.[^\\/]*$/.test(clean) ? clean : `${clean}.tvmini`;
}
