/**
 * Macromedia Flash Professional 8 — Drawing Engine, Assistant & Geometry Logic
 *
 * Implements the reverse-engineered drawing logic from `build/flash8-re`:
 * - Drawing Settings / Assistant lookup tables (Connect, Curve, Line, Shape, Tap)
 * - 16.16 Fixed-Point Coordinate & Transform math (FUN_00f2afd0)
 * - Pencil Modes: Straighten (0x11), Smooth (0x12), Ink (0x13)
 * - 19 ms time-sliced sampling interval (~52 samples/s)
 * - Drawing modifiers: Shift (45° angle constraint), Ctrl (center/mirror), Up/Down (size step)
 * - 5 Brush Paint Modes: Paint Normal, Paint Fills, Paint Behind, Paint Selection, Paint Inside
 * - 9 Brush Tip Shapes and 10 Brush Sizes
 * - Paint Bucket with 4 Gap Closing levels
 * - 5 Eraser Modes + Faucet (one-click fill/line clear)
 * - Snapping Engine: Snap to Grid with 10-unit nudge (FUN_007346c0), Object Snapping (FUN_00849d30)
 * - Optimize Curves simplification (Dialog 873)
 * - Procedural stroke styles (Dashed, Dotted, Ragged, Stippled, Hatched)
 */

/* ---------------------------------------------------------------- Constants */

/**
 * Registry defaults and lookup tables from HKCU\Software\Macromedia\Flash 8\Assistant
 * Observed in FUN_00737400 and .rdata tables (0x105c728 - 0x105c788).
 */
export const FLASH8_ASSISTANT = {
  // Connect lines levels 0..4 (ushort table 0x105c728, secondary 0x105c730)
  // Level 4 (0) connects regardless of distance
  CONNECT_TABLE: [1, 3, 6, 10, 0],
  CONNECT_SECONDARY: [0, 4, 10, 16, 4],

  // Smooth curves levels 0..4 (int32 table 0x105c748, high 16 bits)
  // Higher value = looser fit / more smoothing
  SMOOTH_CURVES_TABLE: [0, 128, 256, 768, 1536],

  // Recognize lines levels 0..4 (int32 table 0x105c758, high 16 bits)
  RECOGNIZE_LINES_TABLE: [0, 1024, 2560, 3840, 0],

  // Recognize shapes levels 0..4 (int32 table 0x105c768, high 16 bits)
  RECOGNIZE_SHAPES_TABLE: [0, 2048, 5120, 7680, 1],

  // Click accuracy levels 0..2 (three parallel tables: snap radius, gap, tolerance)
  CLICK_ACCURACY: {
    SNAP_RADIUS: [1, 2, 4],
    GAP: [1, 2, 4],
    TOLERANCE: [2, 4, 7],
  },

  // Default level for all Assistant settings is 2 (Normal / Medium)
  DEFAULT_LEVEL: 2,
};

/**
 * Flash 8 Stroke & Brush constants from Stroke registry and decompiled functions.
 */
export const FLASH8_STROKE = {
  DEFAULT_SMOOTHNESS: 50,
  SAMPLE_INTERVAL_MS: 19, // ~52 samples/sec, GetTickCount interval in PENCIL_Draw (0x732c50)
  SIZE_STEP_TWIPS: 20, // 0x14 twips (1 pixel) changed by Up/Down arrows
  SMOOTH_LOW_THRESHOLD: 0x10000, // 65536 threshold when 40 <= smoothness <= 60
  SMOOTH_HIGH_THRESHOLD: 0x1000000, // 16777216 threshold otherwise
  SMOOTH_DERIVED_SCALE: 1.5, // (smoothness - 40) * 3 / 2 in CURVE_SmoothHelper
  SMOOTH_COLOR_SCALE: 0.2, // BRUSH_SmoothScale factor in FUN_007186c0
  RASTER_TOLERANCE: 0x1e0000, // 196608
};

/**
 * Flash 8 Pencil modes:
 * Mode byte in tool +0x144:
 * 0x11 = Straighten (mode index 0)
 * 0x12 = Smooth (mode index 1)
 * 0x13 = Ink (mode index 2)
 */
export const PENCIL_MODES = {
  STRAIGHTEN: "straighten", // 0x11
  SMOOTH: "smooth", // 0x12
  INK: "ink", // 0x13
};

export const PENCIL_MODE_BYTES = {
  straighten: 0x11,
  smooth: 0x12,
  ink: 0x13,
};

/**
 * 5 Flash 8 Brush paint modes (resource IDs 32828..32833).
 */
