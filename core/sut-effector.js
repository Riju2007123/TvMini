import { Buffer } from "./bytes.js";

/**
 * The pressure, tilt and random settings of a Clip Studio Paint brush.
 *
 * A brush says how its paint follows the hand in a `Brush*Effector` column:
 * one of those columns for the size, one for the opacity, one for the flow,
 * one for the thickness, and so on. Each of them is a small big-endian block
 * holding
 *
 *   - a header of 40 or 44 bytes: which inputs are used (pressure, tilt,
 *     velocity, random), the smallest and the largest value of each, and the
 *     size of the two curve sections that follow;
 *   - one or two curve sections: a list of control points, each a pair of
 *     doubles, which say how much of the setting is left for a given input.
 *
 * The layout was read from the brushes themselves and agrees with the
 * description in Kenneth Evans' CSP Brush Info (MIT), whose `interpretEffector`
 * was the first public write-up of it. Nothing here is copied from Clip Studio
 * Paint; a column that cannot be read is kept as it is and simply not used.
 *
 * The bits of the flag are 0x10 pressure, 0x20 tilt, 0x40 velocity and
 * 0x80 random.
 */

/** The two header sizes Clip Studio Paint writes. */
const HEADER_SIZES = [40, 44];

/** The bits of the flag word. */
export const INPUT_BITS = {
  pressure: 0x10,
  tilt: 0x20,
  velocity: 0x40,
  random: 0x80,
};

/** The bytes of a blob, whichever way it was handed in. */
function toBytes(blob) {
  if (blob === null || blob === undefined) return null;
  if (typeof blob === "string") {
    try {
      return Buffer.from(blob, "base64");
    } catch {
      return null;
    }
  }
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (blob?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(blob.buffer, blob.byteOffset ?? 0, blob.byteLength ?? blob.buffer.byteLength);
  }
  return null;
}

/**
 * Read one `Brush*Effector` block.
 *
 * Returns null when the block is not one of the two shapes that are known,
 * or when a section does not fit the bytes that are there. A block that is
 * refused is never guessed at: the caller keeps the bytes and the brush
 * simply does not follow that input.
 */
export function parseEffector(blob) {
  const bytes = toBytes(blob);
  if (!bytes || bytes.length < 40) return null;

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const u32 = () => {
      const value = view.getUint32(at, false);
      at += 4;
      return value;
    };
    const i32 = () => {
      const value = view.getInt32(at, false);
      at += 4;
      return value;
    };
    const f64 = () => {
      const value = view.getFloat64(at, false);
      at += 8;
      return value;
    };

    const headerBytes = u32();
    if (!HEADER_SIZES.includes(headerBytes) || bytes.length < headerBytes) return null;

    // A number whose meaning is not known. It is not the same in every file
    // (the brushes of Clip Studio Paint on this machine carry 496), so it is
    // kept and written back rather than replaced with a zero.
    const unknown1 = u32();
    const flags = u32();
    const pressureMin = i32();
    const tiltMin = i32();
    const velocityMax = i32();
    const randomMin = i32();
    const unknown2 = u32(); // Not known either; kept the same way.
    const firstSize = u32();
    const secondSize = u32();
    let tiltMax = null;
    if (headerBytes === 44) tiltMax = i32();

    // The sections are cut by the sizes written in the header, never by
    // walking from the end: a block whose first section is empty would
    // otherwise slide the second section (the tilt curve) into the place of
    // the first (the pressure curve).
    if (at !== headerBytes) return null;
    if (headerBytes + firstSize + secondSize > bytes.length) return null;

    let sectionAt = headerBytes;
    const readSection = (size) => {
      if (!size) return null;
      if (size < 12) return null;
      const start = sectionAt;
      let cursor = start;
      const read = () => {
        const value = view.getUint32(cursor, false);
        cursor += 4;
        return value;
      };
      const head = read();
      const count = read();
      const stride = read();
      if (head !== 12 || stride !== 16) return null;
      if (count === 0) return null;
      if (size < 12 + count * 16) return null;
      const points = [];
      for (let index = 0; index < count; index += 1) {
        cursor = start + 12 + index * 16;
        const x = view.getFloat64(cursor, false);
        const y = view.getFloat64(cursor + 8, false);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        points.push([x, y]);
      }
      sectionAt = start + size;
      return points;
    };

    const first = readSection(firstSize);
    const second = readSection(secondSize);

    return {
      headerBytes,
      unknown1,
      unknown2,
      flags,
      usesPressure: (flags & INPUT_BITS.pressure) !== 0,
      usesTilt: (flags & INPUT_BITS.tilt) !== 0,
      usesVelocity: (flags & INPUT_BITS.velocity) !== 0,
      usesRandom: (flags & INPUT_BITS.random) !== 0,
      pressureMin,
      tiltMin,
      tiltMax,
      velocityMax,
      randomMin,
      // The first section is the pressure curve, the second the tilt curve.
      pressureCurve: first,
      tiltCurve: second,
      // The names the first reader of this program used, kept so that a
      // brush that is already in a project still reads.
      pmin: pressureMin,
      tmin: tiltMin,
      rmin: randomMin,
      vmax: velocityMax,
      max: tiltMax,
      curve: first,
      curve2: second,
    };
  } catch {
    return null;
  }
}

/**
 * Write one `Brush*Effector` block back.
 *
 * The two sections are written after a header whose sizes are worked out from
 * the curves, so a block that was read and written back is the same block.
 * A curve of fewer than two points is written as an empty section.
 */
