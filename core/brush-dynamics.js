import { MIN_PRESSURE_SCALE } from "./paint.js";
import {
  curveValue,
  effectorRandomSpan,
  effectorValue,
} from "./sut-effector.js";

/**
 * What a brush does with its paint.
 *
 * A brush of Clip Studio Paint is more than a picture and a width. It says how
 * much paint one dab leaves (the flow), how hard the edge of the tip is (the
 * hardness), how flat the tip is (the thickness), how far apart the dabs are
 * (the spacing), how the tip turns, and what the hand does to all of them (the
 * effectors). This module turns that into the dabs both painters draw: the
 * browser canvas and the software renderer that writes the PNG, the `.clip`
 * and the `.tvpp` use the same plan, so the line on the stage and the line in
 * the file are the same line.
 *
 * Nothing here touches the document or the DOM; it is arithmetic on a brush
 * and a stroke.
 */

/** The version of the shape of `dyn`, so an older project still opens. */
export const DYNAMICS_VERSION = 1;

/** How many control points a curve may keep. */
const MAX_CURVE_POINTS = 64;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, value));
}

/** A curve as `[[x, y], ...]`, or null when it says nothing. */
function curveOf(points) {
  if (!Array.isArray(points)) return null;
  const out = [];
  for (const point of points.slice(0, MAX_CURVE_POINTS)) {
    const x = Array.isArray(point) ? point[0] : point?.x;
    const y = Array.isArray(point) ? point[1] : point?.y;
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) continue;
    out.push([clamp(Number(x), 0, 1), clamp(Number(y), 0, 1)]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * One effector, in the shape a project keeps it.
 *
 * The reader hands back the whole block, including the header size and the
 * flag word; a project only needs to know which inputs are used, the smallest
 * value of each and the curves, so that is what is kept. A block that uses no
 * input at all says nothing about the brush and is dropped.
 */
function compactEffector(effector) {
  if (!effector || typeof effector !== "object") return null;
  const pressure = effector.usesPressure === true || effector.pressure === true;
  const tilt = effector.usesTilt === true || effector.tilt === true;
  const velocity = effector.usesVelocity === true || effector.velocity === true;
  const random = effector.usesRandom === true || effector.random === true;
  if (!pressure && !tilt && !velocity && !random) return null;

  const pressureCurve = curveOf(effector.pressureCurve ?? effector.curve);
  const tiltCurve = curveOf(effector.tiltCurve ?? effector.curve2);
  return {
    // The shape of the block itself, so a brush that is written back is the
    // same block: Clip Studio Paint writes two header sizes, and the two
    // numbers whose meaning is not known must not be replaced with zeros.
    headerBytes: Number(effector.headerBytes) === 44 ? 44 : 40,
    unknown1: number(effector.unknown1),
    unknown2: number(effector.unknown2),
    pressure,
    tilt,
    velocity,
    random,
    pressureMin: clamp(number(effector.pressureMin ?? effector.pmin), -100, 100),
    tiltMin: clamp(number(effector.tiltMin ?? effector.tmin), -1000, 1000),
    tiltMax: clamp(number(effector.tiltMax ?? effector.max), -1000, 1000),
    velocityMax: clamp(number(effector.velocityMax ?? effector.vmax), 0, 1000),
    randomMin: clamp(number(effector.randomMin ?? effector.rmin), -100, 100),
    pressureCurve,
    tiltCurve,
  };
}

/**
 * The effectors of a brush, in the shape a project keeps them.
 *
 * `value` may be the object the reader built or one that came back out of a
 * project file; both have the same names, so the same cleaner reads either.
 */
export function normalizeDynamics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const dyn = { v: DYNAMICS_VERSION };
  let any = false;
  for (const name of [
    "size",
    "opacity",
    "flow",
    "interval",
    "thickness",
    "rotation",
    "paper",
  ]) {
    const effector = compactEffector(value[name]);
    if (effector) {
      dyn[name] = effector;
      any = true;
    }
  }
  return any ? dyn : null;
}

/**
 * The picture of the paper of a brush.
 *
 * A brush that is drawn on paper keeps a grain: a picture whose alpha is the
 * pattern, with the strength, the size and the turn of the grain beside it.
 * The picture is small (the reader keeps it under a couple of hundred pixels
 * a side), because it is saved with every stroke that is drawn on it.
 */
export function normalizeGrain(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.data !== "string" || value.data.length === 0) return null;
  return {
    data: value.data,
    width: clamp(number(value.width, 0), 1, 4096),
    height: clamp(number(value.height, 0), 1, 4096),
    density: clamp(number(value.density, 100), 0, 100),
    scale: clamp(number(value.scale, 100), 5, 1000),
    rotate: number(value.rotate, 0),
    reverse: value.reverse === true,
  };
}

