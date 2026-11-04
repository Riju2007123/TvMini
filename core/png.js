import { floodFillWithGaps } from "./flash8-drawing.js";
import { cameraAt, effectiveOpacity, layerIsVisible, resolveDrawing } from "../timeline.js";
import { Buffer } from "./bytes.js";
import { transformOf, transformAt, isPlain, composeMatrix, transformRgba } from "./transform.js";
import {
  blendStrokeOver,
  clipMaskFromSpans,
  eraseStrokeFrom,
  floodFillRgba,
  sampleEllipse,
} from "./paint.js";
import { deflateSync, inflateSync } from "./zlib.js";
import { dynamicsOf, strokeDabs } from "./brush-dynamics.js";
import { grainSampler } from "./grain.js";

function parseHex(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * The brush stamp in use while a drawing is painted.
 *
 * A drawing may carry a brush image, the way a Clip Studio Paint brush does.
 * Its alpha is the shape of the brush, so the disc below becomes the stamp.
 * It is set for the time of one drawing, so nothing has to be threaded
 * through every step of the painting.
 */
let brushStamp = null;

/**
 * The brush of the drawing being painted.
 *
 * A stroke remembers the brush it was made with, and that one is used for
 * the stroke; this is the brush of the drawing, and it is the one used by
 * strokes that were made before strokes remembered their brush.
 */
let drawingBrush = null;

/** The stamps that have been unpacked, so a stroke does not unpack it again. */
const stampCache = new Map();

/** The pictures of the paper, unpacked, in the plane of their alpha. */
const grainCache = new Map();

/** Unpack the picture of a grain into the plane of its alpha. */
function grainPictureFor(grain) {
  if (!grain?.data) return null;
  const key = grain.data;
  if (grainCache.has(key)) return grainCache.get(key);
  let picture = null;
  try {
    const image = decodePng(Buffer.from(key, "base64"));
    const alpha = new Uint8Array(image.width * image.height);
    for (let index = 0; index < alpha.length; index += 1) {
      alpha[index] = image.data[index * 4 + 3];
    }
    picture = { width: image.width, height: image.height, alpha };
  } catch {
    picture = null;
  }
  if (grainCache.size > 8) grainCache.clear();
  grainCache.set(key, picture);
  return picture;
}

/**
 * The way the paint of the stroke in hand goes down.
 *
 * A brush says how much paint one dab leaves (its flow), how hard the edge of
 * its tip is (its hardness), how flat the tip is (its thickness), how far
 * apart the dabs are (its spacing), how its tip turns and what the grain of
 * the paper takes away. All of that is read once per stroke, in
 * `brush-dynamics.js`, and both painters use the same reading.
 */
const DEFAULT_STYLE = {
  flow: 1,
  hardness: 1,
  thickness: 1,
  spacing: 0.25,
  rotation: 0,
  followsDirection: false,
  jitter: 0,
  binarize: false,
  grain: null,
  effectors: {},
  accumulates: false,
  needsDabs: false,
};
let strokeStyle = DEFAULT_STYLE;
let strokeTipShape = "circle";

/** The ink the paper leaves at a point, for the stroke in hand. */
let grainInk = null;

/** The settings that shape the paint of a brush. */
function styleOfBrush(brush) {
  return brush ? dynamicsOf(brush) : DEFAULT_STYLE;
}

/**
 * How much of the paint of a dab is left, after the paper of the stroke.
 *
 * The grain belongs to the paper, not to the stroke, so it is read in the
 * place of the pixel in the document: the same brush drawn twice leaves the
 * same holes in the same places.
 */
function grainAt(x, y) {
  return grainInk ? grainInk(x, y) : 1;
}

/**
 * Unpack a brush image into the plane of its alpha.
 *
 * `brush.data` is the base64 of a PNG, the same way a drawing's own image is
 * kept.
 */
function stampFor(brush) {
  if (!brush) return null;
  const key = brush.data;
  if (stampCache.has(key)) return stampCache.get(key);

  let stamp = null;
  try {
    const bytes = typeof key === "string" ? Buffer.from(key, "base64") : key;
    const image = decodePng(bytes);
    const alpha = new Uint8Array(image.width * image.height);
    for (let index = 0; index < alpha.length; index += 1) {
      alpha[index] = image.data[index * 4 + 3];
    }
    stamp = { width: image.width, height: image.height, alpha };
  } catch {
    stamp = null;
  }
  if (stampCache.size > 8) stampCache.clear();
  stampCache.set(key, stamp);
  return stamp;
}

/**
 * Paint one pixel of the mask with a coverage that is not full.
 *
 * The dabs of a stroke lie on top of each other, and the paint of a pixel is
 * the strongest of the dabs that touch it: a pixel that two dabs both cover
 * is not covered twice, it is covered once. Adding the coverages up instead
 * would make every stroke fatter than the brush is, and a thin stroke fatter
 * than it is by a long way, because a thin stroke is made of many dabs that
 * all touch the same pixel.
 *
 * A brush whose flow is below 100 is the other way round: every dab leaves
 * part of its paint (`flow`), and the dabs build up on each other, the way
 * they do in Clip Studio Paint.
 */
function setPixelAlpha(layer, width, height, x, y, rgb, alpha, erase, flow = 1) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return;
  const index = (py * width + px) * 4;

  if (strokeStyle.binarize && alpha < 255) {
    // An edge that is either paint or paper: the middle of the fade is where
    // the edge falls.
    if (alpha < 128) return;
    alpha = 255;
  }

  if (erase) {
    // The eraser takes the paint away in the share of the pixel the tip
    // covers, the way the browser's canvas takes it away: a pixel the tip
    // only grazes keeps most of its paint.
    const strength = alpha / 255;
    layer[index + 3] = Math.round(layer[index + 3] * (1 - strength));
    return;
  }

  layer[index] = rgb[0];
  layer[index + 1] = rgb[1];
  layer[index + 2] = rgb[2];

  if (!strokeStyle.accumulates) {
    // Full flow: one dab is as strong as another, so the strongest one wins.
    if (alpha > layer[index + 3]) layer[index + 3] = alpha;
    return;
  }

  const under = layer[index + 3] / 255;
  const cover = (alpha / 255) * Math.max(0, Math.min(1, flow));
  layer[index + 3] = Math.round((under + cover * (1 - under)) * 255);
}

/**
 * Paint the brush image instead of a disc.
 *
 * The image is fitted to the size of the brush, the way Clip Studio Paint
 * fits a brush texture, and its alpha is the coverage of every pixel. The
 * image keeps its own shape: a tip that is twice as wide as it is tall stays
 * that way. A brush whose tip is flat (`flat` below 1) is squashed across the
 * stroke, and the tip is turned by the angle of its dab.
 */