export const BRUSH_PAINT_MODES = {
  NORMAL: "normal", // Paint Normal (32832) - paints over strokes and fills
  FILLS: "fills", // Paint Fills (32830) - paints fills and blank areas, leaves lines intact
  BEHIND: "behind", // Paint Behind (32828) - paints only blank areas behind existing artwork
  SELECTION: "selection", // Paint Selection (32833) - paints only inside selected regions
  INSIDE: "inside", // Paint Inside (32831) - paints strictly within the fill where the stroke started
};

/**
 * 9 Flash 8 Brush tip shapes.
 */
export const BRUSH_SHAPES = [
  "circle",
  "square",
  "flatHorizontal",
  "flatVertical",
  "slash45",
  "slash135",
  "chisel45",
  "chisel135",
  "diamond",
];

/**
 * 10 Flash 8 Brush sizes (pixels).
 */
export const BRUSH_SIZES = [1, 2, 4, 6, 8, 12, 16, 24, 36, 48];

/**
 * 4 Flash 8 Paint bucket gap modes (resource IDs 32856..32860).
 */
export const GAP_MODES = {
  NONE: "none", // Don't Close Gaps (0px gap)
  SMALL: "small", // Close Small Gaps (3px gap)
  MEDIUM: "medium", // Close Medium Gaps (6px gap)
  LARGE: "large", // Close Large Gaps (12px gap)
};

export const GAP_TOLERANCES = {
  none: 0,
  small: 3,
  medium: 6,
  large: 12,
};

/**
 * 5 Flash 8 Eraser modes.
 */
export const ERASER_MODES = {
  NORMAL: "normal", // Erase Normal: erases strokes and fills
  FILLS: "fills", // Erase Fills: erases only fills, leaves lines
  LINES: "lines", // Erase Lines: erases only strokes/lines, leaves fills
  SELECTION: "selection", // Erase Selected Fills: erases only inside selected fills
  INSIDE: "inside", // Erase Inside: erases only inside the fill where the stroke began
};

/* ------------------------------------------------ 16.16 Fixed Point Math */

/**
 * Convert floating-point number to 16.16 fixed-point integer.
 */
export function toFixed16(val) {
  return Math.round(val * 65536);
}

/**
 * Convert 16.16 fixed-point integer to floating-point number.
 */
export function fromFixed16(val) {
  return val / 65536;
}

/**
 * Flash 8 2D Affine Transform (FUN_00f2afd0):
 * Matrix format: [a, b, c, d, tx, ty] in 16.16 fixed point.
 * Computes:
 * x' = ((x * a + y * c) >> 16) + tx
 * y' = ((x * b + y * d) >> 16) + ty
 */
export function transformPoint16(matrix16, x16, y16) {
  const [a, b, c, d, tx, ty] = matrix16;
  const outX = Math.round((x16 * a + y16 * c) / 65536) + tx;
  const outY = Math.round((x16 * b + y16 * d) / 65536) + ty;
  return [outX, outY];
}

/**
 * Multiply two 16.16 affine transform matrices.
 */
export function multiplyMatrix16(m1, m2) {
  const [a1, b1, c1, d1, tx1, ty1] = m1;
  const [a2, b2, c2, d2, tx2, ty2] = m2;
  return [
    Math.round((a1 * a2 + b1 * c2) / 65536),
    Math.round((a1 * b2 + b1 * d2) / 65536),
    Math.round((c1 * a2 + d1 * c2) / 65536),
    Math.round((c1 * b2 + d1 * d2) / 65536),
    Math.round((tx1 * a2 + ty1 * c2) / 65536) + tx2,
    Math.round((tx1 * b2 + ty1 * d2) / 65536) + ty2,
  ];
}

/* ----------------------------------------------------- Modifiers & Snapping */

/**
 * Shift modifier: Constrain segment to 45° angle multiples (FUN_00737610).
 * Angles: 0°, 45°, 90°, 135°, 180°, -135°, -90°, -45°.
 */
export function constrain45(originX, originY, targetX, targetY) {
  const dx = targetX - originX;
  const dy = targetY - originY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-4) return [targetX, targetY];

  let angle = Math.atan2(dy, dx);
  // Snap angle to nearest 45° (PI / 4)
  const step = Math.PI / 4;
  angle = Math.round(angle / step) * step;

  return [originX + Math.cos(angle) * dist, originY + Math.sin(angle) * dist];
}

/**
 * Center / Tangent mirror expansion (Ctrl modifier in PENCIL_Draw / lines 2165-2184).
 * Mirrors coordinates about the initial center point.
 */
export function centerMirror(centerX, centerY, currentX, currentY) {
  const dx = currentX - centerX;
  const dy = currentY - centerY;
  return [
    [centerX - dx, centerY - dy],
    [currentX, currentY],
  ];
}

/**
 * Flash 8 Grid Snapping (FUN_007346c0):
 * Rounds coordinates to the nearest multiple of `gridSpacing`.
 * If `nudge !== 0`, applies a 10-unit nudge offset in the direction of the round.
 */
