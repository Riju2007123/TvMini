import { BEHAVIORS, isBehavior } from "../timeline.js";
import { Buffer } from "./bytes.js";

export const FORMAT = "tvmini";
export const VERSION = 2;
export const MAX_STROKES = 10000;
export const MAX_LAYERS = 100;
export const MAX_DRAWINGS_PER_LAYER = 1000;
export const MAX_TOTAL_DRAWINGS = 5000;
export const MAX_FPS = 120;
export const MAX_START_FRAME = 100000;
export const MAX_HOLD = 10000;
export const MIN_SIZE = 16;
export const MAX_SIZE = 4096;

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
    drawings: [],
  };
}

/** Create a blank, already-valid project. */
export function createProject(width = 960, height = 600, background = "#ffffff") {
  return {
    format: FORMAT,
    version: VERSION,
    width: integerInRange(width, "width", MIN_SIZE, MAX_SIZE),
    height: integerInRange(height, "height", MIN_SIZE, MAX_SIZE),
    background: color(background, "background"),
    image: null,
    fps: 12,
    startFrame: 1,
    currentLayer: 0,
    currentFrame: 1,
    loop: true,
    layers: [createLayer("Layer 1")],
  };
}

function normalizeImage(value, width, height) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("image must be an object");
  }

  const imageWidth = integerInRange(value.width, "image.width", MIN_SIZE, MAX_SIZE);
  const imageHeight = integerInRange(value.height, "image.height", MIN_SIZE, MAX_SIZE);

  if (imageWidth !== width || imageHeight !== height) {
    throw new ValidationError("image size must match the canvas");
  }
  if (typeof value.data !== "string" || value.data.length === 0) {
    throw new ValidationError("image.data must be base64 text");
  }
  if (value.data.length > 8_000_000) {
    throw new ValidationError("image.data is too large");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
    throw new ValidationError("image.data must be base64 text");
  }

  const bytes = Buffer.from(value.data, "base64");
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new ValidationError("image.data must be a PNG");
  }

  return { data: value.data, width: imageWidth, height: imageHeight };
}

function normalizeLayer(value, index, startFrame) {
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
  if (type !== "anim") {
    throw new ValidationError(`${label}.type must be "anim"`);
  }

  const visible = value.visible === undefined ? true : boolean(value.visible, `${label}.visible`);
  const locked = value.locked === undefined ? false : boolean(value.locked, `${label}.locked`);
  const opacity =
    value.opacity === undefined ? 1 : numberInRange(value.opacity, `${label}.opacity`, 0, 1);
  const blend = value.blend === undefined ? "normal" : value.blend;
  if (blend !== "normal") {
    throw new ValidationError(`${label}.blend must be "normal"`);
  }

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
    return { at, hold, strokes };
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
    drawings,
  };
}

/**
 * Validate an untrusted object and return a clean copy.
 *
 * Version 1 files (a flat `strokes` array) are migrated to version 2: the
 * strokes become one drawing at frame 1 on a single animation layer.
 */
export function normalizeProject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("project must be an object");
  }
  if (input.format !== FORMAT) {
    throw new ValidationError(`not a ${FORMAT} project (format=${JSON.stringify(input.format)})`);
  }
  if (input.version !== 1 && input.version !== VERSION) {
    throw new ValidationError(`unsupported project version ${JSON.stringify(input.version)}`);
  }

  const width = integerInRange(input.width, "width", MIN_SIZE, MAX_SIZE);
  const height = integerInRange(input.height, "height", MIN_SIZE, MAX_SIZE);
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

  const layers = input.layers.map((layer, index) => normalizeLayer(layer, index, startFrame));

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