function stamp(layer, width, height, dab, rgb, erase, brush) {
  const across = Math.max(0.5, dab.r * 2 * dab.flat);
  const along = Math.max(0.5, across * (brush.width / Math.max(1, brush.height)));
  const cos = Math.cos(dab.angle);
  const sin = Math.sin(dab.angle);

  // The box of the turned tip: the four corners of its own box, turned.
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [u, v] of [
    [-along / 2, -across / 2],
    [along / 2, -across / 2],
    [along / 2, across / 2],
    [-along / 2, across / 2],
  ]) {
    const x = dab.x + u * cos - v * sin;
    const y = dab.y + u * sin + v * cos;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }

  const x0 = Math.max(0, Math.floor(left));
  const x1 = Math.min(width - 1, Math.ceil(right));
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(height - 1, Math.ceil(bottom));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - dab.x;
      const dy = y + 0.5 - dab.y;
      // The place of the pixel in the tip's own frame: u along the tip, v
      // across it.
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      const su = u / (along / 2);
      const sv = v / (across / 2);
      if (su < -1 || su > 1 || sv < -1 || sv > 1) continue;
      // The box of the dab covers the picture whole: `su` and `sv` run from
      // -1 at the far edge to 1 at the near one, so half of one more is the
      // place in the picture as a share of its width. The share times the
      // width is the pixel of the picture, and the last one is held at the
      // edge so the far edge of the tip is painted.
      const sx = Math.min(
        brush.width - 1,
        Math.max(0, Math.floor(((su + 1) / 2) * brush.width)),
      );
      const sy = Math.min(
        brush.height - 1,
        Math.max(0, Math.floor(((sv + 1) / 2) * brush.height)),
      );
      const alpha = brush.alpha[sy * brush.width + sx];
      if (alpha === 0) continue;
      setPixelAlpha(layer, width, height, x, y, rgb, alpha, erase, dab.flow);
    }
  }
}

/**
 * Paint or erase one dab of a brush.
 *
 * The tip of a round brush is a disc, and the edge of the tip is soft: the
 * pixel the edge falls in carries the share of it that the tip covers, the
 * way the browser's canvas paints the same stroke. A brush that is not hard
 * fades out from the middle instead of stopping at its edge, and a flat tip
 * is an ellipse whose across axis is the thickness of the brush.
 */
/**
 * Paint one dab whose tip has a Flash 8 shape (square, flat, chisel, slash,
 * diamond) instead of the round/elliptical tip the usual dab uses.
 */
function paintShapedDab(layer, width, height, dab, rgb, erase, shape) {
  const along = Math.max(0.25, dab.r * 2);
  const across = Math.max(0.25, dab.r * 2 * dab.flat);
  const cos = Math.cos(dab.angle);
  const sin = Math.sin(dab.angle);
  const hw = along / 2;
  const hh = across / 2;
  const reachX = Math.hypot(hw * cos, hh * sin) + 1;
  const reachY = Math.hypot(hw * sin, hh * cos) + 1;
  const x0 = Math.max(0, Math.floor(dab.x - reachX));
  const x1 = Math.min(width - 1, Math.ceil(dab.x + reachX));
  const y0 = Math.max(0, Math.floor(dab.y - reachY));
  const y1 = Math.min(height - 1, Math.ceil(dab.y + reachY));
  const hardness = strokeStyle.hardness;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - dab.x;
      const dy = y + 0.5 - dab.y;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      const px = u / hw;
      const py = v / hh;
      let qx = px;
      let qy = py;
      if (shape === "slash45" || shape === "chisel45") {
        const r = Math.PI / 4;
        const c = Math.cos(-r);
        const s = Math.sin(-r);
        const rx = qx * c - qy * s;
        const ry = qx * s + qy * c;
        qx = rx;
        qy = ry;
      } else if (shape === "slash135" || shape === "chisel135") {
        const r = (3 * Math.PI) / 4;
        const c = Math.cos(-r);
        const s = Math.sin(-r);
        const rx = qx * c - qy * s;
        const ry = qx * s + qy * c;
        qx = rx;
        qy = ry;
      }
      let w = 0;
      if (shape === "square" || shape === "chisel45" || shape === "chisel135") {
        w = Math.max(Math.abs(qx), Math.abs(qy));
      } else if (shape === "diamond") {
        w = Math.abs(qx) + Math.abs(qy);
      } else {
        // flat / slash tips are elliptical
        w = Math.sqrt(qx * qx + qy * qy);
      }
      if (w > 1.5) continue;
      if (w > 1) continue;
      let cover = 1;
      if (hardness < 0.999 && w > hardness) {
        cover = (1 - w) / Math.max(1e-6, 1 - hardness);
      }
      if (cover <= 0) continue;
      setPixelAlpha(layer, width, height, x, y, rgb, Math.round(255 * Math.min(1, cover)), erase, dab.flow);
    }
  }
}

function paintDab(layer, width, height, dab, rgb, erase) {
  if (brushStamp) {
    stamp(layer, width, height, dab, rgb, erase, brushStamp);
    return;
  }

  if (strokeTipShape && strokeTipShape !== "circle") {
    paintShapedDab(layer, width, height, dab, rgb, erase, strokeTipShape);
    return;
  }

  const along = Math.max(0.25, dab.r);
  const across = Math.max(0.25, dab.r * dab.flat);
  const cos = Math.cos(dab.angle);
  const sin = Math.sin(dab.angle);
  // The box the turned tip reaches, and one pixel more for its soft edge.
  const reachX = Math.hypot(along * cos, across * sin) + 1;
  const reachY = Math.hypot(along * sin, across * cos) + 1;
  const x0 = Math.max(0, Math.floor(dab.x - reachX));
  const x1 = Math.min(width - 1, Math.ceil(dab.x + reachX));
  const y0 = Math.max(0, Math.floor(dab.y - reachY));
  const y1 = Math.min(height - 1, Math.ceil(dab.y + reachY));
  const hardness = strokeStyle.hardness;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - dab.x;
      const dy = y + 0.5 - dab.y;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      const nu = u / along;
      const nv = v / across;
      const away = Math.sqrt(nu * nu + nv * nv);
      if (away > 1.5) continue;

      // The share of the pixel the tip covers: the distance to the edge is
      // the distance in the shape's own units divided by the gradient of the
      // shape there, so a pixel the edge falls in gets the share it covers.
      const gu = nu / along;
      const gv = nv / across;
      const gradient = Math.sqrt(gu * gu + gv * gv);
      let cover;
      if (gradient < 1e-9) {
        cover = Math.min(1, Math.PI * along * across);
      } else {
        cover = 0.5 - (away - 1) / gradient;
      }
      if (cover <= 0) continue;

      // A soft brush fades from its hardness out to its edge; a hard one
      // stops at the edge.
      if (away > hardness) {
        cover *= (1 - away) / Math.max(1e-6, 1 - hardness);
      }
      if (cover <= 0) continue;

      setPixelAlpha(
        layer, width, height, x, y, rgb,
        Math.round(255 * Math.min(1, cover)), erase, dab.flow,
      );
    }
  }
}