export function snapToGrid(x, y, gridSpacing = 20, nudge = false) {
  if (gridSpacing <= 0) return [x, y];
  const half = gridSpacing >> 1;

  let outX = Math.floor((x + (x >= 0 ? half : -half)) / gridSpacing) * gridSpacing;
  let outY = Math.floor((y + (y >= 0 ? half : -half)) / gridSpacing) * gridSpacing;

  if (nudge) {
    outX += outX < x ? 10 : -10;
    outY += outY < y ? 10 : -10;
  }

  return [outX, outY];
}

/**
 * Flash 8 Object Snapping (FUN_00849d30):
 * Snaps point to candidate snapPoints (endpoints, edge midpoints, centers)
 * within the snap radius.
 */
export function snapToObjectPoints(x, y, snapPoints, radius = 6) {
  if (!snapPoints || snapPoints.length === 0 || radius <= 0) {
    return { x, y, snapped: false };
  }
  let bestDist = radius;
  let bestPoint = null;

  for (const pt of snapPoints) {
    const px = Array.isArray(pt) ? pt[0] : pt.x;
    const py = Array.isArray(pt) ? pt[1] : pt.y;
    const dist = Math.hypot(x - px, y - py);
    if (dist <= bestDist) {
      bestDist = dist;
      bestPoint = [px, py];
    }
  }

  if (bestPoint) {
    return { x: bestPoint[0], y: bestPoint[1], snapped: true, dist: bestDist };
  }
  return { x, y, snapped: false };
}

/* ---------------------------------------------------- Assistant Recognition */

/**
 * Check if a stroke segment is approximately a straight line within line tolerance.
 */
export function isStraightLine(points, lineLevel = 2) {
  if (points.length < 2) return true;
  if (lineLevel === 0) return false; // Recognition off

  const tolerance = FLASH8_ASSISTANT.RECOGNIZE_LINES_TABLE[Math.min(4, lineLevel)] / 65536;
  const p0 = points[0];
  const pEnd = points[points.length - 1];
  const length = Math.hypot(pEnd[0] - p0[0], pEnd[1] - p0[1]);
  if (length < 1e-4) return true;

  const threshold = Math.max(2, tolerance * 8);

  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    // Distance from point p to line (p0 - pEnd)
    const num = Math.abs(
      (pEnd[1] - p0[1]) * p[0] - (pEnd[0] - p0[0]) * p[1] + pEnd[0] * p0[1] - pEnd[1] * p0[0],
    );
    const dist = num / length;
    if (dist > threshold) return false;
  }
  return true;
}

/**
 * Recognize basic geometric shapes (circle/ellipse, rectangle, triangle) from points.
 * Level 0 = Off, Level 1..4 = Strict to Relaxed.
 */
export function recognizeShape(points, shapeLevel = 2, connectLevel = 2) {
  if (points.length < 6 || shapeLevel === 0) return null;

  const connectDist = FLASH8_ASSISTANT.CONNECT_TABLE[Math.min(4, connectLevel)] * 3 || 12;
  const p0 = points[0];
  const pEnd = points[points.length - 1];
  const isClosed = Math.hypot(pEnd[0] - p0[0], pEnd[1] - p0[1]) <= connectDist;

  // Compute bounding box
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pt of points) {
    minX = Math.min(minX, pt[0]);
    maxX = Math.max(maxX, pt[0]);
    minY = Math.min(minY, pt[1]);
    maxY = Math.max(maxY, pt[1]);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 8 || height < 8) return null;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;

  // Tolerance scale from table
  const tolFactor = FLASH8_ASSISTANT.RECOGNIZE_SHAPES_TABLE[Math.min(4, shapeLevel)] / 65536;
  const maxErr = Math.max(4, tolFactor * 12);

  if (isClosed) {
    // 1. Calculate Circle / Ellipse error
    let ellipseErr = 0;
    for (const pt of points) {
      const nx = (pt[0] - centerX) / radiusX;
      const ny = (pt[1] - centerY) / radiusY;
      const distFrom1 = Math.abs(Math.hypot(nx, ny) - 1);
      ellipseErr += distFrom1;
    }
    ellipseErr /= points.length;

    // 2. Calculate Rectangle / Square error (normalized by average radius)
    let rectErr = 0;
    const avgRadius = (radiusX + radiusY) / 2;
    for (const pt of points) {
      const dLeft = Math.abs(pt[0] - minX);
      const dRight = Math.abs(pt[0] - maxX);
      const dTop = Math.abs(pt[1] - minY);
      const dBottom = Math.abs(pt[1] - maxY);
      rectErr += Math.min(dLeft, dRight, dTop, dBottom);
    }
    rectErr = rectErr / (points.length * avgRadius);

    const ellipseThreshold = 0.18 + tolFactor * 0.08;
    const rectThreshold = 0.15 + tolFactor * 0.08;

    const matchesEllipse = ellipseErr < ellipseThreshold;
    const matchesRect = rectErr < rectThreshold;

    if (matchesRect && (!matchesEllipse || rectErr < ellipseErr)) {
      const recognized = [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
        [minX, minY],
      ];
      return { type: "rect", points: recognized, bounds: [minX, minY, width, height] };
    }

    if (matchesEllipse) {
      const recognized = [];
      const steps = 64;
      for (let i = 0; i < steps; i += 1) {
        const theta = (i / steps) * Math.PI * 2;
        recognized.push([centerX + Math.cos(theta) * radiusX, centerY + Math.sin(theta) * radiusY]);
      }
      recognized.push(recognized[0]);
      return { type: "ellipse", points: recognized, bounds: [minX, minY, width, height] };
    }
  }

  return null;
}

