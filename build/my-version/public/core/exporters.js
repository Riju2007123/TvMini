/**
 * Frame-based exports: animated GIF, sprite sheet, image sequence (ZIP),
 * and the picture import that turns images or a GIF into a project.
 *
 * Every export renders through `renderProject`, so what is written is what
 * the canvas shows, camera included.
 */
import { Buffer } from "./bytes.js";
import { encodeGif } from "./gif.js";
import { decodeImage, encodeTga } from "./imageio.js";
import { createLayer, MIN_SIZE, normalizeProject } from "./model.js";
import { encodePng, encodeRgbaPng, renderProject, scaleRgb } from "./png.js";
import { contentEnd } from "../timeline.js";

/* ---------------------------------------------------------------- names */

/**
 * Fill in a file name pattern.
 *
 * `{name}` is the project name, `{frame}` the frame number, and
 * `{frame:4}` pads the number to four digits. An unknown `{word}` is kept
 * as written so a typo is visible in the result.
 */
export function expandPattern(pattern, values) {
  return String(pattern).replace(/\{(\w+)(?::(\d+))?\}/g, (whole, key, pad) => {
    if (!(key in values)) return whole;
    const value = String(values[key]);
    return pad ? value.padStart(Number(pad), "0") : value;
  });
}

/** Keep a file name safe on every platform. */
export function safeFileName(name) {
  const clean = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim();
  return clean.slice(0, 120) || "untitled";
}

/* --------------------------------------------------------------- frames */

/**
 * The frames an export covers.
 * `range` is "current", "all" or `{ from, to }`.
 */
export function frameRange(project, range = "all") {
  if (range === "current") return [project.currentFrame];
  const from = range === "all" ? project.startFrame : Math.max(project.startFrame, range.from);
  const to = range === "all" ? contentEnd(project) : Math.min(contentEnd(project), range.to);
  if (to < from) return [from];
  const frames = [];
  for (let frame = from; frame <= to; frame += 1) frames.push(frame);
  if (frames.length > 20000) throw new Error("too many frames to export at once");
  return frames;
}

/** Render frames; every one has to come out at the same size. */
export function renderFrames(project, frames, scale = 100) {
  const out = [];
  let size = null;
  const factor = Math.max(1, Math.min(400, Math.round(Number(scale) || 100))) / 100;
  for (const frame of frames) {
    const picture = renderProject(project, frame);
    const width = Math.max(1, Math.round(picture.width * factor));
    const height = Math.max(1, Math.round(picture.height * factor));
    const data = scaleRgb(picture.data, picture.width, picture.height, width, height);
    if (!size) size = { width, height };
    else if (width !== size.width || height !== size.height) {
      throw new Error("the camera changes size during this range; export a range where it stays the same");
    }
    out.push({ frame, width, height, data });
  }
  return { width: size.width, height: size.height, frames: out };
}

/* ------------------------------------------------------------------ GIF */

/** Animated GIF of a frame range at the project's frame rate. */
export function createGifBuffer(project, { range = "all", loop = project.loop ? 0 : 1, scale = 100 } = {}) {
  const { width, height, frames } = renderFrames(project, frameRange(project, range), scale);
  const delay = Math.max(2, Math.round(100 / project.fps));
  const buffer = encodeGif({ width, height, loop, frames: frames.map((f) => ({ rgb: f.data, delay })) });
  return { buffer, width, height, frames: frames.length };
}

/* ---------------------------------------------------------- sprite sheet */

/**
 * Every frame in a grid on one PNG, plus a JSON description of where each
 * frame sits (so a game can slice it).
 */
export function createSpriteSheet(project, { range = "all", columns = 0, name = "sheet", scale = 100 } = {}) {
  const { width, height, frames } = renderFrames(project, frameRange(project, range), scale);
  const cols = columns > 0 ? Math.min(columns, frames.length) : Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / cols);
  const sheetWidth = cols * width;
  const sheetHeight = rows * height;
  if (sheetWidth * sheetHeight > 100_000_000) throw new Error("the sprite sheet would be too large");

  const sheet = new Uint8Array(sheetWidth * sheetHeight * 3);
  frames.forEach((picture, index) => {
    const ox = (index % cols) * width;
    const oy = Math.floor(index / cols) * height;
    for (let y = 0; y < height; y += 1) {
      sheet.set(
        picture.data.subarray(y * width * 3, (y + 1) * width * 3),
        ((oy + y) * sheetWidth + ox) * 3,
      );
    }
  });

  const description = {
    name,
    image: `${name}.png`,
    fps: project.fps,
    frameWidth: width,
    frameHeight: height,
    columns: cols,
    rows,
    frames: frames.map((picture, index) => ({
      frame: picture.frame,
      x: (index % cols) * width,
      y: Math.floor(index / cols) * height,
      w: width,
      h: height,
    })),
  };
  return {
    png: encodePng(sheetWidth, sheetHeight, sheet),
    json: `${JSON.stringify(description, null, 2)}\n`,
    width: sheetWidth,
    height: sheetHeight,
    frames: frames.length,
    columns: cols,
    rows,
  };
}