/** Smallest fraction of the brush width used at zero pressure. */
export const MIN_PRESSURE_SCALE = 0.2;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(type, line, previous, bpp) {
  switch (type) {
    case 0:
      break;
    case 1:
      for (let i = bpp; i < line.length; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2:
      for (let i = 0; i < line.length; i += 1) line[i] = (line[i] + previous[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const upLeft = i >= bpp ? previous[i - bpp] : 0;
        line[i] = (line[i] + paeth(left, previous[i], upLeft)) & 0xff;
      }
      break;
    default:
      throw new Error(`unsupported PNG filter ${type}`);
  }
}

/**
 * Decode a non-interlaced 8-bit RGB/RGBA PNG into RGBA bytes.
 * This is the subset produced by this app and by Clip Studio previews.
 */
export function decodePng(input) {
  // A plain Uint8Array has no readUInt32BE, so wrap it first.
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }

  let offset = 8;
  let header = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }

  if (!header) throw new Error("PNG has no header");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colorType = header[9];
  const interlace = header[12];

  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error("unsupported PNG (need 8-bit RGB/RGBA, non-interlaced)");
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    unfilter(filter, line, previous, channels);

    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      out[target] = line[source];
      out[target + 1] = line[source + 1];
      out[target + 2] = line[source + 2];
      out[target + 3] = channels === 4 ? line[source + 3] : 255;
    }

    previous = line;
  }

  return { width, height, data: out };
}

/**
 * Decoded pictures, kept so that a frame does not decode them again.
 *
 * A picture that comes from an imported document is a PNG that is the same
 * for every frame, and unpacking one costs about a tenth of a second for a
 * canvas the size of a photograph. Decoding them again for every frame is
 * what makes a big imported document slow, so the result is kept and used
 * again.
 *
 * The pictures are only ever read, never changed: a caller that wants to
 * paint on one copies it first.
 */
const pictureCache = new Map();
let pictureCacheBytes = 0;
// A canvas from an imported document is a good part of a hundred megabytes
// once it is decoded, so the limit counts pictures, not drawings: too small
// and an export of a big animation decodes the same picture over and over.
const PICTURE_CACHE_LIMIT = 512 * 1024 * 1024;

/** Decode a picture, or hand back the one that was decoded before. */
export function decodePicture(source) {
  const key = typeof source === "string" ? source : null;
  if (key !== null) {
    const hit = pictureCache.get(key);
    if (hit) {
      // Put it at the end, so the one that was used longest ago is the one
      // that is dropped when the cache is full.
      pictureCache.delete(key);
      pictureCache.set(key, hit);
      return hit;
    }
  }

  const bytes = typeof source === "string" ? Buffer.from(source, "base64") : source;
  const picture = decodePng(bytes);
  if (key !== null) {
    pictureCache.set(key, picture);
    pictureCacheBytes += picture.data.length;
    while (pictureCacheBytes > PICTURE_CACHE_LIMIT && pictureCache.size > 1) {
      const oldest = pictureCache.keys().next().value;
      pictureCacheBytes -= pictureCache.get(oldest).data.length;
      pictureCache.delete(oldest);
    }
  }
  return picture;
}

/** Forget the pictures that were decoded. */
export function clearPictureCache() {
  pictureCache.clear();
  pictureCacheBytes = 0;
}

/**
 * The picture of a drawing that is only a picture.
 *
 * Returns null when the drawing has strokes on top of the picture, or when
 * the picture is not the size of the canvas - in both cases the drawing has
 * to be painted into a buffer of its own.
 */
function directPicture(drawing, width, height) {
  if (!drawing || !drawing.image) return null;
  if (drawing.strokes && drawing.strokes.length) return null;
  // A trimmed picture does not fill the buffer it is painted into, so it
  // has to go through the painter, which puts it back in its box.
  if (drawing.image.x !== undefined || drawing.image.y !== undefined) return null;
  const picture = decodePicture(drawing.image.data);
  if (picture.width !== width || picture.height !== height) return null;
  return picture.data;
}

/**
 * Fill one closed path into a straight-alpha RGBA buffer.
 *
 * Every pixel row is sampled four times down its height, and what each span
 * covers across the row is added up, so a filled contour has the same soft
 * edge the canvas gives it instead of a staircase.
 */