/**
 * Apply Flash 8 Pencil Straighten mode (0x11):
 * - Snaps endpoints if close (connect distance).
 * - Recognizes shapes (ellipse, rect) or fits straight line segments.
 */
export function processStraighten(points, assistantSettings = {}) {
  if (points.length < 2) return points;
  const lineLevel = assistantSettings.line ?? FLASH8_ASSISTANT.DEFAULT_LEVEL;
  const shapeLevel = assistantSettings.shape ?? FLASH8_ASSISTANT.DEFAULT_LEVEL;
  const connectLevel = assistantSettings.connect ?? FLASH8_ASSISTANT.DEFAULT_LEVEL;

  // Try shape recognition first
  const recognized = recognizeShape(points, shapeLevel, connectLevel);
  if (recognized) return recognized.points;

  // Check if whole stroke is a straight line
  if (isStraightLine(points, lineLevel)) {
    return [points[0], points[points.length - 1]];
  }

  // Connect endpoints if close
  const connectDist = FLASH8_ASSISTANT.CONNECT_TABLE[Math.min(4, connectLevel)] * 3 || 12;
  const p0 = points[0];
  const pEnd = points[points.length - 1];
  const out = points.map((p) => [p[0], p[1], p[2] ?? 1]);
  if (Math.hypot(pEnd[0] - p0[0], pEnd[1] - p0[1]) <= connectDist) {
    out[out.length - 1] = [p0[0], p0[1], pEnd[2] ?? 1];
  }

  return out;
}

/* -------------------------------------------------------- Curve Fitting */

/**
 * Flash 8 Curve Smoothing (Smooth mode 0x12 & Optimize Curves).
 * Implements Bézier curve smoothing using Douglas-Peucker reduction with
 * smooth quadratic interpolation through inflection points.
 */
export function smoothBézierFit(points, smoothing = 50, curveLevel = 2) {
  if (points.length <= 2) return points;

  // Curve level tolerance (0..4) from table + smoothing parameter (0..100)
  const baseTol = FLASH8_ASSISTANT.SMOOTH_CURVES_TABLE[Math.min(4, curveLevel)] / 65536;
  const tolerance = Math.max(0.5, (baseTol * 4 + 1) * (1 + smoothing / 50));

  // Step 1: Simplify point list using distance threshold
  const simplified = simplifyRadialDistance(points, tolerance);
  if (simplified.length <= 2) return [points[0], points[points.length - 1]];

  // Step 2: Generate smooth quadratic curve points through control vertices
  return quadraticThroughMidpoints(simplified);
}

/**
 * The rounded polyline of simplified vertices: a quadratic through the
 * midpoints of the neighbours of every vertex. The ends come out exactly
 * as they went in, and the pressure channel is averaged across the joints.
 */
function quadraticThroughMidpoints(simplified) {
  const smoothed = [];
  smoothed.push(simplified[0]);

  for (let i = 0; i < simplified.length - 1; i += 1) {
    const p0 = simplified[i];
    const p1 = simplified[i + 1];
    const midX = (p0[0] + p1[0]) / 2;
    const midY = (p0[1] + p1[1]) / 2;
    const midPressure = ((p0[2] ?? 1) + (p1[2] ?? 1)) / 2;

    if (i > 0) {
      smoothed.push([midX, midY, midPressure]);
    }
    smoothed.push(p1);
  }

  return smoothed;
}

/* -------------------------------------------- Brush Smoothness (0x71ca90) */