/* ------------------------------------------------------------------ ZIP */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of stored (uncompressed) entries; fine for PNG/TGA, already packed. */
export function createZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const bytes = Buffer.from(data);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(0x00210000, 10); // DOS date 1980-01-01, time 0
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, bytes);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(0x00210000, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Read a stored-entry ZIP back (used by the tests). */
export function readZip(input) {
  const b = Buffer.from(input);
  const end = b.length - 22;
  if (b.readUInt32LE(end) !== 0x06054b50) throw new Error("not a ZIP file");
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i += 1) {
    const size = b.readUInt32LE(at + 24);
    const nameLength = b.readUInt16LE(at + 28);
    const localAt = b.readUInt32LE(at + 42);
    const name = b.toString("utf8", at + 46, at + 46 + nameLength);
    const start = localAt + 30 + b.readUInt16LE(localAt + 26) + b.readUInt16LE(localAt + 28);
    const data = b.subarray(start, start + size);
    if (crc32(data) !== b.readUInt32LE(at + 16)) throw new Error(`bad checksum for ${name}`);
    files.push({ name, data });
    at += 46 + nameLength;
  }
  return files;
}

/** Image sequence: one picture per frame, zipped. */
export function createSequenceZip(
  project,
  { range = "all", pattern = "{name}_{frame:4}", name = "frame", format = "png", scale = 100 } = {},
) {
  const { width, height, frames } = renderFrames(project, frameRange(project, range), scale);
  const used = new Set();
  const entries = frames.map((picture) => {
    let base = safeFileName(expandPattern(pattern, { name, frame: picture.frame }));
    while (used.has(base)) base += "_";
    used.add(base);
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      rgba[i * 4] = picture.data[i * 3];
      rgba[i * 4 + 1] = picture.data[i * 3 + 1];
      rgba[i * 4 + 2] = picture.data[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    return format === "tga"
      ? { name: `${base}.tga`, data: encodeTga(width, height, rgba) }
      : { name: `${base}.png`, data: encodePng(width, height, picture.data) };
  });
  return { buffer: createZip(entries), width, height, frames: entries.length, names: entries.map((e) => e.name) };
}

/* --------------------------------------------------------------- import */

/**
 * Turn pictures into a project: a still becomes one cell, a GIF becomes one
 * cell per frame, held for as long as the GIF showed it.
 *
 * @param {{name: string, bytes: Uint8Array}[]} files  several files become a sequence of cells
 */
export function importPictures(files, { fps = 12 } = {}) {
  if (!files.length) throw new Error("no pictures to import");
  const decoded = files.map((file) => ({ file, picture: decodeImage(file.bytes) }));
  const width = Math.max(MIN_SIZE, ...decoded.map((d) => d.picture.width));
  const height = Math.max(MIN_SIZE, ...decoded.map((d) => d.picture.height));
  if (width > 4096 || height > 4096) throw new Error("pictures larger than 4096 pixels are not supported");

  const layer = createLayer(decoded.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") : "Pictures");
  let at = 1;
  let projectFps = fps;
  const gifDelays = decoded.length === 1 && decoded[0].picture.kind === "gif"
    ? decoded[0].picture.frames.map((f) => f.delay)
    : null;
  if (gifDelays) {
    const smallest = Math.min(...gifDelays.filter((d) => d > 0), 10);
    projectFps = Math.min(120, Math.max(1, Math.round(100 / smallest)));
  }

  for (const { picture, file } of decoded) {
    picture.frames.forEach((frame, index) => {
      const canvas = new Uint8Array(width * height * 4);
      for (let y = 0; y < picture.height; y += 1) {
        canvas.set(frame.data.subarray(y * picture.width * 4, (y + 1) * picture.width * 4), y * width * 4);
      }
      let hold = 1;
      if (gifDelays) hold = Math.max(1, Math.round((frame.delay || 10) / (100 / projectFps)));
      layer.drawings.push({
        at,
        hold,
        strokes: [],
        name: picture.frames.length > 1 ? String(index + 1) : file.name.replace(/\.[^.]+$/, "").slice(0, 80),
        image: {
          data: encodeRgbaPng(width, height, canvas).toString("base64"),
          width,
          height,
        },
      });
      at += hold;
    });
  }

  return normalizeProject({
    format: "tvmini",
    version: 3,
    width,
    height,
    background: "#ffffff",
    image: null,
    fps: projectFps,
    startFrame: 1,
    currentLayer: 0,
    currentFrame: 1,
    loop: true,
    layers: [layer],
  });
}