function fillPathInto(target, width, height, stroke, rgb, erase, scale = 1) {
  const source = stroke.points;
  if (!source || source.length < 3) return;
  // The points are in the units of the document; the picture may be painted
  // with more pixels than that.
  const points = scale === 1
    ? source
    : source.map((point) => [point[0] * scale, point[1] * scale, ...point.slice(2)]);

  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  const top = Math.max(0, Math.floor(minY));
  const bottom = Math.min(height - 1, Math.ceil(maxY));
  // The same guard as the multi-subpath fill: a shape off the canvas or with
  // points that are not finite paints nothing.
  if (!(bottom >= top)) return;
  const samples = 4;
  const coverage = new Float32Array(width);

  const edges = [];
  for (let i = 0; i < points.length; i += 1) {
    edges.push([points[i], points[(i + 1) % points.length]]);
  }
  const buckets = scanlineBuckets(edges, top, bottom, samples);

  for (let y = top; y <= bottom; y += 1) {
    coverage.fill(0);
    for (let sample = 0; sample < samples; sample += 1) {
      const scanY = y + (sample + 0.5) / samples;
      const own = buckets[(y - top) * samples + sample];
      if (!own) continue;
      const crossings = [];
      for (const [a, b] of own) {
        if ((a[1] <= scanY && b[1] > scanY) || (b[1] <= scanY && a[1] > scanY)) {
          const t = (scanY - a[1]) / (b[1] - a[1]);
          crossings.push([a[0] + (b[0] - a[0]) * t, b[1] > a[1] ? 1 : -1]);
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((left, right) => left[0] - right[0]);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i += 1) {
        winding += crossings[i][1];
        if (winding === 0) continue;
        coverSpan(coverage, width, crossings[i][0], crossings[i + 1][0], 1 / samples);
      }
    }
    applyCoverage(target, width, y, coverage, rgb, erase);
  }
}

/**
 * Fill several subpaths of one fill style into a straight-alpha RGBA buffer,
 * the way Flash fills a shape: every edge of every subpath contributes to the
 * same winding number, so an inner contour whose winding opposes the outer
 * one carves a hole instead of being filled on top of it.
 *
 * Each subpath is an array of points; it is treated as closed (last point
 * connects back to the first).
 */
/**
 * The edges of a closed shape, sorted into the scanlines they cross.
 *
 * Scanline `s` sits at `top + (s + 0.5) / samples`, which is exactly where
 * the rows of a fill read it, and an edge lands in a bucket only when that
 * scanline can cross it — so the crossings a fill finds per row are exactly
 * the ones a pass over every edge at every row would find, at the cost of
 * the crossings rather than of every point at every row.
 */
function scanlineBuckets(edges, top, bottom, samples) {
  const scanCount = (bottom - top + 1) * samples;
  const buckets = new Array(scanCount);
  for (const [a, b] of edges) {
    if (!Number.isFinite(a[1]) || !Number.isFinite(b[1])) continue;
    const edgeTop = Math.min(a[1], b[1]);
    const edgeBottom = Math.max(a[1], b[1]);
    if (edgeTop === edgeBottom) continue; // a horizontal edge crosses no scanline
    let first = Math.ceil((edgeTop - top) * samples - 0.5);
    let last = Math.ceil((edgeBottom - top) * samples - 0.5);
    if (first < 0) first = 0;
    if (last > scanCount) last = scanCount;
    for (let s = first; s < last; s += 1) {
      (buckets[s] ??= []).push([a, b]);
    }
  }
  return buckets;
}

function fillPathsInto(target, width, height, subpaths, rgb, erase, scale = 1) {
  let minY = Infinity;
  let maxY = -Infinity;
  const edges = [];
  for (const subpath of subpaths) {
    if (!subpath || subpath.length < 2) continue;
    const points = scale === 1 ? subpath : subpath.map((point) => [point[0] * scale, point[1] * scale]);
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      edges.push([a, b]);
      if (a[1] < minY) minY = a[1];
      if (a[1] > maxY) maxY = a[1];
    }
  }
  if (edges.length === 0) return;

  const top = Math.max(0, Math.floor(minY));
  const bottom = Math.min(height - 1, Math.ceil(maxY));
  // A shape whose points are not finite, or that sits wholly outside the
  // canvas, paints nothing — the row loop below would simply never run for
  // it, and neither must the buckets be built for it.
  if (!(bottom >= top)) return;
  const samples = 4;
  const coverage = new Float32Array(width);
  const buckets = scanlineBuckets(edges, top, bottom, samples);

  for (let y = top; y <= bottom; y += 1) {
    coverage.fill(0);
    for (let sample = 0; sample < samples; sample += 1) {
      const scanY = y + (sample + 0.5) / samples;
      const own = buckets[(y - top) * samples + sample];
      if (!own) continue;
      const crossings = [];
      for (const [a, b] of own) {
        if ((a[1] <= scanY && b[1] > scanY) || (b[1] <= scanY && a[1] > scanY)) {
          const t = (scanY - a[1]) / (b[1] - a[1]);
          crossings.push([a[0] + (b[0] - a[0]) * t, b[1] > a[1] ? 1 : -1]);
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((left, right) => left[0] - right[0]);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i += 1) {
        winding += crossings[i][1];
        if (winding === 0) continue;
        coverSpan(coverage, width, crossings[i][0], crossings[i + 1][0], 1 / samples);
      }
    }
    applyCoverage(target, width, y, coverage, rgb, erase);
  }
}

/** Add the share of each pixel in `[from, to)` that a span covers. */
function coverSpan(coverage, width, from, to, weight) {
  const x0 = Math.max(0, from);
  const x1 = Math.min(width, to);
  if (x1 <= x0) return;
  const first = Math.floor(x0);
  const last = Math.ceil(x1) - 1;
  for (let x = first; x <= last; x += 1) {
    const left = Math.max(x, x0);
    const right = Math.min(x + 1, x1);
    if (right > left) coverage[x] += (right - left) * weight;
  }
}

/** Paint (or erase) one row from the coverage it collected. */
function applyCoverage(target, width, y, coverage, rgb, erase) {
  const row = y * width;
  for (let x = 0; x < width; x += 1) {
    const cover = coverage[x];
    if (cover <= 0) continue;
    const alpha = Math.min(255, Math.round(cover * 255));
    if (alpha <= 0) continue;
    const at = (row + x) * 4;
    if (erase) {
      target[at + 3] = Math.round(target[at + 3] * (1 - alpha / 255));
      continue;
    }
    target[at] = rgb[0];
    target[at + 1] = rgb[1];
    target[at + 2] = rgb[2];
    if (alpha > target[at + 3]) target[at + 3] = alpha;
  }
}

/**
 * Paint or erase one stroke's shape into a straight-alpha RGBA buffer.
 *
 * `asMask` paints the shape of the stroke even when it is an eraser: a stroke
 * that is painted into a mask of its own first is taken out of the drawing
 * afterwards, with the strength of the stroke.
 */
function paintStrokeInto(target, width, height, stroke, rgb, asMask = false, scale = 1) {
  const erase = !asMask && stroke.eraser === true;

  // A closed filled contour (the ink of a brush in a legacy .fla, or a filled
  // shape) covers the region it outlines, not a line around it.
  if (stroke.kind === "path") {
    fillPathInto(target, width, height, stroke, rgb, erase, scale);
    return;
  }

  // A filled region made of several subpaths (a legacy .fla fill style): all
  // subpaths are filled together so their winding numbers combine — an inner
  // contour whose winding opposes the outer one carves a hole, the way Flash
  // fills a shape. `stroke.paths` is an array of point arrays.
  if (stroke.kind === "paths") {
    fillPathsInto(target, width, height, stroke.paths, rgb, erase, scale);
    return;
  }

  // The brush of the stroke itself, or the brush of the drawing for strokes
  // that were made before a stroke remembered its brush.
  const brush = "brush" in stroke ? stroke.brush ?? null : drawingBrush;
  brushStamp = stampFor(brush);
  strokeStyle = styleOfBrush(brush);
  strokeTipShape = typeof stroke.tip === "string" ? stroke.tip : "circle";
  grainInk = strokeStyle.grain ? grainSampler(grainPictureFor(strokeStyle.grain), strokeStyle.grain) : null;

  const outline =
    stroke.kind === "ellipse"
      ? sampleEllipse(
          stroke.points[0][0], stroke.points[0][1],
          stroke.points[1][0], stroke.points[1][1],
        )
      : null;
  if (stroke.kind === "ellipse" && !outline) return;

  const dabs = strokeDabs(stroke, strokeStyle, outline);
  // The path of the stroke is in the units of the document, so a picture that
  // is painted larger takes every dab with it: where it sits and how big it is.
  if (scale !== 1) {
    for (const dab of dabs) {
      dab.x *= scale;
      dab.y *= scale;
      dab.r *= scale;
    }
  }
  for (const dab of dabs) {
    paintDab(target, width, height, dab, rgb, erase);
  }
}

/** True when the stroke cannot be painted directly (needs a mask pass). */
function needsMaskPass(stroke) {
  if (stroke.opacity !== undefined && stroke.opacity < 1) return true;
  if (stroke.blend !== undefined && stroke.blend !== "normal") return true;
  // A stroke that is drawn on paper is painted into a mask of its own, so
  // that the grain can be taken out of the whole stroke in one place: the
  // dabs of a stroke must not each be eaten by the paper on their own, or
  // the overlaps would keep their ink and the grain would disappear.
  const brush = "brush" in stroke ? stroke.brush ?? null : drawingBrush;
  return Boolean(brush?.grain?.data);
}

/**
 * Take the grain of the paper out of a stroke that was painted into a mask.
 *
 * The paint is kept where the paper holds ink and taken away where the paper
 * is clear. The grain is read in the place of the pixel in the document, so
 * the same brush drawn twice leaves the same holes in the same places.
 */
function applyGrainToMask(mask, width, height, grain, scale = 1) {
  const picture = grainPictureFor(grain);
  if (!picture) return;
  const ink = grainSampler(picture, grain);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4 + 3;
      if (mask[at] === 0) continue;
      // The grain is a picture of the document, so it is read at the place of
      // the pixel in the document even when the drawing is painted larger.
      mask[at] = Math.round(mask[at] * ink((x + 0.5) / scale, (y + 0.5) / scale));
    }
  }
}