export function writeEffector(effector) {
  if (!effector) return null;
  const headerBytes = effector.headerBytes === 44 ? 44 : 40;
  const pressureCurve = cleanCurve(effector.pressureCurve ?? effector.curve);
  const tiltCurve = cleanCurve(effector.tiltCurve ?? effector.curve2);
  const pressureSize = sectionSize(pressureCurve);
  const tiltSize = sectionSize(tiltCurve);

  const flags =
    (effector.usesPressure === true || effector.pressure === true ? INPUT_BITS.pressure : 0) |
    (effector.usesTilt === true || effector.tilt === true ? INPUT_BITS.tilt : 0) |
    (effector.usesVelocity === true || effector.velocity === true ? INPUT_BITS.velocity : 0) |
    (effector.usesRandom === true || effector.random === true ? INPUT_BITS.random : 0);

  const out = new Uint8Array(headerBytes + pressureSize + tiltSize);
  const view = new DataView(out.buffer);
  let at = 0;
  const u32 = (value) => {
    view.setUint32(at, value >>> 0, false);
    at += 4;
  };
  const i32 = (value) => {
    view.setInt32(at, Math.round(value) | 0, false);
    at += 4;
  };

  u32(headerBytes);
  u32(numberOf(effector.unknown1));
  u32(flags);
  i32(numberOf(effector.pressureMin ?? effector.pmin));
  i32(numberOf(effector.tiltMin ?? effector.tmin));
  i32(numberOf(effector.velocityMax ?? effector.vmax));
  i32(numberOf(effector.randomMin ?? effector.rmin));
  u32(numberOf(effector.unknown2));
  u32(pressureSize);
  u32(tiltSize);
  if (headerBytes === 44) i32(numberOf(effector.tiltMax ?? effector.max));

  let cursor = headerBytes;
  writeSection(out, view, cursor, pressureCurve);
  cursor += pressureSize;
  writeSection(out, view, cursor, tiltCurve);
  return out;
}

/** A curve as a list of finite pairs, or null. */
function cleanCurve(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const out = [];
  for (const point of points) {
    const x = Array.isArray(point) ? point[0] : point?.x;
    const y = Array.isArray(point) ? point[1] : point?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([Number(x), Number(y)]);
  }
  return out;
}

/** How many bytes a curve takes: a 12 byte head and 16 bytes a point. */
function sectionSize(points) {
  return points ? 12 + points.length * 16 : 0;
}

/** Put one curve section into a block. */
function writeSection(out, view, start, points) {
  if (!points) return;
  view.setUint32(start, 12, false);
  view.setUint32(start + 4, points.length, false);
  view.setUint32(start + 8, 16, false);
  for (let index = 0; index < points.length; index += 1) {
    const at = start + 12 + index * 16;
    view.setFloat64(at, points[index][0], false);
    view.setFloat64(at + 8, points[index][1], false);
  }
  return out;
}

function numberOf(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/* ------------------------------------------------------------- the curve */

/**
 * The value of a curve at `x`, from 0 to 1.
 *
 * The control points are a list of `[x, y]` pairs in that order. Two points
 * are a line; more than two are joined smoothly, without overshooting the
 * points on either side, which is what a pressure curve has to do: a curve
 * that dips below its own points would make a brush thinner than its
 * smallest value.
 */
export function curveValue(points, x) {
  if (!Array.isArray(points) || points.length === 0) return clamp01(x);
  const input = clamp01(x);
  if (points.length === 1) return clamp01(points[0][1]);

  const sorted = points;
  if (input <= sorted[0][0]) return clamp01(sorted[0][1]);
  const last = sorted[sorted.length - 1];
  if (input >= last[0]) return clamp01(last[1]);

  let index = 0;
  while (index < sorted.length - 2 && input > sorted[index + 1][0]) index += 1;

  const [x0, y0] = sorted[index];
  const [x1, y1] = sorted[index + 1];
  const span = x1 - x0;
  if (span <= 0) return clamp01(y1);
  const t = (input - x0) / span;

  // The slope at a point is the slope of the line between its neighbours, so
  // the curve passes through every point and turns smoothly at each of them.
  const before = sorted[Math.max(0, index - 1)];
  const after = sorted[Math.min(sorted.length - 1, index + 2)];
  const slope0 = (y1 - before[1]) / Math.max(1e-6, x1 - before[0]);
  const slope1 = (after[1] - y0) / Math.max(1e-6, after[0] - x0);

  // Hermite, with the slopes limited so the curve cannot overshoot: a value
  // between 0 and 1 stays between 0 and 1.
  const h00 = 2 * t * t * t - 3 * t * t + 1;
  const h10 = t * t * t - 2 * t * t + t;
  const h01 = -2 * t * t * t + 3 * t * t;
  const h11 = t * t * t - t * t;
  const value = h00 * y0 + h10 * span * slope0 + h01 * y1 + h11 * span * slope1;
  return clamp01(value);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * The share of a setting an input leaves, from 0 to 1.
 *
 * `input` is the pressure (or the tilt, or the speed) from 0 to 1. The curve
 * says the share between the smallest value of the setting and the whole of
 * it, so a curve that starts at 0.5 and ends at 1 leaves half of the setting
 * when the hand is light and all of it when it is heavy.
 */
export function effectorValue(effector, input) {
  if (!effector) return 1;
  const curve = effector.pressureCurve ?? effector.curve;
  if (!Array.isArray(curve) || curve.length < 2) return 1;
  const least = clamp01(numberOf(effector.pressureMin ?? effector.pmin) / 100);
  return least + (1 - least) * curveValue(curve, input);
}

/**
 * The smallest and the largest share a random setting leaves.
 *
 * A brush that shakes its flow leaves between the smallest value (`rmin`)
 * and the whole of it, at random, for every dab.
 */
export function effectorRandomSpan(effector) {
  if (!effector?.usesRandom) return null;
  const least = clamp01(numberOf(effector.randomMin ?? effector.rmin) / 100);
  return [least, 1];
}
