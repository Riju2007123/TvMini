/**
 * The grain of the paper.
 *
 * Clip Studio Paint calls the grain of a brush its "texture". A brush that has
 * one keeps the grain in a second material: a picture whose *alpha* is the
 * pattern of the paper, black with see-through holes (`PaperTexture` in the
 * small XML of the material). The settings of the grain are in the columns of
 * `Variant` that start with `Texture`.
 *
 * A grain is anchored to the paper, not to the stroke: the same brush drawn
 * twice, one line over the other, puts the same holes in both. The stage and
 * the export therefore both work out the grain from the place of the pixel in
 * the document, and both use the two functions below, so the line that is
 * drawn and the line that is written in the file are the same line.
 */

/** The grain a brush has when it says nothing about one. */
export const NO_GRAIN = null;

/**
 * How much of the ink the grain leaves, where the picture of the grain holds
 * `alpha` (from 0, a hole, to 1, full paint).
 *
 * `density` is how strongly the grain is applied, from 0 (the grain does
 * nothing) to 1 (the grain at full strength). `reverse` turns the pattern
 * over, the way the "reverse density" switch of Clip Studio Paint does.
 */
export function grainCoverage(alpha, { density = 1, reverse = false } = {}) {
  const ink = reverse ? 1 - alpha : alpha;
  const strength = Math.max(0, Math.min(1, density));
  return Math.max(0, Math.min(1, 1 - strength * (1 - ink)));
}

/**
 * Where a point of the document lands in the picture of the grain.
 *
 * The grain is scaled and turned by the settings of the brush, and it repeats
 * over the paper. `scale` is a percentage: 100 is the picture at its own size,
 * 25 a quarter of it, so the pattern repeats four times as often.
 */
export function grainPlacement(grain, x, y) {
  const scale = Math.max(0.05, Math.min(10, (Number(grain?.scale) || 100) / 100));
  const angle = ((Number(grain?.rotate) || 0) * Math.PI) / 180;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return [(x * cos - y * sin) / scale, (x * sin + y * cos) / scale];
}

/**
 * The ink the grain holds at a point of the document, from 0 to 1.
 *
 * `picture` is the grain, unpacked: `{ width, height, alpha }`, where `alpha`
 * is one byte for every pixel. The picture is sampled in the middle of the
 * pixel under the point, and its edges are blended, so a grain that is made
 * bigger does not turn into blocks.
 */
export function grainInkAt(picture, grain, x, y) {
  const [px, py] = grainPlacement(grain, x, y);
  const width = picture.width;
  const height = picture.height;
  if (!width || !height) return 1;

  const u = ((px % width) + width) % width;
  const v = ((py % height) + height) % height;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = (x0 + 1) % width;
  const y1 = (y0 + 1) % height;
  const fx = u - x0;
  const fy = v - y0;

  const alpha = picture.alpha;
  const top = alpha[y0 * width + x0] * (1 - fx) + alpha[y0 * width + x1] * fx;
  const bottom = alpha[y1 * width + x0] * (1 - fx) + alpha[y1 * width + x1] * fx;
  return (top * (1 - fy) + bottom * fy) / 255;
}

/**
 * The ink the grain holds at a point of the document, with the settings of the
 * brush already applied. This is what a renderer multiplies the paint of a
 * stroke by.
 */
export function grainMaskAt(picture, grain, x, y) {
  return grainCoverage(grainInkAt(picture, grain, x, y), grain);
}

/**
 * A function that says how much ink the grain leaves at a point.
 *
 * The turn and the size of the grain are worked out once, so that a renderer
 * that walks over a whole drawing does not work them out again for every
 * pixel. The pattern repeats over the paper.
 */
export function grainSampler(picture, grain) {
  const scale = Math.max(0.05, Math.min(10, (Number(grain?.scale) || 100) / 100));
  const angle = ((Number(grain?.rotate) || 0) * Math.PI) / 180;
  const cos = Math.cos(-angle) / scale;
  const sin = Math.sin(-angle) / scale;
  const width = picture.width;
  const height = picture.height;
  const alpha = picture.alpha;
  const density = Math.max(0, Math.min(1, Number(grain?.density ?? 100) / 100));
  const reverse = grain?.reverse === true;

  return (x, y) => {
    if (!width || !height) return 1;
    const u = x * cos - y * sin;
    const v = x * sin + y * cos;
    const sx = ((u % width) + width) % width;
    const sy = ((v % height) + height) % height;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = (x0 + 1) % width;
    const y1 = (y0 + 1) % height;
    const fx = sx - x0;
    const fy = sy - y0;
    const top = alpha[y0 * width + x0] * (1 - fx) + alpha[y0 * width + x1] * fx;
    const bottom = alpha[y1 * width + x0] * (1 - fx) + alpha[y1 * width + x1] * fx;
    const ink = (top * (1 - fy) + bottom * fy) / 255;
    return grainCoverage(ink, { density, reverse });
  };
}