/**
 * The transform of a cell in the pixels of a picture drawn at `scale`.
 *
 * A transform is measured in the units of the document, so a picture that is
 * painted larger than the document needs its move scaled with it; the size and
 * the turn of the cell do not change.
 */
function scaledTransform(transform, scale) {
  if (scale === 1) return transform;
  const scaled = { ...transform, x: transform.x * scale, y: transform.y * scale };
  // The point a turn or a size pivots on sits in the units of the document
  // too, so it grows with the picture.
  const pivotX = Number(transform.pivotX);
  const pivotY = Number(transform.pivotY);
  if (Number.isFinite(pivotX)) scaled.pivotX = pivotX * scale;
  if (Number.isFinite(pivotY)) scaled.pivotY = pivotY * scale;
  return scaled;
}

/**
 * Paint a drawing (optional raster base + strokes) onto a transparent RGBA
 * buffer.
 *
 * `scale` says how many pixels of the buffer one unit of the document takes.
 * The exports use it to paint the picture at a size larger than the document,
 * so that a program that shows it larger than its own pixels - Clip Studio
 * Paint fits a small canvas to the window - still has the detail to draw the
 * lines sharp.
 */
function paintDrawing(width, height, drawing, scale = 1, placement) {
  // A drawing may carry a brush image; it is the brush that is in the hand
  // for the time of this drawing. A stroke remembers the brush it was made
  // with, so changing the brush does not change the strokes that are already
  // on the paper. A layer can have no drawing at the frame that is being
  // painted - an empty layer, or a frame the layer does not cover - and that
  // paints nothing rather than failing.
  drawingBrush = drawing ? drawing.brush ?? null : null;
  try {
    const paint = paintDrawingInner(width, height, drawing, scale);
    // A cell may sit somewhere else than it was drawn: moved, made bigger or
    // smaller, and turned. There is no canvas to draw on here, so the
    // picture is put where the transform says in pixels. A caller that
    // moves the picture itself passes the place that is to be used; a
    // placement of `null` leaves the picture where it was drawn, in its own
    // space.
    const place = placement === undefined ? transformOf(drawing) : placement;
    if (!place || isPlain(place)) return paint;
    return transformRgba(
      paint,
      width,
      height,
      composeMatrix([scaledTransform(place, scale)], width, height),
    );
  } finally {
    drawingBrush = null;
    brushStamp = null;
  }
}

function paintDrawingInner(width, height, drawing, scale = 1) {
  const paint = new Uint8Array(width * height * 4);
  if (!drawing) return paint;

  // A drawing may carry a raster base (imported .tvpp frames). It sits under
  // the strokes, so eraser strokes can reveal it or wipe it like any paint.
  if (drawing.image) {
    // The image travels as base64 when it comes over the wire, and as raw
    // bytes once it has been decoded, so both are accepted here.
    const source = typeof drawing.image.data === "string"
      ? drawing.image.data
      : drawing.image.data;
    const image = decodePicture(source);
    if (drawing.image.x !== undefined || drawing.image.y !== undefined) {
      // A trimmed picture carries the box of the canvas it was cut from: it
      // is put back there, at its own size, scaled with the drawing.
      const drawWidth = Math.max(1, Math.round(image.width * scale));
      const drawHeight = Math.max(1, Math.round(image.height * scale));
      const placed = drawWidth === image.width && drawHeight === image.height
        ? image.data
        : scaleRgba(image.data, image.width, image.height, drawWidth, drawHeight);
      blitRgba(
        paint,
        width,
        height,
        placed,
        drawWidth,
        drawHeight,
        Math.round((drawing.image.x ?? 0) * scale),
        Math.round((drawing.image.y ?? 0) * scale),
      );
    } else if (image.width === width && image.height === height) {
      paint.set(image.data);
    } else {
      // The picture is kept at the size of the document, so a drawing painted
      // larger takes the picture with it.
      paint.set(
        image.width > width || image.height > height
          ? downsampleRgba(image.data, image.width, image.height, width, height)
          : scaleRgba(image.data, image.width, image.height, width, height),
      );
    }
  }

  for (const stroke of drawing.strokes) {
    const rgb = parseHex(stroke.color);

    if (stroke.kind === "fill") {
      const mask = clipMaskFromSpans(stroke.clip, width, height, scale);
      const seedX = stroke.points[0][0] * scale;
      const seedY = stroke.points[0][1] * scale;
      if (stroke.gap > 0) {
        floodFillWithGaps(
          paint, width, height,
          seedX, seedY, rgb, stroke.gap * scale,
          undefined, undefined, mask,
        );
      } else {
        floodFillRgba(
          paint, width, height,
          seedX, seedY, rgb,
          undefined, undefined, mask,
        );
      }
      continue;
    }

    // Transparent or blending strokes are painted opaque into a mask buffer
    // first, then applied to the drawing in one pass — otherwise a stamped
    // stroke's overlapping discs would darken each other.
    if (needsMaskPass(stroke)) {
      const mask = new Uint8Array(width * height * 4);
      paintStrokeInto(mask, width, height, stroke, rgb, true, scale);
      const brush = "brush" in stroke ? stroke.brush ?? null : drawingBrush;
      if (brush?.grain?.data) applyGrainToMask(mask, width, height, brush.grain, scale);
      if (stroke.eraser === true) eraseStrokeFrom(paint, mask, stroke.opacity ?? 1);
      else blendStrokeOver(paint, mask, stroke.opacity ?? 1, stroke.blend ?? "normal");
      continue;
    }

    paintStrokeInto(paint, width, height, stroke, rgb, false, scale);
  }

  return paint;
}