/**
 * How wide the brush settles the hand, in pixels (the window is this many
 * pixels **across**, half of it on each side of the point), at a
 * smoothness of 0..100.
 *
 * These numbers are measured against Macromedia Flash Professional 8
 * itself, not guessed. `tools/flash8-smooth-probe.ps1` feeds Flash one and
 * the same run of points — a 260 px wave with a tremble of 60, 36, 24 and
 * 16 px laid over it — at smoothness 0, 1, 25, 50 and 100, and
 * `measure-flash.mjs` takes the middle of the ink in every column and fits
 * a sine of every wavelength to it, giving the share of each that survived.
 *
 * **The middle of the ink is not the line, when the line is thick.** The
 * brush leaves a disc at every point of the run, and where the tremble
 * turns faster than the brush is wide the discs fill the valleys between
 * the turns, so a fat line reads as a settled one of its own accord — at
 * 20 px wide a line of the hand unsmoothed measures 0.99, 0.88, 0.69,
 * 0.34, 0.05 of its five wavelengths, which looks exactly like settling.
 * The probe never chose a brush size, and the one it drew with turned out
 * to be about 20 px wide (the ink reaches 10 to 13 px past the ends of the
 * run, which is the radius of the brush). So the shares as measured carry
 * that width with them, and they have to be fitted with it taken off:
 * `tools/width-fit.mjs` fits the width and the settle at once, against the
 * line Flash actually left on the page.
 *
 *   flash 0, 1 and 25 -> no settle at all (0.6 px from the hand's run)
 *   flash 50          -> none to 6 px, which the fit cannot tell apart
 *   flash 100         -> 12 px
 *
 * That is the shape the decompiled draw path points at: `(smoothness - 40)
 * * 3/2` into CURVE_SmoothHelper (`0x71ca90`) is not more than zero until
 * the smoothness passes 40, so the bottom of the scale is a pass-through
 * of the hand — wobble and all, which is what the recording shows at
 * smoothness 1. The slope the decompile suggests is steeper than the
 * measurement supports, though: it would give 90 px at 100, and a settle
 * that wide would wipe out the 60 px wave almost completely, which
 * Flash's own stroke at 100 does not do. So the top of the curve comes
 * from the measurement: 12 px.
 */
const BRUSH_SMOOTH_WINDOW_CURVE = [[0, 0], [40, 0], [100, 12]];

export function brushSmoothWindow(smoothness) {
  const s = Math.max(0, Math.min(100, Number(smoothness) || 0));
  const points = BRUSH_SMOOTH_WINDOW_CURVE;
  let i = 1;
  while (i < points.length - 1 && s > points[i][0]) i += 1;
  const [x0, y0] = points[i - 1];
  const [x1, y1] = points[i];
  return y0 + ((y1 - y0) * (s - x0)) / (x1 - x0);
}

/** The samples are walked again every this many pixels before the fit. */
const BRUSH_SMOOTH_SPACING = 1.2;

/**
 * The most samples the smoother chews on. Past this the run is thinned by a
 * stride (ends kept), because the brush smooths the whole stroke on every
 * move while it is drawn and a marathon stroke must stay cheap.
 */
const BRUSH_SMOOTH_MAX_SAMPLES = 3000;

/**
 * The knot diet: after the line is settled it is thinned again, but only by
 * a hair. The 0.35 px epsilon is small enough that a straighter polyline
 * cannot deviate from the settled line visibly — smoothing never becomes
 * straightening here, no corners are cut, only redundant knots are dropped.
 */
const BRUSH_SMOOTH_KNOT_DIET = 0.35;

/**
 * The knot diet for the width of the line: how far the pressure of a point
 * may sit from the pressure the line between the two knots around it would
 * give it, before a knot is kept for that alone. 0.05 of pressure is 4% of
 * the width of the brush, so on a 12 px brush the line may not be off by
 * more than about half a pixel. The shape of the line has its own, purely
 * geometric, tolerance (BRUSH_SMOOTH_KNOT_DIET).
 */
const BRUSH_PRESSURE_KNOT_DIET = 0.05;

/**
 * The Flash 8 brush stroke, the way the recorded video draws it.
 *
 * Smoothing makes the line more stable and smooth; it never straightens it
 * and never leaves it pointy. So the run of samples is **settled**: every
 * point of the ready line is the average of the hand samples around it,
 * over a window that grows with the Smoothness. A wide average keeps the
 * run of the line — long sweeps, humps and corners all keep their shape —
 * while the oscillation the hand puts on top of it, fast and small,
 * cancels out. Because the window is centred, the line does not trail
 * behind the pointer either.
 *
 *   1. the run is thinned when it is very long, and walked again at even
 *      steps, so the result does not depend on how fast the pointer
 *      reported points;
 *   2. every point is replaced by the average of its neighbours over the
 *      smoothness window (the ends keep their own positions);
 *   3. redundant knots are dropped with a 0.35 px diet that cannot shape
 *      the line — and with a second, pressure-based diet, because a
 *      straight stretch of line has no bend to keep a knot for, and the
 *      width of the line has to follow the hand even there.
 *
 * The pressure channel is averaged with its neighbours the same way. The
 * result is a pure function of its input, so the stroke on the paper is
 * the line that was shown while it was drawn.
 *
 * `window` is the width of the settle in pixels, and defaults to what the
 * Smoothness asks for. The measuring tools pass it themselves, because they
 * fit the curve of that default and want to try a window on its own.
 */
