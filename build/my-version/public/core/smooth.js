/**
 * The smoothing of a freehand stroke.
 *
 * The pencil and the brush of Macromedia Flash Professional 8 both have a
 * "Smoothing" setting. The line they leave is not the line the hand made,
 * and it was measured what it does
 * (`tools/flash8-draw.ps1` draws the same line in Flash 8):
 *
 * - A line with a tremble in it is **wavy** with the smoothing at 0 and
 *   **straight** with the smoothing at 100: the quick up and down of the
 *   hand is gone.
 * - A wave drawn with the brush is the **same wave** with the smoothing at
 *   0 and at 100: the shape of the line is not touched.
 *
 * So the smoothing is a **moving average** of the points: every point is
 * replaced by the middle of the points around it. A tremble is a quick
 * change, and the middle of a quick change is the line through it; a
 * wave is a slow change, and the middle of a slow change is the wave
 * itself. That is why the tremble goes and the wave stays.
 *
 * The points are measured in the pixels of the document, so the smoothing
 * is the same however much the stage is magnified.
 */

/** How far the average reaches at the top of the scale, in the pixels of the document. */
const SMOOTH_SCALE = 16;

/**
 * How far the average reaches, in the pixels of the document.
 *
 * @param {number} amount The setting of the smoothing, from 0 to 100.
 * @returns {number} The reach, in the pixels of the document.
 */
export function smoothRadius(amount) {
  const value = Math.max(0, Math.min(100, Number(amount) || 0));
  return (value / 100) * SMOOTH_SCALE;
}

/** How far two points are from each other. */
function apart(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Take the tremble out of the points of a stroke.
 *
 * Every point but the first and the last is replaced by the middle of the
 * points around it, the points that are near enough being the ones that
 * are counted. The first and the last point stay where they are, so the
 * stroke starts and ends where the hand did.
 *
 * The points are not changed: a new list is made, so the average can be
 * taken again and again over the same points without the line melting
 * away.
 *
 * @param {Array<Array<number>>} points The points of the stroke.
 * @param {number} radius How far the average reaches, in the pixels of the document.
 * @returns {Array<Array<number>>} The points with the tremble taken out.
 */
export function smoothStroke(points, radius) {
  if (!(radius > 0) || points.length < 3) return points.map((point) => [...point]);
  const out = points.map((point) => [...point]);

  for (let i = 1; i < points.length - 1; i += 1) {
    // The points that are near enough to have a word about it.
    let from = i;
    while (from > 0 && apart(points[from - 1], points[i]) <= radius) from -= 1;
    let to = i;
    while (to < points.length - 1 && apart(points[to + 1], points[i]) <= radius) to += 1;

    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let j = from; j <= to; j += 1) {
      sumX += points[j][0];
      sumY += points[j][1];
      count += 1;
    }
    if (count < 2) continue;
    out[i][0] = sumX / count;
    out[i][1] = sumY / count;
    // The pressure is the pressure of the point itself: it is what the pen
    // said, and an average has nothing to say about it.
    if (points[i].length > 2) out[i][2] = points[i][2];
  }
  return out;
}
