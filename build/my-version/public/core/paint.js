/**
 * Pixel operations shared by both painters (browser canvas and the Node
 * software rasteriser), so a drawing renders the same everywhere.
 *
 * Everything here works on straight-alpha RGBA byte buffers: colour channels
 * are not premultiplied, and a fully transparent pixel may hold any RGB.
 */

/** Parse "#rrggbb" into an [r, g, b] array. Returns null when malformed. */
export function parseHexColor(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Flood fill: replace every pixel connected to the seed (4-neighbour hops,
 * each within `tolerance` of the seed's own colour) with an opaque colour.
 * Works on the buffer in place; returns true when the seed was in bounds.
 */
export function floodFillRgba(data, width, height, seedX, seedY, rgb, tolerance = 32) {
  const startX = Math.round(seedX);
  const startY = Math.round(seedY);
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return false;

  const seedIndex = (startY * width + startX) * 4;
  const target = [data[seedIndex], data[seedIndex + 1], data[seedIndex + 2], data[seedIndex + 3]];
  const within = (index) => {
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(data[index + channel] - target[channel]) > tolerance) return false;
    }
    return true;
  };

  // Scanline fill: whole horizontal runs per stack entry, far fewer pushes
  // than per-pixel BFS. `done` stops a run from being revisited.
  const done = new Uint8Array(width * height);
  const stack = [[startX, startY]];
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const row = y * width;
    let left = x;
    let right = x;
    while (left > 0 && !done[row + left - 1] && within((row + left - 1) * 4)) left -= 1;
    while (right < width - 1 && !done[row + right + 1] && within((row + right + 1) * 4)) right += 1;

    for (let i = left; i <= right; i += 1) {
      const pixel = row + i;
      if (done[pixel]) continue;
      done[pixel] = 1;
      const index = pixel * 4;
      data[index] = rgb[0];
      data[index + 1] = rgb[1];
      data[index + 2] = rgb[2];
      data[index + 3] = 255;
      if (y > 0 && !done[pixel - width] && within((pixel - width) * 4)) stack.push([i, y - 1]);
      if (y < height - 1 && !done[pixel + width] && within((pixel + width) * 4)) stack.push([i, y + 1]);
    }
  }
  return true;
}

/**
 * Composite a stroke-shaped mask (opaque where the stroke is) over a drawing
 * buffer, following the same per-channel rule the canvas uses for blend
 * modes: blend the colours, then composite by source alpha.
 *
 *   Co = as·(1-ab)·Cs + as·ab·B(Cb,Cs) + (1-as)·ab·Cb
 */
export function blendStrokeOver(dst, mask, opacity = 1, blend = "normal") {
  for (let i = 0; i < dst.length; i += 4) {
    const as = (mask[i + 3] / 255) * opacity;
    if (as <= 0) continue;
    const ab = dst[i + 3] / 255;
    const outAlpha = as + ab * (1 - as);
    if (outAlpha <= 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
      continue;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      const cs = mask[i + channel];
      const cb = dst[i + channel];
      let blended;
      if (blend === "multiply") blended = (cs * cb) / 255;
      else if (blend === "screen") blended = 255 - ((255 - cs) * (255 - cb)) / 255;
      else blended = cs; // "normal"
      const co =
        as * (1 - ab) * cs + as * ab * blended + (1 - as) * ab * cb;
      dst[i + channel] = Math.round(co / outAlpha);
    }
    dst[i + 3] = Math.round(outAlpha * 255);
  }
}

/**
 * Erase the masked region from a drawing buffer, reducing alpha by the
 * masked fraction (an "opacity 50%" eraser halves the alpha it crosses).
 */
export function eraseStrokeFrom(dst, mask, opacity = 1) {
  for (let i = 0; i < dst.length; i += 4) {
    const strength = (mask[i + 3] / 255) * opacity;
    if (strength <= 0) continue;
    dst[i + 3] = Math.round(dst[i + 3] * (1 - strength));
  }
}

/** Sample an axis-aligned ellipse outline (from two opposite corners). */
export function sampleEllipse(x0, y0, x1, y1, segments = 96) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = Math.max(0, (right - left) / 2);
  const radiusY = Math.max(0, (bottom - top) / 2);
  if (radiusX === 0 || radiusY === 0) return null;

  const points = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push([
      centerX + Math.cos(angle) * radiusX,
      centerY + Math.sin(angle) * radiusY,
    ]);
  }
  return points;
}

/**
 * Stabiliser: ease a raw pointer sample toward the running point so shaky
 * input becomes a calmer path. Level 0 keeps the raw point, level 10 pulls
 * hard toward the previous position. The pressure channel (when present)
 * is passed through untouched.
 */
export function smoothPoint(previous, raw, level) {
  if (!previous || level <= 0) return raw;
  const ease = 1 / (1 + level);
  const smoothed = [
    previous[0] + (raw[0] - previous[0]) * ease,
    previous[1] + (raw[1] - previous[1]) * ease,
  ];
  if (raw.length > 2) smoothed.push(raw[2]);
  return smoothed;
}
