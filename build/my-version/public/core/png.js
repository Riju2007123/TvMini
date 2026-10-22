import { cameraAt, effectiveOpacity, layerIsVisible, resolveDrawing } from "../timeline.js";
import { Buffer } from "./bytes.js";
import {
  blendStrokeOver,
  eraseStrokeFrom,
  floodFillRgba,
  sampleEllipse,
  strokeRadii as sharedStrokeRadii,
} from "./paint.js";
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

/** Paint one pixel of the mask with a coverage that is not full. */
function setPixelAlpha(layer, width, height, x, y, rgb, alpha, erase) {
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
  if (alpha > layer[index + 3]) layer[index + 3] = alpha;
}

/**
 * Paint the brush image instead of a disc.
 *
 * The image is fitted to the size of the brush, the way Clip Studio Paint
 * fits a brush texture, and its alpha is the coverage of every pixel. The
 * image keeps its own shape: it is as tall as the brush is wide, and its
 * width follows from that.
 */
function stamp(layer, width, height, cx, cy, radius, rgb, erase, brush) {
  const boxHeight = Math.max(1, radius * 2);
  const boxWidth = boxHeight * (brush.width / Math.max(1, brush.height));
  const x0 = Math.max(0, Math.floor(cx - boxWidth / 2));
  const x1 = Math.min(width - 1, Math.ceil(cx + boxWidth / 2));
  const y0 = Math.max(0, Math.floor(cy - boxHeight / 2));
  const y1 = Math.min(height - 1, Math.ceil(cy + boxHeight / 2));
  const stepX = brush.width / boxWidth;
  const stepY = brush.height / boxHeight;
  const left = cx - boxWidth / 2;
  const top = cy - boxHeight / 2;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const sx = Math.min(brush.width - 1, Math.floor((x + 0.5 - left) * stepX));
      const sy = Math.min(brush.height - 1, Math.floor((y + 0.5 - top) * stepY));
      const alpha = brush.alpha[sy * brush.width + sx];
      if (alpha === 0) continue;
      setPixelAlpha(layer, width, height, x, y, rgb, alpha, erase);
    }
  }
}

/** Paint or erase a disc with hard edges (distance test) inside a bounding box. */
function disc(layer, width, height, cx, cy, radius, rgb, erase) {
  if (brushStamp) {
    stamp(layer, width, height, cx, cy, radius, rgb, erase, brushStamp);
    return;
  }
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

/**
 * The width of a stroke at every one of its points.
 *
 * The ends of the stroke are thin, the way the brush of Clip Studio Paint
 * tapers in and out.
 */
function strokeRadii(stroke) {
  return sharedStrokeRadii(stroke, stroke.taper ?? 0);
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
const PICTURE_CACHE_LIMIT = 128 * 1024 * 1024;

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
  const picture = decodePicture(drawing.image.data);
  if (picture.width !== width || picture.height !== height) return null;
  return picture.data;
}

/** Paint or erase one stroke's shape into a straight-alpha RGBA buffer. */
function paintStrokeInto(target, width, height, stroke, rgb) {
  const erase = stroke.eraser === true;
  const radii = strokeRadii(stroke);
  // The brush of the stroke itself, or the brush of the drawing for strokes
  // that were made before a stroke remembered its brush.
  brushStamp = stampFor("brush" in stroke ? stroke.brush ?? null : drawingBrush);

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
  // A drawing may carry a brush image; it is the brush that is in the hand
  // for the time of this drawing. A stroke remembers the brush it was made
  // with, so changing the brush does not change the strokes that are already
  // on the paper. A layer can have no drawing at the frame that is being
  // painted - an empty layer, or a frame the layer does not cover - and that
  // paints nothing rather than failing.
  drawingBrush = drawing ? drawing.brush ?? null : null;
  try {
    return paintDrawingInner(width, height, drawing);
  } finally {
    drawingBrush = null;
    brushStamp = null;
  }
}

function paintDrawingInner(width, height, drawing) {
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

  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const alpha = (source[j + 3] / 255) * opacity;
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
      paintDrawing(width, height, resolved.drawing);
    composite(data, width, height, { width, height, data: paint }, opacity);
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
