/**
 * A layered Photoshop (.psd) reader, and the builder of the Flash 8 package.
 *
 * TVMini writes .psd files (psd.js); this module reads them back, and it
 * reads the layered .psd that Clip Studio Paint exports, which is the
 * first half of the CSP -> Flash 8 pipeline:
 *
 *   CSP .psd --(this module)--> PNG per layer + manifest.txt (a ZIP)
 *            --(CSP2Flash-import.jsfl in Flash 8)--> an editable .fla
 *
 * The reader holds the same parts the writer makes: 8 bit RGB, PackBits
 * (RLE) or raw channels, layer records with Pascal and `luni` names, and
 * layer groups flattened into `Group/Layer` names. Records run bottom to
 * top, which is exactly the order the Flash manifest wants.
 */
import { Buffer } from "./bytes.js";
import { encodeRgbaPng } from "./png.js";
import { createZip } from "./exporters.js";

/** A byte cursor over big-endian PSD structures. */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.p = 0;
  }
  u8() {
    return this.bytes[this.p++];
  }
  u16() {
    const v = this.bytes.readUInt16BE(this.p);
    this.p += 2;
    return v;
  }
  i16() {
    const v = this.bytes.readInt16BE(this.p);
    this.p += 2;
    return v;
  }
  u32() {
    const v = this.bytes.readUInt32BE(this.p);
    this.p += 4;
    return v;
  }
  i32() {
    const v = this.bytes.readInt32BE(this.p);
    this.p += 4;
    return v;
  }
  /** Four signature bytes, read as text ("8BIM", "8B64"). */
  sig() {
    const v = this.bytes.toString("latin1", this.p, this.p + 4);
    this.p += 4;
    return v;
  }
  ascii(key) {
    const v = this.bytes.toString("latin1", this.p, this.p + key.length);
    this.p += key.length;
    return v;
  }
  skip(n) {
    this.p += n;
  }
  at() {
    return this.p;
  }
}

/** The smallest box that holds every pixel with some alpha, or null. */
function contentBounds(rgba, width, height) {
  let top = height;
  let left = width;
  let bottom = -1;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) return null;
  return { top, left, bottom: bottom + 1, right: right + 1 };
}

/** Decode one PackBits row of a known width. */
export function unpackBitsRow(packed, width) {
  const out = new Uint8Array(width);
  let read = 0;
  let write = 0;
  while (write < width && read < packed.length) {
    const header = (packed[read] << 24) >> 24;
    read += 1;
    if (header >= 0) {
      const count = header + 1;
      out.set(packed.subarray(read, read + count), write);
      read += count;
      write += count;
    } else if (header !== -128) {
      const count = 1 - header;
      out.fill(packed[read], write, write + count);
      read += 1;
      write += count;
    }
  }
  return out;
}

/** Decode one recorded channel of a layer into `width * height` bytes. */
function decodeChannel(reader, length, width, height) {
  const end = reader.p + length;
  if (length < 2) {
    reader.p = end;
    return new Uint8Array(width * height);
  }
  const compression = reader.u16();
  const plane = new Uint8Array(width * height);
  if (compression === 1) {
    const counts = [];
    for (let y = 0; y < height; y += 1) counts.push(reader.u16());
    for (let y = 0; y < height; y += 1) {
      const count = counts[y];
      plane.set(unpackBitsRow(reader.bytes.subarray(reader.p, reader.p + count), width), y * width);
      reader.p += count;
    }
  } else {
    plane.set(reader.bytes.subarray(reader.p, reader.p + width * height), 0);
    reader.p += width * height;
  }
  if (reader.p > end) throw new Error("a PSD channel overruns its length");
  reader.p = end;
  return plane;
}

/** A `luni` info block holds the full (untruncated) layer name. */
function unicodeName(payload) {
  const reader = new Reader(payload);
  const count = reader.u32();
  let name = "";
  for (let i = 0; i < count; i += 1) name += String.fromCharCode(reader.u16());
  return name;
}

/**
 * The additional-info blocks of one layer record: Pascal name, then tagged
 * blocks. Returns `{ name, lsct }` where `lsct` is the section-divider type
 * (0 none, 1 open folder, 2 closed folder, 3 divider marker).
 */