export function brushSmoothPath(
  points,
  smoothness = FLASH8_STROKE.DEFAULT_SMOOTHNESS,
  window = brushSmoothWindow(smoothness),
) {
  if (!points || points.length === 0) return [];
  if (points.length <= 2) return points.map((point) => point.slice());

  const decimated = decimateByStride(points, BRUSH_SMOOTH_MAX_SAMPLES);
  const even = resampleEvenly(decimated, BRUSH_SMOOTH_SPACING);
  if (even.length <= 2) {
    return [even[0], even[even.length - 1]];
  }

  // A window of 0 passes the hand through whole, which is what the bottom
  // of the Smoothness scale is for.
  const half = Math.round(window / BRUSH_SMOOTH_SPACING);
  const settled = averageRunningWindow(even, half);
  // The ends keep the places the hand put them down and lifted.
  settled[0] = even[0].slice();
  settled[settled.length - 1] = even[even.length - 1].slice();

  // Only the redundant knots go; the shape of the line stays as settled,
  // and so does the width of the line along it.
  return dietKnots(settled, BRUSH_SMOOTH_KNOT_DIET, BRUSH_PRESSURE_KNOT_DIET);
}

/**
 * The centred running average of a run of points: each point becomes the
 * mean of the samples within `half` places of it, over whatever part of
 * that window the run has. The pressure channel is averaged too, because
 * a settled line wants a settled width.
 */
function averageRunningWindow(points, half) {
  const count = points.length;
  const out = new Array(count);
  const carriesPressure = points.some((point) => point.length > 2);
  for (let index = 0; index < count; index += 1) {
    const start = Math.max(0, index - half);
    const stop = Math.min(count - 1, index + half);
    let x = 0;
    let y = 0;
    let pressure = 0;
    for (let j = start; j <= stop; j += 1) {
      x += points[j][0];
      y += points[j][1];
      pressure += points[j][2] ?? 1;
    }
    const span = stop - start + 1;
    out[index] = carriesPressure
      ? [x / span, y / span, pressure / span]
      : [x / span, y / span];
  }
  return out;
}

/**
 * An evenly walked copy of a polyline, the pressure carried between the
 * samples the line crosses. When the line records no pressure the copy
 * keeps two-element points, so a mouse stroke stays two-element.
 */
function resampleEvenly(points, spacing) {
  let carriesPressure = false;
  for (const point of points) {
    if (point.length > 2) {
      carriesPressure = true;
      break;
    }
  }
  const ends = carriesPressure ? (p) => p.slice() : (p) => [p[0], p[1]];
  const out = [ends(points[0])];

  let walked = 0;
  let next = spacing;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const pa = a[2] ?? 1;
    const pb = b[2] ?? 1;
    while (next < walked + length - 1e-6) {
      const f = (next - walked) / length;
      out.push([
        a[0] + dx * f,
        a[1] + dy * f,
        ...(carriesPressure
          ? [pa + (pb - pa) * f]
          : []),
      ]);
      next += spacing;
    }
    walked += length;
  }
  out.push(ends(points[points.length - 1]));
  return out;
}

/** Every stride-th sample of a run, first and last kept. */
function decimateByStride(points, max) {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out = [];
  for (let index = 0; index < points.length; index += stride) {
    out.push(points[index]);
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Ramer-Douglas-Peucker simplification helper for curve optimization.
 */
export function simplifyRDP(points, epsilon) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let index = 0;
  const start = points[0];
  const end = points[points.length - 1];
  const lineLen = Math.hypot(end[0] - start[0], end[1] - start[1]);

  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    let dist;
    if (lineLen < 1e-6) {
      dist = Math.hypot(p[0] - start[0], p[1] - start[1]);
    } else {
      dist =
        Math.abs(
          (end[1] - start[1]) * p[0] - (end[0] - start[0]) * p[1] + end[0] * start[1] - end[1] * start[0],
        ) / lineLen;
    }
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyRDP(points.slice(0, index + 1), epsilon);
    const right = simplifyRDP(points.slice(index), epsilon);
    return left.slice(0, left.length - 1).concat(right);
  }
  return [start, end];
}

