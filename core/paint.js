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
/**
 * The mask of the pixels a fill may touch, built from the runs a fill carries.
 *
 * A fill that is made while a selection is up keeps its runs, so the same fill
 * paints in the same pixels in the window and in the export. Without runs the
 * mask is null and the fill goes where it always went.
 */
export function clipMaskFromSpans(spans, width, height, scale = 1) {
  if (!spans || spans.length === 0) return null;
  const mask = new Uint8Array(width * height);
  const factor = scale > 0 ? scale : 1;
  for (const span of spans) {
    const y = Math.round(span[0] * factor);
    if (y < 0 || y >= height) continue;
    const from = Math.max(0, Math.round(span[1] * factor));
    const to = Math.min(width, Math.round(span[2] * factor));
    const row = y * width;
    for (let x = from; x < to; x += 1) mask[row + x] = 1;
  }
  return mask;
}

export function floodFillRgba(
  data,
  width,
  height,
  seedX,
  seedY,
  rgb,
  tolerance = 32,
  gapTolerance = 0,
  clip = null,
) {
  const startX = Math.round(seedX);
  const startY = Math.round(seedY);
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return false;

  const totalPixels = width * height;
  const seedIndex = (startY * width + startX) * 4;
  const target = [data[seedIndex], data[seedIndex + 1], data[seedIndex + 2], data[seedIndex + 3]];

  // If already exact fill colour, nothing to do
  if (
    target[0] === rgb[0] &&
    target[1] === rgb[1] &&
    target[2] === rgb[2] &&
    target[3] === 255
  ) {
    return false;
  }

  // The fill is kept to the runs it carries, so a fill that was made inside a
  // selection never paints outside it.
  if (clip && clip[startY * width + startX] !== 1) return false;

  // Flash 8 gap-closing dilation loop
  let edgeMask = null;
  if (gapTolerance > 0) {
    edgeMask = new Uint8Array(totalPixels);
    const radius = gapTolerance;
    const isEdge = (px, py) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return true;
      const idx = (py * width + px) * 4;
      for (let c = 0; c < 4; c += 1) {
        if (Math.abs(data[idx + c] - target[c]) > tolerance) return true;
      }
      return false;
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (isEdge(x, y)) {
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

  const within = (index, px, py) => {
    if (clip && clip[py * width + px] !== 1) return false;
    if (edgeMask && edgeMask[py * width + px]) return false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(data[index + channel] - target[channel]) > tolerance) return false;
    }
    return true;
  };

  // Scanline fill: whole horizontal runs per stack entry, far fewer pushes
  // than per-pixel BFS. `done` stops a run from being revisited.
  const done = new Uint8Array(totalPixels);
  const stack = [[startX, startY]];
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const row = y * width;
    let left = x;
    let right = x;
    while (left > 0 && !done[row + left - 1] && within((row + left - 1) * 4, left - 1, y)) left -= 1;
    while (right < width - 1 && !done[row + right + 1] && within((row + right + 1) * 4, right + 1, y)) right += 1;

    for (let i = left; i <= right; i += 1) {
      const pixel = row + i;
      if (done[pixel]) continue;
      done[pixel] = 1;
      const index = pixel * 4;
      data[index] = rgb[0];
      data[index + 1] = rgb[1];
      data[index + 2] = rgb[2];
      data[index + 3] = 255;
      if (y > 0 && !done[pixel - width] && within((pixel - width) * 4, i, y - 1)) stack.push([i, y - 1]);
      if (y < height - 1 && !done[pixel + width] && within((pixel + width) * 4, i, y + 1)) stack.push([i, y + 1]);
    }
  }
  return true;
}

/**
 * The runs a flood covers, read off the pixels without painting them.
 *
 * A fill that reads other layers, one that fills what the hand enclosed and
 * one that takes every unfilled pixel of a layer all hold the region they
 * took at the moment they took it, so the same pixels paint wherever the
 * stroke goes afterwards. The walk is the flood's own walk — the same
 * tolerance, the same closing of gaps — it only writes down where it went.
 *
 * @returns {Array<Array<number>>} Runs of [row, from, to), `to` left out.
 */