function readLayerExtra(reader, extraLength) {
  const end = reader.p + extraLength;
  let name = "";
  let lsct = 0;
  // Layer mask and blending ranges: lengths, then their bytes.
  reader.skip(reader.u32());
  reader.skip(reader.u32());
  // Pascal string padded to a multiple of four bytes.
  const nameLength = reader.u8();
  name = reader.bytes.toString("latin1", reader.p, reader.p + nameLength);
  reader.p += nameLength;
  reader.skip(Math.ceil((1 + nameLength) / 4) * 4 - (1 + nameLength));
  // Tagged blocks until the extra data ends.
  while (reader.p + 12 <= end) {
    const sig = reader.sig();
    if (sig !== "8BIM" && sig !== "8B64") break;
    const key = reader.ascii("xxxx");
    const length = reader.u32();
    const payload = reader.bytes.subarray(reader.p, reader.p + length);
    reader.p += length;
    if (length % 2 === 1) reader.u8();
    if (key === "luni") name = unicodeName(payload);
    if (key === "lsct") {
      const type = payload.readUInt32BE(0);
      if (type === 1 || type === 2 || type === 3) lsct = type;
    }
  }
  reader.p = end;
  return { name, lsct };
}

/**
 * Read the layers of a PSD file.
 *
 * Groups are flattened: each layer keeps its order (bottom to top) and a
 * name of `Group/Inner/Layer`. Every layer is `{ name, left, top, width,
 * height, rgba }` with straight-alpha RGBA of the cropped content, or
 * `rgba: null` when the layer holds no pixels.
 *
 * @returns {{width: number, height: number, layers: object[], groups: number}}
 */
export function readPsdLayers(bytes) {
  const reader = new Reader(bytes);
  if (reader.ascii("8BPS") !== "8BPS") throw new Error("not a PSD file (no 8BPS signature)");
  const version = reader.u16();
  if (version !== 1) throw new Error(`unsupported PSD version ${version}`);
  reader.skip(6); // reserved
  const channelCount = reader.u16();
  const height = reader.u32();
  const width = reader.u32();
  const depth = reader.u16();
  const mode = reader.u16();
  if (depth !== 8) throw new Error(`unsupported PSD bit depth ${depth}`);
  if (mode !== 3) throw new Error("unsupported PSD colour mode (RGB expected)");
  void channelCount;

  reader.skip(reader.u32()); // colour mode data
  reader.skip(reader.u32()); // image resources

  // The layer & mask section; the layer info inside it can be empty.
  // The section's own length field is followed at once by the layer info.
  if (reader.p + 4 > reader.bytes.length) return { width, height, layers: [], groups: 0 };
  reader.u32(); // the whole section's length
  if (reader.p >= reader.bytes.length) return { width, height, layers: [], groups: 0 };
  const layerInfoLength = reader.u32();
  if (layerInfoLength === 0) return { width, height, layers: [], groups: 0 };

  const layerCount = Math.abs(reader.i16());
  const records = [];
  for (let i = 0; i < layerCount; i += 1) {
    const top = reader.i32();
    const left = reader.i32();
    const bottom = reader.i32();
    const right = reader.i32();
    const channels = [];
    const channelCountOfLayer = reader.u16();
    for (let c = 0; c < channelCountOfLayer; c += 1) {
      const id = reader.i16();
      channels.push({ id, length: reader.u32() });
    }
    const signature = reader.sig();
    if (signature !== "8BIM" && signature !== "8B64") throw new Error("corrupt PSD layer record");
    reader.skip(4); // blend key
    reader.skip(4); // opacity, clipping, flags, filler
    const extra = readLayerExtra(reader, reader.u32());
    records.push({
      left,
      top,
      width: right - left,
      height: bottom - top,
      channels,
      name: extra.name,
      lsct: extra.lsct,
    });
  }

  // The channel data of every record, in the same order.
  for (const record of records) {
    const w = Math.max(0, record.width);
    const h = Math.max(0, record.height);
    const planes = {};
    for (const channel of record.channels) {
      planes[channel.id] = decodeChannel(reader, channel.length, w, h);
    }
    const pixels = w * h;
    const rgba = new Uint8Array(pixels * 4);
    const red = planes[0];
    const green = planes[1];
    const blue = planes[2];
    const alpha = planes[-1];
    for (let i = 0; i < pixels; i += 1) {
      rgba[i * 4] = red ? red[i] : 0;
      rgba[i * 4 + 1] = green ? green[i] : 0;
      rgba[i * 4 + 2] = blue ? blue[i] : 0;
      rgba[i * 4 + 3] = alpha ? alpha[i] : 255;
    }
    record.rgba = rgba;
  }

  // Flatten the groups. A divider record (`</Layer group>`) opens a group,
  // the folder's own record (lsct 1 or 2) closes it with its real name. The
  // name of an outer group is only known when its own record arrives, so a
  // group is first collected as a bundle and flattened at the end.
  const root = [];
  const stack = [];
  for (const record of records) {
    if (record.lsct === 3) {
      stack.push({ name: null, items: [] });
      continue;
    }
    if (record.lsct === 1 || record.lsct === 2) {
      const bundle = stack.pop() ?? { name: null, items: [] };
      bundle.name = bundle.name ?? record.name;
      const parent = stack[stack.length - 1];
      if (parent) parent.items.push(bundle);
      else root.push(bundle);
      continue;
    }
    const frame = stack[stack.length - 1];
    if (frame) frame.items.push(record);
    else root.push(record);
  }
  // A file with an unbalanced group: the leftovers still come out.
  while (stack.length > 0) root.push(stack.pop());

  const flat = [];
  const flush = (items, prefix) => {
    for (const item of items) {
      if (item.items) {
        flush(item.items, prefix ? `${prefix}/${item.name ?? "Group"}` : item.name ?? "Group");
        continue;
      }
      item.name = prefix ? `${prefix}/${item.name}` : item.name;
      flat.push(item);
    }
  };
  flush(root, "");
  for (const layer of flat) {
    if (!layer.name || layer.name === "</Layer group>") layer.name = "";
  }
  return { width, height, layers: flat, groups: records.length - flat.length };
}

