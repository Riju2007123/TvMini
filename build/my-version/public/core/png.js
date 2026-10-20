import { resolveDrawing } from "../timeline.js";
import { Buffer } from "./bytes.js";
import { blendStrokeOver, eraseStrokeFrom, floodFillRgba, sampleEllipse } from "./paint.js";
import { deflateSync, inflateSync } from "./zlib.js";

function parseHex(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function setPixel(layer, width, height, x, y, rgb, erase) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return;
  const index = (py * width + px) * 4;

  if (erase) {
    layer[index + 3] = 0;
    return;
  }

  layer[index] = rgb[0];
  layer[index + 1] = rgb[1];
  layer[index + 2] = rgb[2];
  layer[index + 3] = 255;
}

/** Paint or erase a disc with hard edges (distance test) inside a bounding box. */
function disc(layer, width, height, cx, cy, radius, rgb, erase) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  const r2 = radius * radius;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setPixel(layer, width, height, x, y, rgb, erase);
    }
  }
}

/** Smallest fraction of the brush width used at zero pressure. */
export const MIN_PRESSURE_SCALE = 0.2;

/** Radius of one point: constant, or tapered by the optional pressure value. */
function pointRadius(stroke, point) {
  const base = stroke.width / 2;
  const radius =
    point.length === 3
      ? base * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * point[2])
      : base;
  return Math.max(0.5, radius);
}

/** Paint or erase a segment by sampling discs with linearly interpolated radius. */
function segment(layer, width, height, [x0, y0], [x1, y1], r0, r1, rgb, erase) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const step = Math.max(0.5, Math.min(r0, r1) / 2);
  const steps = Math.max(1, Math.ceil(length / step));

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    disc(layer, width, height, x0 + dx * t, y0 + dy * t, r0 + (r1 - r0) * t, rgb, erase);
  }
}

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

/** Paint or erase one stroke's shape into a straight-alpha RGBA buffer. */
function paintStrokeInto(target, width, height, stroke, rgb) {
  const erase = stroke.eraser === true;
  const radii = stroke.points.map((point) => pointRadius(stroke, point));

  if (stroke.kind === "line") {
    segment(
      target, width, height,
      stroke.points[0], stroke.points[1], radii[0], radii[1], rgb, erase,
    );
    return;
  }

  if (stroke.kind === "rect") {
    const [x0, y0] = stroke.points[0];
    const [x1, y1] = stroke.points[1];
    const radius = radii[0];
    segment(target, width, height, [x0, y0], [x1, y0], radius, radius, rgb, erase);
    segment(target, width, height, [x1, y0], [x1, y1], radius, radius, rgb, erase);
    segment(target, width, height, [x1, y1], [x0, y1], radius, radius, rgb, erase);
    segment(target, width, height, [x0, y1], [x0, y0], radius, radius, rgb, erase);
    return;
  }

  if (stroke.kind === "ellipse") {
    const outline = sampleEllipse(
      stroke.points[0][0], stroke.points[0][1], stroke.points[1][0], stroke.points[1][1],
    );
    if (!outline) return;
    const radius = radii[0];
    for (let i = 0; i < outline.length; i += 1) {
      const from = outline[i];
      const to = outline[(i + 1) % outline.length];
      segment(target, width, height, from, to, radius, radius, rgb, erase);
    }
    return;
  }

  // Freehand.
  if (stroke.points.length === 1) {
    disc(target, width, height, stroke.points[0][0], stroke.points[0][1], radii[0], rgb, erase);
    return;
  }
  for (let i = 1; i < stroke.points.length; i += 1) {
    segment(
      target,
      width,
      height,
      stroke.points[i - 1],
      stroke.points[i],
      radii[i - 1],
      radii[i],
      rgb,
      erase,
    );
  }
}

/** True when the stroke cannot be painted directly (needs a mask pass). */
function needsMaskPass(stroke) {
  if (stroke.opacity !== undefined && stroke.opacity < 1) return true;
  return stroke.blend !== undefined && stroke.blend !== "normal";
}

/** Paint a drawing (optional raster base + strokes) onto a transparent RGBA buffer. */
function paintDrawing(width, height, drawing) {
  const paint = new Uint8Array(width * height * 4);
  if (!drawing) return paint;

  // A drawing may carry a raster base (imported .tvpp frames). It sits under
  // the strokes, so eraser strokes can reveal it or wipe it like any paint.
  if (drawing.image) {
    const image = decodePng(drawing.image.data);
    paint.set(image.data);
  }

  for (const stroke of drawing.strokes) {
    const rgb = parseHex(stroke.color);

    if (stroke.kind === "fill") {
      floodFillRgba(
        paint, width, height,
        stroke.points[0][0], stroke.points[0][1], rgb,
      );
      continue;
    }

    // Transparent or blending strokes are painted opaque into a mask buffer
    // first, then applied to the drawing in one pass — otherwise a stamped
    // stroke's overlapping discs would darken each other.
    if (needsMaskPass(stroke)) {
      const mask = new Uint8Array(width * height * 4);
      paintStrokeInto(mask, width, height, stroke, rgb);
      if (stroke.eraser === true) eraseStrokeFrom(paint, mask, stroke.opacity ?? 1);
      else blendStrokeOver(paint, mask, stroke.opacity ?? 1, stroke.blend ?? "normal");
      continue;
    }

    paintStrokeInto(paint, width, height, stroke, rgb);
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

  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const alpha = (image.data[j + 3] / 255) * opacity;
    if (alpha === 0) continue;
    data[i] = Math.round(image.data[j] * alpha + data[i] * (1 - alpha));
    data[i + 1] = Math.round(image.data[j + 1] * alpha + data[i + 1] * (1 - alpha));
    data[i + 2] = Math.round(image.data[j + 2] * alpha + data[i + 2] * (1 - alpha));
  }
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
    composite(data, width, height, decodePng(Buffer.from(project.image.data, "base64")));
  }

  for (let index = project.layers.length - 1; index >= 0; index -= 1) {
    const layer = project.layers[index];
    if (!layer.visible || layer.opacity <= 0) continue;

    const resolved = resolveDrawing(layer, frame);
    if (!resolved) continue;

    const paint = paintDrawing(width, height, resolved.drawing);
    composite(data, width, height, { width, height, data: paint }, layer.opacity);
  }

  return { width, height, data };
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
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
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
export function renderLayerRgba(project, layer, frame = project.currentFrame) {
  const resolved = resolveDrawing(layer, frame);
  return paintDrawing(project.width, project.height, resolved ? resolved.drawing : null);
}

/** Render one drawing object as straight-alpha RGBA (used by the .tvpp writer). */
export function renderDrawingRgba(project, drawing) {
  return paintDrawing(project.width, project.height, drawing);
}

/** Encode an RGBA buffer as a PNG (colour type 6, 8 bits per channel). */
export function encodeRgbaPng(width, height, data) {
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
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function renderPng(project) {
  const { width, height, data } = renderProject(project);
  return { buffer: encodePng(width, height, data), width, height };
}