/** Kept for compatibility: same painter, stroke list only. */
function paintStrokes(width, height, strokes) {
  return paintDrawing(width, height, { image: null, strokes });
}

/** Alpha-composite an RGBA image over an RGB buffer. */
function composite(data, width, height, image, opacity = 1) {
  if (image.width !== width || image.height !== height) {
    throw new Error("image size must match the canvas");
  }
  if (opacity <= 0) return;

  const source = image.data;

  // The usual case is a layer that is drawn at full strength, and most of
  // its pixels are solid. Those pixels are copied as they are, without the
  // arithmetic of blending, which is what a big canvas spends its time on.
  if (opacity === 1) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      const alpha = source[j + 3];
      if (alpha === 0) continue;
      if (alpha === 255) {
        data[i] = source[j];
        data[i + 1] = source[j + 1];
        data[i + 2] = source[j + 2];
        continue;
      }
      const blend = alpha / 255;
      data[i] = Math.round(source[j] * blend + data[i] * (1 - blend));
      data[i + 1] = Math.round(source[j + 1] * blend + data[i + 1] * (1 - blend));
      data[i + 2] = Math.round(source[j + 2] * blend + data[i + 2] * (1 - blend));
    }
    return;
  }

  // The opacity of a layer is written to the file as whole units of 1/256.
  // The preview reads the layer opacity the same way, so the picture drawn
  // here is the picture the file holds instead of one that differs by a step
  // at the soft edge of a half-transparent layer.
  const opa = Math.round(opacity * 256) / 256;
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const alpha = (source[j + 3] / 255) * opa;
    if (alpha === 0) continue;
    data[i] = Math.round(source[j] * alpha + data[i] * (1 - alpha));
    data[i + 1] = Math.round(source[j + 1] * alpha + data[i + 1] * (1 - alpha));
    data[i + 2] = Math.round(source[j + 2] * alpha + data[i + 2] * (1 - alpha));
  }
}

/**
 * The size of a rendered frame.
 *
 * With a camera track the frame is what the camera sees, so the output
 * matches the camera window; without one it is the canvas size.
 */
export function outputSize(project, frame = project.currentFrame) {
  const camera = cameraAt(project.camera, frame);
  if (!camera) return { width: project.width, height: project.height };
  return {
    width: Math.max(1, Math.round(camera.width)),
    height: Math.max(1, Math.round(camera.height)),
  };
}

