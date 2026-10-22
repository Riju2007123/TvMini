/**
 * The smoothing of a freehand stroke.
 *
 * The pencil and the brush of Macromedia Flash Professional 8 both have a
 * "Smoothing" setting, and the line they leave is not the line the hand
 * made: the points that do not bend the line are taken away. The tremble
 * of the hand is gone, the shape of the line is the same, and the line
 * that is shown while the stroke is being drawn is the line that will be
 * left behind.
 *
 * The points are measured in the pixels of the document, so the smoothing
 * is the same however much the stage is magnified.
 */

/** How far a point may be from the line through its neighbours, at the top of the scale. */
const SMOOTH_SCALE = 6;

/**
 * The tolerance of the smoothing, in the pixels of the document.
 *
 * @param {number} amount The setting of the smoothing, from 0 to 100.
 * @returns {number} The tolerance, in the pixels of the document.
 */
export function smoothTolerance(amount) {
  const value = Math.max(0, Math.min(100, Number(amount) || 0));
  return (value / 100) * SMOOTH_SCALE;
}

/** How far a point is from the straight line through two others. */
function distanceToLine(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  return (
    Math.abs(dy * point[0] - dx * point[1] + b[0] * a[1] - b[1] * a[0]) / length
  );
}

/**
 * Take the tremble out of the points of a stroke.
 *
 * A point is taken away when the straight line through the points around
 * it stays within the tolerance of it. This is the first step of the
 * Ramer–Douglas–Peucker algorithm, done as the stroke is drawn, so the
 * work stays small however long the stroke becomes.
 *
 * The points are changed in place, and the first and the last point are
 * always kept: the stroke starts and ends where the hand did.
 *
 * @param {Array<Array<number>>} points The points of the stroke.
 * @param {number} tolerance How far a point may be from the line, in the pixels of the document.
 * @returns {Array<Array<number>>} The points that are left.
 */
export function smoothStroke(points, tolerance) {
  if (!(tolerance > 0) || points.length < 3) return points;
  let last = points.length - 1;
  while (last >= 2) {
    const before = points[last - 2];
    const middle = points[last - 1];
    const after = points[last];
    if (distanceToLine(middle, before, after) > tolerance) break;
    points.splice(last - 1, 1);
    last -= 1;
  }
  return points;
}