export function floodRegionSpans(
  data,
  width,
  height,
  seedX,
  seedY,
  tolerance = 32,
  gapTolerance = 0,
  clip = null,
) {
  const startX = Math.round(seedX);
  const startY = Math.round(seedY);
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return [];
  if (clip && clip[startY * width + startX] !== 1) return [];

  const totalPixels = width * height;
  const seedIndex = (startY * width + startX) * 4;
  const target = [data[seedIndex], data[seedIndex + 1], data[seedIndex + 2], data[seedIndex + 3]];

  // The same closing of gaps the flood does: the pixels near an edge of
  // another colour are walls the run does not cross.
  let edgeMask = null;
  if (gapTolerance > 0) {
    edgeMask = new Uint8Array(totalPixels);
    const radius = gapTolerance;
    const isEdge = (px, py) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return true;
      const idx = (py * width + px) * 4;
      for (let c = 0; c < 4; c += 1) {
        if (Math.abs(data[idx + c] - target[c]) > tolerance) return true;
      }
      return false;
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (isEdge(x, y)) {
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

  const within = (index, px, py) => {
    if (clip && clip[py * width + px] !== 1) return false;
    if (edgeMask && edgeMask[py * width + px]) return false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(data[index + channel] - target[channel]) > tolerance) return false;
    }
    return true;
  };

  const spans = [];
  const done = new Uint8Array(totalPixels);
  const stack = [[startX, startY]];
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const row = y * width;
    let left = x;
    let right = x;
    while (left > 0 && !done[row + left - 1] && within((row + left - 1) * 4, left - 1, y)) left -= 1;
    while (right < width - 1 && !done[row + right + 1] && within((row + right + 1) * 4, right + 1, y)) right += 1;

    for (let i = left; i <= right; i += 1) {
      const pixel = row + i;
      if (done[pixel]) continue;
      done[pixel] = 1;
      if (y > 0 && !done[pixel - width] && within((pixel - width) * 4, i, y - 1)) stack.push([i, y - 1]);
      if (y < height - 1 && !done[pixel + width] && within((pixel + width) * 4, i, y + 1)) stack.push([i, y + 1]);
    }
    spans.push([y, left, right + 1]);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return spans;
}

/** The runs of set pixels in a mask, one pass over the rows. */
export function spansFromMask(mask, width, height) {
  const spans = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      if (!mask[row + x]) {
        x += 1;
        continue;
      }
      const from = x;
      while (x < width && mask[row + x]) x += 1;
      spans.push([y, from, x]);
    }
  }
  return spans;
}

/**
 * The runs both lists cover.
 *
 * Both lists go row by row, so two pointers walk them together: the run
 * that ends first steps aside, and what the two share goes out.
 */
export function intersectSpans(a, b) {
  if (!a || !a.length || !b || !b.length) return [];
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const runA = a[i];
    const runB = b[j];
    if (runA[0] !== runB[0]) {
      if (runA[0] < runB[0]) i += 1;
      else j += 1;
      continue;
    }
    const from = Math.max(runA[1], runB[1]);
    const to = Math.min(runA[2], runB[2]);
    if (to > from) out.push([runA[0], from, to]);
    if (runA[2] <= runB[2]) i += 1;
    else j += 1;
  }
  return out;
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

/**
 * The width of a stroke at every one of its points.
 *
 * The points carry how hard the hand pressed, or how fast it moved: a pen
 * that is moved quickly leaves a thinner line, the way it does in Clip Studio
 * Paint.
 *
 * @param {object} stroke The stroke: its width and its points.
 * @returns {number[]} The half width of the line at every point.
 */
export const MIN_PRESSURE_SCALE = 0.2;

export function strokeRadii(stroke) {
  const base = stroke.width / 2;
  const points = stroke.points;
  return points.map((point) => {
    const pressure = point.length === 3 ? point[2] : 1;
    return Math.max(
      0.5,
      base * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * pressure),
    );
  });
}

/**
 * The groups a freehand stroke is drawn in.
 *
 * The width of a segment is the sum of the radii at its two ends, so a
 * stroke that tapers is a run of segments of different widths. Segments
 * that end up with the same width are drawn together, as one path: a draw
 * call for every segment is what makes the brush slow on a big canvas, and
 * a mouse gives every point the same pressure, so the whole stroke is one
 * path in that case.
 *
 * Each group says which width it is drawn with and which points of the
 * stroke it covers, from the first to the last.
 */