/** Bilinear sample of a straight-alpha RGBA buffer, at a fractional position. */
function sampleRgba(data, width, height, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const read = (px, py, channel) => {
    const cx = Math.min(width - 1, Math.max(0, px));
    const cy = Math.min(height - 1, Math.max(0, py));
    return data[(cy * width + cx) * 4 + channel];
  };
  const out = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel += 1) {
    const top = read(x0, y0, channel) * (1 - fx) + read(x0 + 1, y0, channel) * fx;
    const bottom = read(x0, y0 + 1, channel) * (1 - fx) + read(x0 + 1, y0 + 1, channel) * fx;
    out[channel] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/**
 * Crop a straight-alpha RGBA buffer to the camera window and scale it to the
 * camera's own pixel size. A rotated window is sampled back through the
 * rotation, so the export is the shot the camera takes.
 */
export function cropToCamera(rgba, project, frame = project.currentFrame) {
  const camera = cameraAt(project.camera, frame);
  if (!camera) return rgba;
  const out = outputSize(project, frame);
  const buffer = new Uint8Array(out.width * out.height * 4);
  const stepX = camera.width / out.width;
  const stepY = camera.height / out.height;
  // The content turns with the camera, so the window's own space is turned
  // back to find the pixel it looks at.
  const angle = -((Number(camera.rotation) || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centreX = camera.x + camera.width / 2;
  const centreY = camera.y + camera.height / 2;

  for (let y = 0; y < out.height; y += 1) {
    const localY = (y + 0.5) * stepY - camera.height / 2;
    for (let x = 0; x < out.width; x += 1) {
      const localX = (x + 0.5) * stepX - camera.width / 2;
      const sourceX = centreX + localX * cos - localY * sin;
      const sourceY = centreY + localX * sin + localY * cos;
      const pixel = sampleRgba(rgba, project.width, project.height, sourceX, sourceY);
      const index = (y * out.width + x) * 4;
      buffer[index] = Math.round(pixel[0]);
      buffer[index + 1] = Math.round(pixel[1]);
      buffer[index + 2] = Math.round(pixel[2]);
      buffer[index + 3] = Math.round(pixel[3]);
    }
  }
  return buffer;
}

/**
 * The transforms that move a layer: the ones of the folders above it, and
 * its own.
 *
 * A cell that is a folder of layers is moved as a whole, so the layers
 * inside it are moved with it.
 */
export function transformsOf(project, index) {
  const transforms = [];
  const seen = new Set();
  let at = index;
  while (at >= 0 && at < project.layers.length && !seen.has(at)) {
    seen.add(at);
    const layer = project.layers[at];
    if (layer?.transform) transforms.unshift(layer.transform);
    at = Number.isInteger(layer?.parent) ? layer.parent : -1;
  }
  return transforms;
}

/**
 * Render one frame of a validated project to an RGB byte buffer.
 *
 * Layers are stored top-to-bottom (the timeline shows the top layer first),
 * so they are composited in reverse order. Eraser strokes only clear paint
 * inside their own layer; lower layers and the imported image stay visible.
 */
export function renderProject(project, frame = project.currentFrame) {
  const { width, height } = project;

  const data = new Uint8Array(width * height * 3);
  const background = parseHex(project.background);

  for (let i = 0; i < data.length; i += 3) {
    data[i] = background[0];
    data[i + 1] = background[1];
    data[i + 2] = background[2];
  }

  if (project.image) {
    composite(data, width, height, decodePicture(project.image.data));
  }

  for (let index = project.layers.length - 1; index >= 0; index -= 1) {
    const layer = project.layers[index];
    // A folder paints nothing of its own: the layers inside it paint, and a
    // folder that is a cel of an animation folder carries the cel only to
    // say where it sits on the track.
    if (layer.type === "group") continue;
    // A layer inside a folder that is hidden is hidden too, and the opacity
    // of the folders above it counts, the way Clip Studio Paint paints it.
    if (!layerIsVisible(project, index)) continue;
    const opacity = effectiveOpacity(project, index);
    if (opacity <= 0) continue;

    const resolved = resolveDrawing(layer, frame);
    if (!resolved) continue;

    // A drawing that is only a picture does not have to be copied into a
    // buffer of its own first: the picture can go onto the canvas as it
    // is. That saves a copy of the whole canvas for every imported layer.
    const paint = directPicture(resolved.drawing, width, height) ??
      paintDrawing(width, height, resolved.drawing, 1, null);
    // A layer may be moved, made bigger or turned - a cell that is a folder
    // of layers is moved as a whole - and so may the cell of its own: a cell
    // that tweens is where its walk along the span says, the way the
    // playhead asks for. The picture of the cell is moved with all of them.
    const moved = transformRgba(
      paint,
      width,
      height,
      composeMatrix(
        [...transformsOf(project, index), transformAt(resolved.drawing, resolved.sourceFrame)],
        width,
        height,
      ),
    );
    composite(data, width, height, { width, height, data: moved }, opacity);
  }

  // A camera track frames the shot: the exported image is what the camera
  // sees, cropped and scaled to the camera window.
  const camera = cameraAt(project.camera, frame);
  if (camera) {
    const out = outputSize(project, frame);
    return {
      width: out.width,
      height: out.height,
      data: cropRgbToCamera(data, width, height, camera, out.width, out.height),
    };
  }

  return { width, height, data };
}

/** Bilinear crop and scale of an RGB buffer to the camera window. */
function cropRgbToCamera(data, width, height, camera, outWidth, outHeight) {
  const out = new Uint8Array(outWidth * outHeight * 3);
  const stepX = camera.width / outWidth;
  const stepY = camera.height / outHeight;
  const angle = -((Number(camera.rotation) || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centreX = camera.x + camera.width / 2;
  const centreY = camera.y + camera.height / 2;
  const read = (x, y, channel) => {
    const cx = Math.min(width - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(height - 1, Math.max(0, Math.round(y)));
    return data[(cy * width + cx) * 3 + channel];
  };

  for (let y = 0; y < outHeight; y += 1) {
    const localY = (y + 0.5) * stepY - camera.height / 2;
    for (let x = 0; x < outWidth; x += 1) {
      const localX = (x + 0.5) * stepX - camera.width / 2;
      const sourceX = centreX + localX * cos - localY * sin;
      const sourceY = centreY + localX * sin + localY * cos;
      const index = (y * outWidth + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        out[index + channel] = read(sourceX, sourceY, channel);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  // An indexed loop, not for..of: a canvas-sized payload runs this over
  // millions of bytes, and the iterator protocol costs twenty times more
  // than the plain loop on the same work.
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode an RGB buffer as a PNG (colour type 2, 8 bits per channel). */
/**
 * Scale an RGB picture.
 *
 * The export can write the frames smaller or larger than the canvas, the way
 * the resize field of Umoupen's export panel does. The picture is sampled
 * with a bilinear filter, so a smaller picture keeps the lines of the drawing.
 */
export function scaleRgb(rgb, width, height, outWidth, outHeight) {
  if (outWidth === width && outHeight === height) return rgb;
  const out = new Uint8Array(outWidth * outHeight * 3);
  const stepX = width / outWidth;
  const stepY = height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.max(0, (y + 0.5) * stepY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < outWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, (x + 0.5) * stepX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sourceX - x0;
      const to = (y * outWidth + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const top =
          rgb[(y0 * width + x0) * 3 + channel] * (1 - fx) +
          rgb[(y0 * width + x1) * 3 + channel] * fx;
        const bottom =
          rgb[(y1 * width + x0) * 3 + channel] * (1 - fx) +
          rgb[(y1 * width + x1) * 3 + channel] * fx;
        out[to + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

/**
 * Cut the transparent border off a picture.
 *
 * The picture of an imported cel usually paints in a small part of the
 * canvas: the rest is transparent, and a full-canvas picture of a 4K
 * document costs tens of megabytes once decoded - per cel. What comes back
 * is the smallest box that still holds every painted pixel, with the place
 * of the box in the original picture, so the caller can put it back where
 * it was. A picture with no painted pixel answers null.
 */
export function trimRgbaToAlphaBBox(data, width, height) {
  let top = -1;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] !== 0) {
        if (top === -1) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right === -1) return null;

  const boxWidth = right - left + 1;
  const boxHeight = bottom - top + 1;
  const box = new Uint8Array(boxWidth * boxHeight * 4);
  for (let y = 0; y < boxHeight; y += 1) {
    const from = ((top + y) * width + left) * 4;
    box.set(data.subarray(from, from + boxWidth * 4), y * boxWidth * 4);
  }
  return { data: box, width: boxWidth, height: boxHeight, x: left, y: top };
}

/** Paste a picture into a buffer at a place, clipped to the buffer. */
function blitRgba(target, targetWidth, targetHeight, source, sourceWidth, sourceHeight, x, y) {
  const fromX = Math.max(0, x);
  const fromY = Math.max(0, y);
  const toX = Math.min(targetWidth, x + sourceWidth);
  const toY = Math.min(targetHeight, y + sourceHeight);
  for (let row = fromY; row < toY; row += 1) {
    const from = ((row - y) * sourceWidth + (fromX - x)) * 4;
    target.set(
      source.subarray(from, from + (toX - fromX) * 4),
      (row * targetWidth + fromX) * 4,
    );
  }
}

/**
 * Scale a straight-alpha RGBA picture.
 *
 * The picture is sampled with a bilinear filter, so a picture that is made
 * smaller keeps its speckle.
 */
export function scaleRgba(rgba, width, height, outWidth, outHeight) {
  if (outWidth === width && outHeight === height) return rgba;
  const out = new Uint8Array(outWidth * outHeight * 4);
  const stepX = width / outWidth;
  const stepY = height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.max(0, (y + 0.5) * stepY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < outWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, (x + 0.5) * stepX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sourceX - x0;
      const to = (y * outWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top =
          rgba[(y0 * width + x0) * 4 + channel] * (1 - fx) +
          rgba[(y0 * width + x1) * 4 + channel] * fx;
        const bottom =
          rgba[(y1 * width + x0) * 4 + channel] * (1 - fx) +
          rgba[(y1 * width + x1) * 4 + channel] * fx;
        out[to + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

/**
 * Make a smaller straight-alpha RGBA picture with an area filter.
 *
 * This is used for the reduced mipmap levels of a `.clip` layer. A thin line
 * often covers only part of a source pixel, so every output pixel is the
 * average of the whole source area it covers. The colour is averaged with
 * the alpha, which keeps the soft edge of a line from picking up a dark or
 * bright fringe.
 */
export function downsampleRgba(rgba, width, height, outWidth, outHeight) {
  if (outWidth === width && outHeight === height) return rgba;
  if (outWidth > width || outHeight > height) {
    return scaleRgba(rgba, width, height, outWidth, outHeight);
  }

  const out = new Uint8Array(outWidth * outHeight * 4);
  const ratioX = width / outWidth;
  const ratioY = height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const firstY = Math.floor(y * ratioY);
    const lastY = Math.max(firstY + 1, Math.ceil((y + 1) * ratioY));
    for (let x = 0; x < outWidth; x += 1) {
      const firstX = Math.floor(x * ratioX);
      const lastX = Math.max(firstX + 1, Math.ceil((x + 1) * ratioX));
      let alphaSum = 0;
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;
      let count = 0;

      for (let sourceY = firstY; sourceY < lastY && sourceY < height; sourceY += 1) {
        for (let sourceX = firstX; sourceX < lastX && sourceX < width; sourceX += 1) {
          const at = (sourceY * width + sourceX) * 4;
          const alpha = rgba[at + 3];
          alphaSum += alpha;
          redSum += rgba[at] * alpha;
          greenSum += rgba[at + 1] * alpha;
          blueSum += rgba[at + 2] * alpha;
          count += 1;
        }
      }

      const to = (y * outWidth + x) * 4;
      if (count === 0 || alphaSum === 0) {
        out[to + 3] = 0;
        continue;
      }
      out[to] = Math.round(redSum / alphaSum);
      out[to + 1] = Math.round(greenSum / alphaSum);
      out[to + 2] = Math.round(blueSum / alphaSum);
      out[to + 3] = Math.round(alphaSum / count);
    }
  }
  return out;
}

/**
 * Downsample one rectangle of a picture, with pixels exactly the ones
 * `downsampleRgba` would make for the whole picture at this size.
 *
 * `box` is the rectangle in the coordinates of the smaller picture,
 * inclusive on every side. The returned buffer holds only that rectangle,
 * and its `width` tells the stride: the pixel of the box corner sits at
 * `(0, 0)` of the buffer. The writer uses it so that a small drawing on a
 * large canvas costs the work of the drawing, not of the canvas.
 */
export function downsampleRgbaRegion(rgba, width, height, outWidth, outHeight, box) {
  const regionWidth = box.x1 - box.x0 + 1;
  const regionHeight = box.y1 - box.y0 + 1;
  const out = new Uint8Array(regionWidth * regionHeight * 4);
  const ratioX = width / outWidth;
  const ratioY = height / outHeight;
  if (Number.isInteger(ratioX) && Number.isInteger(ratioY) && ratioX >= 1 && ratioY >= 1) {
    // The usual walk of the mips: a whole number of source pixels for every
    // one of the level, so the area of each is known without rounding. The
    // pixels are the same ones the general path below would make.
    for (let y = box.y0; y <= box.y1; y += 1) {
      const firstY = y * ratioY;
      const lastY = firstY + ratioY;
      for (let x = box.x0; x <= box.x1; x += 1) {
        const firstX = x * ratioX;
        const lastX = firstX + ratioX;
        let alphaSum = 0;
        let redSum = 0;
        let greenSum = 0;
        let blueSum = 0;
        let count = 0;
        for (let sourceY = firstY; sourceY < lastY; sourceY += 1) {
          let at = (sourceY * width + firstX) * 4;
          for (let sourceX = firstX; sourceX < lastX; sourceX += 1, at += 4) {
            const alpha = rgba[at + 3];
            alphaSum += alpha;
            redSum += rgba[at] * alpha;
            greenSum += rgba[at + 1] * alpha;
            blueSum += rgba[at + 2] * alpha;
            count += 1;
          }
        }
        const to = ((y - box.y0) * regionWidth + (x - box.x0)) * 4;
        if (count === 0 || alphaSum === 0) {
          out[to + 3] = 0;
          continue;
        }
        out[to] = Math.round(redSum / alphaSum);
        out[to + 1] = Math.round(greenSum / alphaSum);
        out[to + 2] = Math.round(blueSum / alphaSum);
        out[to + 3] = Math.round(alphaSum / count);
      }
    }
    return out;
  }
  for (let y = box.y0; y <= box.y1; y += 1) {
    const firstY = Math.floor(y * ratioY);
    const lastY = Math.max(firstY + 1, Math.ceil((y + 1) * ratioY));
    for (let x = box.x0; x <= box.x1; x += 1) {
      const firstX = Math.floor(x * ratioX);
      const lastX = Math.max(firstX + 1, Math.ceil((x + 1) * ratioX));
      let alphaSum = 0;
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;
      let count = 0;

      for (let sourceY = firstY; sourceY < lastY && sourceY < height; sourceY += 1) {
        for (let sourceX = firstX; sourceX < lastX && sourceX < width; sourceX += 1) {
          const at = (sourceY * width + sourceX) * 4;
          const alpha = rgba[at + 3];
          alphaSum += alpha;
          redSum += rgba[at] * alpha;
          greenSum += rgba[at + 1] * alpha;
          blueSum += rgba[at + 2] * alpha;
          count += 1;
        }
      }

      const to = ((y - box.y0) * regionWidth + (x - box.x0)) * 4;
      if (count === 0 || alphaSum === 0) {
        out[to + 3] = 0;
        continue;
      }
      out[to] = Math.round(redSum / alphaSum);
      out[to + 1] = Math.round(greenSum / alphaSum);
      out[to + 2] = Math.round(blueSum / alphaSum);
      out[to + 3] = Math.round(alphaSum / count);
    }
  }
  return out;
}

export function encodePng(width, height, data) {
  if (data.length !== width * height * 3) {
    throw new Error("pixel buffer does not match the image size");
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Render one layer's resolved drawing as straight-alpha RGBA. */
export function renderLayerRgba(project, layer, frame = project.currentFrame, scale = 1) {
  const resolved = resolveDrawing(layer, frame);
  return paintDrawing(
    Math.round(project.width * scale),
    Math.round(project.height * scale),
    resolved ? resolved.drawing : null,
    scale,
  );
}

/** Render one drawing object as straight-alpha RGBA (used by the .tvpp writer). */
export function renderDrawingRgba(project, drawing, scale = 1) {
  return paintDrawing(
    Math.round(project.width * scale),
    Math.round(project.height * scale),
    drawing,
    scale,
  );
}
/** Encode an RGBA buffer as a PNG (colour type 6, 8 bits per channel). */
export function encodeRgbaPng(width, height, data, options = {}) {
  if (data.length !== width * height * 4) {
    throw new Error("pixel buffer does not match the image size");
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, options)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function renderPng(project) {
  const { width, height, data } = renderProject(project);
  return { buffer: encodePng(width, height, data), width, height };
}