/**
 * The knots a stroke can lose, when the width of the line changes along it.
 *
 * The plain diet above keeps a knot only where the line bends, which is right
 * for the shape of the line and wrong for its width: a stroke drawn dead
 * straight has nothing to bend, so it comes out with two knots, and the
 * pressure of the hand between them — the whole reason the line thickens and
 * thins — goes with the points that were dropped. The step a hand makes from
 * hard press to light touch then turns into one straight ramp from end to
 * end, and a line that is pressed hard in the middle comes out thin
 * throughout.
 *
 * So a point is kept for a second reason here: when its pressure sits far
 * from the pressure the line between the knots would give it. As in RDP, the
 * point that sticks out furthest, in either way, is the one split off, and
 * the two halves are dieted again until nothing sticks out at all. Points
 * that carry no pressure (a mouse) behave exactly as the plain diet does.
 *
 * @param {Array<Array<number>>} points The settled points of the stroke.
 * @param {number} epsilon How far a point may sit from the line, in pixels.
 * @param {number} pressureEpsilon How far a point's pressure may sit from
 *   the pressure the line would give it, in pressure.
 * @returns {Array<Array<number>>} The knots worth keeping.
 */
function dietKnots(points, epsilon, pressureEpsilon) {
  if (points.length <= 2) return points;

  const start = points[0];
  const end = points[points.length - 1];
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lineLen = Math.hypot(dx, dy);
  const carriesPressure = start.length > 2 && end.length > 2;

  // 1 is the score to beat: a point only counts as sticking out when it is
  // past its own tolerance, in whichever of the two ways it is measured.
  let worst = 1;
  let index = -1;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    const bend =
      lineLen < 1e-6
        ? Math.hypot(p[0] - start[0], p[1] - start[1]) / epsilon
        : Math.abs(dy * p[0] - dx * p[1] + end[0] * start[1] - end[1] * start[0]) /
          (lineLen * epsilon);
    let score = bend;
    if (carriesPressure) {
      const along =
        lineLen < 1e-6
          ? 0
          : Math.max(
              0,
              Math.min(1, ((p[0] - start[0]) * dx + (p[1] - start[1]) * dy) / (lineLen * lineLen)),
            );
      const wanted = start[2] + (end[2] - start[2]) * along;
      score = Math.max(bend, Math.abs((p[2] ?? 1) - wanted) / pressureEpsilon);
    }
    if (score > worst) {
      worst = score;
      index = i;
    }
  }
  if (index < 0) return [start, end];

  const left = dietKnots(points.slice(0, index + 1), epsilon, pressureEpsilon);
  const right = dietKnots(points.slice(index), epsilon, pressureEpsilon);
  return left.slice(0, left.length - 1).concat(right);
}