/**
 * The settings that shape the paint of a brush, ready for a painter.
 *
 * Everything is worked out once per stroke: a painter that walked a long
 * drawing would otherwise read the same numbers for every dab.
 */
export function dynamicsOf(brush) {
  const dyn = brush?.dyn ?? {};
  const style = {
    flow: clamp(number(brush?.flow, 100), 0, 100) / 100,
    hardness: clamp(number(brush?.hardness, 100), 0, 100) / 100,
    thickness: clamp(number(brush?.thickness, 100), 1, 500) / 100,
    spacing: clamp(number(brush?.spacing, 25), 1, 200) / 100,
    rotation: (number(brush?.rotation, 0) * Math.PI) / 180,
    followsDirection:
      brush?.rotationFollow === true || brush?.rotationFollow === "dir",
    jitter: (clamp(number(brush?.rotationJitter, 0), 0, 180) * Math.PI) / 180,
    binarize: brush?.binarize === true,
    grain: normalizeGrain(brush?.grain),
    effectors: {
      size: compactEffector(dyn.size),
      opacity: compactEffector(dyn.opacity),
      flow: compactEffector(dyn.flow),
      interval: compactEffector(dyn.interval),
      thickness: compactEffector(dyn.thickness),
      rotation: compactEffector(dyn.rotation),
      paper: compactEffector(dyn.paper),
    },
    // A brush that leaves all of its paint with every dab does not have to
    // build the paint up, so a pixel keeps the strongest dab that touched it.
    accumulates: false,
  };

  style.accumulates =
    style.flow < 1 ||
    Boolean(style.effectors.flow) ||
    Boolean(style.effectors.opacity);

  // A brush that is a plain hard round tip at flow 100 is drawn as one shape:
  // that is quicker and has one clean edge, and it is how every stroke was
  // drawn before a brush carried these settings.
  style.needsDabs =
    style.accumulates ||
    style.hardness < 1 ||
    style.thickness !== 1 ||
    style.binarize ||
    Boolean(style.grain) ||
    style.jitter > 0 ||
    style.rotation !== 0 ||
    style.followsDirection ||
    style.spacing !== 0.25 ||
    Boolean(style.effectors.size) ||
    Boolean(style.effectors.thickness) ||
    Boolean(style.effectors.rotation);

  if (style.effectors.paper) style.needsDabs = true;
  return style;
}

/**
 * A steady number for a dab.
 *
 * The random settings of a brush (the shake of its size, its flow, its angle)
 * must give the same answer every time a stroke is drawn, or the line on the
 * stage and the line in the exported file would differ. The number is worked
 * out from the place of the dab in the stroke, so it is the same on both.
 */