export function strokePathGroups(points, radii) {
  const groups = [];
  let index = 1;
  while (index < points.length) {
    const width = Math.max(1, radii[index - 1] + radii[index]);
    let last = index;
    while (
      last + 1 < points.length &&
      Math.max(1, radii[last] + radii[last + 1]) === width
    ) {
      last += 1;
    }
    groups.push({ width, from: index - 1, to: last });
    index = last + 1;
  }
  return groups;
}

/**
 * The outline of a stroke whose width changes along the way.
 *
 * The stroke is one shape: the left side of the line, then the right side
 * of it, and the two are filled together. The width then changes the way
 * the width of a pen changes, instead of in steps, and the edge of the line
 * is one clean edge.
 *
 * The points where the line turns sharply are the hard ones: the two
 * sides are joined by a small cut there, so that the shape does not fold
 * on itself.
 *
 * @param {Array<Array<number>>} points The points of the stroke.
 * @param {number[]} radii The half width of the line at every point.
 * @returns {{left: Array<Array<number>>, right: Array<Array<number>>}} The two sides of the line.
 */
export function strokeOutline(points, radii) {
  const left = [];
  const right = [];
  for (let index = 0; index < points.length; index += 1) {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    let dx = after[0] - before[0];
    let dy = after[1] - before[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= length;
      dy /= length;
    }
    // The line across the direction of the stroke.
    const across = radii[index];
    left.push([points[index][0] - dy * across, points[index][1] + dx * across]);
    right.push([points[index][0] + dy * across, points[index][1] - dx * across]);
  }
  return { left, right };
}

/**
 * Render one of Flash 8's 9 brush tip shapes at (x, y):
 * circle, square, flatHorizontal, flatVertical, slash45, slash135, chisel45, chisel135, diamond.
 */
export function drawBrushTipShape(ctx, x, y, size, shape = "circle", tiltAngle = 0) {
  const r = size / 2;
  ctx.save();
  ctx.translate(x, y);
  if (tiltAngle) {
    ctx.rotate(tiltAngle);
  }

  ctx.beginPath();
  switch (shape) {
    case "square":
      ctx.rect(-r, -r, size, size);
      break;

    case "flatHorizontal":
      ctx.ellipse(0, 0, r, Math.max(1, r * 0.28), 0, 0, Math.PI * 2);
      break;

    case "flatVertical":
      ctx.ellipse(0, 0, Math.max(1, r * 0.28), r, 0, 0, Math.PI * 2);
      break;

    case "slash45":
      ctx.rotate(Math.PI / 4);
      ctx.ellipse(0, 0, r, Math.max(1, r * 0.25), 0, 0, Math.PI * 2);
      break;

    case "slash135":
      ctx.rotate((3 * Math.PI) / 4);
      ctx.ellipse(0, 0, r, Math.max(1, r * 0.25), 0, 0, Math.PI * 2);
      break;

    case "chisel45":
      ctx.rotate(Math.PI / 4);
      ctx.rect(-r, -Math.max(1, r * 0.3), size, Math.max(2, r * 0.6));
      break;

    case "chisel135":
      ctx.rotate((3 * Math.PI) / 4);
      ctx.rect(-r, -Math.max(1, r * 0.3), size, Math.max(2, r * 0.6));
      break;

    case "diamond":
      ctx.rotate(Math.PI / 4);
      ctx.rect(-r * 0.75, -r * 0.75, size * 0.75, size * 0.75);
      break;

    case "circle":
    default:
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      break;
  }
  ctx.fill();
  ctx.restore();
}

/**
 * Configure 2D canvas context for Flash 8 procedural stroke styles:
 * solid, dashed, dotted, ragged, stippled, hatched.
 */
export function applyProceduralStroke(ctx, style = "solid", strokeWidth = 1) {
  const w = Math.max(1, strokeWidth);
  switch (style) {
    case "dashed":
      ctx.setLineDash([w * 3, w * 2]);
      break;
    case "dotted":
      ctx.setLineDash([w, w * 1.6]);
      break;
    case "ragged":
      ctx.setLineDash([w * 2, w, w * 0.5, w]);
      break;
    case "stippled":
      ctx.setLineDash([w * 0.5, w * 3]);
      break;
    case "hatched":
      ctx.setLineDash([w * 4, w * 1.5, w * 1, w * 1.5]);
      break;
    case "solid":
    default:
      ctx.setLineDash([]);
      break;
  }
}
