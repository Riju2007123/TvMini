import path from "node:path";

export const FORMAT = "tvmini";
export const VERSION = 1;
export const MAX_STROKES = 10000;
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

function integerInRange(value, label, min, max) {
  const n = finiteNumber(value, label);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return n;
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


/** Create a blank project. */
export function createProject(width = 960, height = 600, background = "#ffffff") {
  return {
    format: FORMAT,
    version: VERSION,
    width: integerInRange(width, "width", MIN_SIZE, MAX_SIZE),
    height: integerInRange(height, "height", MIN_SIZE, MAX_SIZE),
    background: color(background, "background"),
    strokes: [],
  };
}

/**
 * Validate an untrusted object and return a clean copy.
 * Throws ValidationError with a human-readable message.
 */
export function normalizeProject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("project must be an object");
  }
  if (input.format !== FORMAT) {
    throw new ValidationError(`not a ${FORMAT} project (format=${JSON.stringify(input.format)})`);
  }
  if (input.version !== VERSION) {
    throw new ValidationError(`unsupported project version ${JSON.stringify(input.version)}`);
  }

  const width = integerInRange(input.width, "width", MIN_SIZE, MAX_SIZE);
  const height = integerInRange(input.height, "height", MIN_SIZE, MAX_SIZE);
  const background = color(input.background, "background");

  if (!Array.isArray(input.strokes)) {
    throw new ValidationError("strokes must be an array");
  }
  if (input.strokes.length > MAX_STROKES) {
    throw new ValidationError(`too many strokes (max ${MAX_STROKES})`);
  }

  const strokes = input.strokes.map((stroke, index) => {
    if (!stroke || typeof stroke !== "object" || Array.isArray(stroke)) {
      throw new ValidationError(`strokes[${index}] must be an object`);
    }
    return {
      color: color(stroke.color, `strokes[${index}].color`),
      width: finiteNumber(stroke.width, `strokes[${index}].width`),
      points: points(stroke.points, `strokes[${index}].points`),
    };
  });

  for (let i = 0; i < strokes.length; i += 1) {
    if (strokes[i].width < 1 || strokes[i].width > 200) {
      throw new ValidationError(`strokes[${i}].width must be between 1 and 200`);
    }
  }

  return { format: FORMAT, version: VERSION, width, height, background, strokes };
}

/** Normalize a user-supplied project path. */
export function projectPath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = path.normalize(filePath.trim());
  return path.extname(clean) === "" ? `${clean}.tvmini` : clean;
}