function shake(a, b = 0) {
  const value = Math.sin((a + 1) * 127.1 + (b + 1) * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/** A random share between what a setting leaves at least and the whole. */
function randomShare(effector, index) {
  const span = effectorRandomSpan(effector);
  if (!span) return 1;
  return span[0] + (span[1] - span[0]) * shake(index, 3);
}

/** The pressure at a point of a stroke, from 0 to 1. */
function pressureOf(point) {
  return Array.isArray(point) && point.length > 2 ? clamp(number(point[2], 1), 0, 1) : 1;
}

/**
 * How wide the tip is at a point of the stroke, as a share of the brush width.
 *
 * A brush with no size effector keeps the fall-back of this program, which is
 * what every stroke was drawn with before: a light touch leaves a fifth of the
 * width. A brush that says how its size follows the hand uses its own curve.
 */
function sizeShare(style, pressure) {
  const effector = style.effectors.size;
  if (!effector) {
    return MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * pressure;
  }
  let share = effectorValue(effector, pressure);
  if (effector.random) share *= randomShare(effector, 0);
  return clamp(share, 0, 1);
}

/** How flat the tip is at a point of the stroke. */
function thicknessShare(style, pressure, index) {
  const effector = style.effectors.thickness;
  let share = style.thickness;
  if (effector) share *= effectorValue(effector, pressure);
  if (effector?.random) share *= randomShare(effector, index);
  return clamp(share, 0.01, 5);
}

/** How much paint one dab leaves, from 0 to 1. */
function flowShare(style, pressure, index) {
  let share = style.flow;
  if (style.effectors.flow) {
    share *= effectorValue(style.effectors.flow, pressure);
    if (style.effectors.flow.random) share *= randomShare(style.effectors.flow, index);
  }
  if (style.effectors.opacity) {
    share *= effectorValue(style.effectors.opacity, pressure);
    if (style.effectors.opacity.random) share *= randomShare(style.effectors.opacity, index);
  }
  return clamp(share, 0, 1);
}

/** How far apart the dabs are at a point of the stroke, as a share of width. */
function spacingShare(style, pressure) {
  let share = style.spacing;
  const effector = style.effectors.interval;
  if (effector) {
    // A bigger setting is a wider gap; the curve says how much of it is kept.
    share /= Math.max(0.01, effectorValue(effector, pressure));
  }
  return clamp(share, 0.01, 2);
}

/** The turn of the tip, in radians, at a point of the stroke. */
function angleOf(style, direction, pressure, index) {
  let angle = style.rotation;
  if (style.followsDirection) angle += direction;
  const effector = style.effectors.rotation;
  if (effector) angle += (effectorValue(effector, pressure) - 0.5) * Math.PI;
  if (style.jitter > 0) angle += (shake(index, 11) * 2 - 1) * style.jitter;
  return angle;
}

/**
 * The lines a stroke is made of.
 *
 * A freehand stroke is the lines between its points; a line, a rectangle and
 * an ellipse are the same drawing with their points already worked out, so
 * every kind of stroke is painted by one painter.
 */
function segmentsOf(stroke, ellipsePoints) {
  const points = stroke.points ?? [];
  if (!points.length) return [];
  if (stroke.kind === "line") return [[points[0], points[1] ?? points[0]]];
  if (stroke.kind === "rect") {
    const [x0, y0] = points[0];
    const [x1, y1] = points[1] ?? points[0];
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    return corners.map((corner, index) => [corner, corners[(index + 1) % 4]]);
  }
  if (stroke.kind === "ellipse") {
    const outline = ellipsePoints;
    if (!outline || outline.length < 2) return [];
    return outline.map((point, index) => [point, outline[(index + 1) % outline.length]]);
  }
  const out = [];
  for (let index = 1; index < points.length; index += 1) {
    out.push([points[index - 1], points[index]]);
  }
  return out;
}

/**
 * The dabs of a stroke: where the tip goes, how big it is, how flat it is and
 * how much paint it leaves.
 *
 * The dabs sit a little apart along the path, and how far apart they sit is
 * the spacing of the brush. A brush that says nothing gets a dab every quarter
 * of its width, which is what this program has always drawn.
 *
 * Every dab is `{ x, y, r, flat, angle, flow }`: the place of its middle, its
 * radius, how flat it is (1 is round), the turn of its tip and the share of
 * the paint it leaves.
 */
export function strokeDabs(stroke, style, ellipsePoints = null) {
  const base = Math.max(0.5, number(stroke.width, 1) / 2);
  const segments = segmentsOf(stroke, ellipsePoints);
  const dabs = [];

  if (segments.length === 0) {
    const point = stroke.points?.[0];
    if (!point) return dabs;
    const pressure = pressureOf(point);
    dabs.push({
      x: point[0],
      y: point[1],
      r: Math.max(0.5, base * sizeShare(style, pressure)),
      flat: thicknessShare(style, pressure, 0),
      angle: angleOf(style, 0, pressure, 0),
      flow: flowShare(style, pressure, 0),
    });
    return dabs;
  }

  let index = 0;
  for (const [from, to] of segments) {
    const x0 = from[0];
    const y0 = from[1];
    const x1 = to[0];
    const y1 = to[1];
    const p0 = pressureOf(from);
    const p1 = pressureOf(to);
    const r0 = Math.max(0.5, base * sizeShare(style, p0));
    const r1 = Math.max(0.5, base * sizeShare(style, p1));
    const length = Math.hypot(x1 - x0, y1 - y0);
    const direction = Math.atan2(y1 - y0, x1 - x0);

    // The gap is measured on the narrower end of the line, so a stroke that
    // thins out does not suddenly leave gaps between its dabs.
    const spacing = spacingShare(style, Math.min(p0, p1));
    const step = Math.max(0.5, Math.min(r0, r1) * 2 * spacing);
    const steps = Math.max(1, Math.ceil(length / step));

    // The first dab of a segment is skipped when it is the last dab of the
    // one before it, so the joints of a long stroke are not painted twice.
    const start = dabs.length ? 1 : 0;
    for (let part = start; part <= steps; part += 1) {
      const at = part / steps;
      const pressure = p0 + (p1 - p0) * at;
      dabs.push({
        x: x0 + (x1 - x0) * at,
        y: y0 + (y1 - y0) * at,
        r: r0 + (r1 - r0) * at,
        flat: thicknessShare(style, pressure, index),
        angle: angleOf(style, direction, pressure, index),
        flow: flowShare(style, pressure, index),
      });
      index += 1;
    }
  }
  return dabs;
}

/** The share of a setting a curve leaves at `x`, for the panel and the tests. */
export function shareAt(curve, x) {
  return curveValue(curve, x);
}