/** A safe file name: the manifest is a line-based text the Flash command splits on `|`. */
function safeName(name, used) {
  let clean = String(name || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) clean = "Layer";
  if (clean.length > 60) clean = clean.slice(0, 60);
  let unique = clean;
  let n = 2;
  while (used.has(unique.toLowerCase())) unique = `${clean} ${n++}`;
  used.add(unique.toLowerCase());
  return unique;
}

/**
 * Build the Flash 8 import package out of a layered PSD.
 *
 * Every layer becomes a PNG cropped to its content, positioned through the
 * manifest at the place it holds on the canvas. The manifest is the
 * line-based text `CSP2Flash-import.jsfl` reads:
 *
 *   type=layers
 *   width=<px> height=<px> fps=<n> [scale=<n>]
 *   layer=Name|file.png|x|y     (bottom to top)
 *
 * The Flash 8 stage is 2880x2880 at most; a bigger canvas scales everything
 * down and says so with `scale`.
 *
 * @returns {{zip: Buffer, summary: string, width: number, height: number, layers: number, fps: number}}
 */
export function buildCsp2FlashPackage(psdBytes, { fps = 12 } = {}) {
  const parsed = readPsdLayers(psdBytes);
  const layers = parsed.layers.filter((layer) => layer.rgba && layer.width > 0 && layer.height > 0);
  if (parsed.layers.length === 0) {
    throw new Error("the PSD holds no layers");
  }
  if (layers.length === 0) {
    throw new Error("every layer of the PSD is empty");
  }

  // The stage limit of Flash 8.
  let scale = 1;
  if (parsed.width > 2880 || parsed.height > 2880) {
    scale = 2880 / Math.max(parsed.width, parsed.height);
  }

  const used = new Set();
  const entries = [{ name: "manifest.txt", data: null }];
  const lines = [
    "type=layers",
    `width=${parsed.width}`,
    `height=${parsed.height}`,
    `fps=${Math.max(1, Math.round(fps))}`,
  ];
  if (scale !== 1) lines.push(`scale=${scale.toFixed(6)}`);
  for (const layer of layers) {
    const box = contentBounds(layer.rgba, layer.width, layer.height);
    if (!box) continue;
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    const cropped = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      const from = ((y + box.top) * layer.width + box.left) * 4;
      cropped.set(layer.rgba.subarray(from, from + w * 4), y * w * 4);
    }
    const name = safeName(layer.name, used);
    const file = `${name.replace(/\s+/g, "_")}.png`;
    // The manifest position is on the full canvas; the crop only removes
    // transparent padding around the content.
    lines.push(`layer=${name}|${file}|${layer.left + box.left}|${layer.top + box.top}`);
    entries.push({ name: file, data: encodeRgbaPng(w, h, cropped) });
  }
  lines.push("");
  entries[0].data = Buffer.from(lines.join("\n"), "utf8");

  const zip = createZip(entries);
  const kb = Math.round(zip.length / 1024);
  return {
    zip,
    summary: `${entries.length - 1} layer PNG${entries.length - 1 === 1 ? "" : "s"} + manifest, ` +
      `${parsed.width}x${parsed.height} canvas${scale !== 1 ? ` scaled ${Math.round(scale * 100)}% (Flash stage limit)` : ""}, ` +
      `${Math.max(1, Math.round(fps))} fps, ${kb} KB`,
    width: parsed.width,
    height: parsed.height,
    layers: entries.length - 1,
    fps: Math.max(1, Math.round(fps)),
  };
}