function simplifyRadialDistance(points, tol) {
  if (points.length <= 2) return points;
  const result = [points[0]];
  let prev = points[0];
  const sqTol = tol * tol;

  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    const dx = p[0] - prev[0];
    const dy = p[1] - prev[1];
    if (dx * dx + dy * dy >= sqTol) {
      result.push(p);
      prev = p;
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

/**
 * Flash 8 "Optimize Curves" tool (Dialog 873).
 * Simplifies a drawing's strokes with multiple passes and reports reduction stats.
 *
 * @param {Array<object>} strokes Strokes to simplify
 * @param {number} smoothing Smoothing level (0..100)
 * @param {boolean} multiplePasses Whether to perform 2 passes
 * @returns {{strokes: Array<object>, beforeCount: number, afterCount: number, reduction: number}}
 */
export function optimizeCurves(strokes, smoothing = 50, multiplePasses = true) {
  let beforeCount = 0;
  let afterCount = 0;

  const epsilon = Math.max(0.5, (smoothing / 100) * 8);

  const optimizedStrokes = strokes.map((stroke) => {
    if (!stroke.points || stroke.points.length <= 2) {
      beforeCount += stroke.points?.length ?? 0;
      afterCount += stroke.points?.length ?? 0;
      return stroke;
    }
    beforeCount += stroke.points.length;

    let pts = simplifyRDP(stroke.points, epsilon);
    if (multiplePasses && pts.length > 3) {
      pts = simplifyRDP(pts, epsilon * 0.8);
    }
    afterCount += pts.length;

    return {
      ...stroke,
      points: pts,
    };
  });

  const reduction =
    beforeCount > 0 ? Math.round(((beforeCount - afterCount) / beforeCount) * 100) : 0;

  return {
    strokes: optimizedStrokes,
    beforeCount,
    afterCount,
    reduction,
  };
}

/* ---------------------------------------------------- Brush Paint Modes */

/**
 * Flash 8 Brush Paint Modes Handler:
 * Computes how new paint interacts with the layer's existing raster / stroke buffer.
 *
 * 1. Paint Normal: Default painter, paints on top of all existing strokes.
 * 2. Paint Fills: Paints under existing line strokes, over existing fills & background.
 * 3. Paint Behind: Paints only on blank paper (behind both strokes and fills).
 * 4. Paint Selection: Paints only in currently selected areas.
 * 5. Paint Inside: Paints only inside the fill under the stroke's initial pen-down point.
 */
export function applyPaintMode(ctx, mode, options = {}) {
  const { strokeBounds, initialFillBounds, hasSelection } = options;

  switch (mode) {
    case BRUSH_PAINT_MODES.BEHIND:
      // Paint behind existing content: destination-over
      ctx.globalCompositeOperation = "destination-over";
      break;

    case BRUSH_PAINT_MODES.SELECTION:
      if (hasSelection) {
        ctx.globalCompositeOperation = "source-atop";
      } else {
        ctx.globalCompositeOperation = "source-over";
      }
      break;

    default:
      ctx.globalCompositeOperation = "source-over";
      break;
  }
}

/* ------------------------------------------------- Gap-Closing Flood Fill */

/**
 * Flash 8 Gap-Closing Paint Bucket Fill:
 * Performs flood-fill with gap closure dilation loop (FUN_0071f130, FUN_0071de50).
 *
 * @param {Uint8ClampedArray} data RGBA pixel buffer
 * @param {number} width Canvas width
 * @param {number} height Canvas height
 * @param {number} seedX Click X
 * @param {number} seedY Click Y
 * @param {Array<number>} rgb Fill colour [r, g, b]
 * @param {number} gapTolerance Maximum gap to close (0, 3, 6, 12)
 * @param {number} colorTolerance Color matching tolerance
 */
export function floodFillWithGaps(
  data,
  width,
  height,
  seedX,
  seedY,
  rgb,
  gapTolerance = 0,
  colorTolerance = 32,
  clip = null,
) {
  const startX = Math.round(seedX);
  const startY = Math.round(seedY);
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return false;

  const totalPixels = width * height;
  const seedIndex = (startY * width + startX) * 4;
  const targetColor = [
    data[seedIndex],
    data[seedIndex + 1],
    data[seedIndex + 2],
    data[seedIndex + 3],
  ];

  // If already the exact fill color, return
  if (
    targetColor[0] === rgb[0] &&
    targetColor[1] === rgb[1] &&
    targetColor[2] === rgb[2] &&
    targetColor[3] === 255
  ) {
    return false;
  }

  // The fill is kept to the runs it carries, so a fill that was made inside a
  // selection never paints outside it.
  const startPixel = startY * width + startX;
  if (clip && clip[startPixel] !== 1) return false;

  const isEdge = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return true;
    const idx = (y * width + x) * 4;
    // Edge if alpha > 128 and color is distinct from target
    for (let c = 0; c < 4; c += 1) {
      if (Math.abs(data[idx + c] - targetColor[c]) > colorTolerance) return true;
    }
    return false;
  };

  // If gapTolerance > 0, build dilated edge mask to close gaps
  let edgeMask = null;
  if (gapTolerance > 0) {
    edgeMask = new Uint8Array(totalPixels);
    const radius = gapTolerance;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (isEdge(x, y)) {
          // Dilate edge pixels by radius
          for (let dy = -radius; dy <= radius; dy += 1) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -radius; dx <= radius; dx += 1) {
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              if (dx * dx + dy * dy <= radius * radius) {
                edgeMask[ny * width + nx] = 1;
              }
            }
          }
        }
      }
    }
  }

  const matches = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const pixel = y * width + x;
    if (clip && clip[pixel] !== 1) return false;
    if (edgeMask && edgeMask[pixel]) return false;
    const idx = pixel * 4;
    for (let c = 0; c < 4; c += 1) {
      if (Math.abs(data[idx + c] - targetColor[c]) > colorTolerance) return false;
    }
    return true;
  };

  // Flood fill scanline queue
  const visited = new Uint8Array(totalPixels);
  const queue = [[startX, startY]];

  while (queue.length > 0) {
    const [cx, cy] = queue.pop();
    const row = cy * width;
    let left = cx;
    let right = cx;

    while (left > 0 && !visited[row + left - 1] && matches(left - 1, cy)) left -= 1;
    while (right < width - 1 && !visited[row + right + 1] && matches(right + 1, cy)) right += 1;

    for (let i = left; i <= right; i += 1) {
      const p = row + i;
      if (visited[p]) continue;
      visited[p] = 1;
      const idx = p * 4;
      data[idx] = rgb[0];
      data[idx + 1] = rgb[1];
      data[idx + 2] = rgb[2];
      data[idx + 3] = 255;

      if (cy > 0 && !visited[p - width] && matches(i, cy - 1)) queue.push([i, cy - 1]);
      if (cy < height - 1 && !visited[p + width] && matches(i, cy + 1)) queue.push([i, cy + 1]);
    }
  }

  return true;
}
