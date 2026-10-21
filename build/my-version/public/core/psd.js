/**
 * A layered Photoshop (.psd) writer.
 *
 * PSD is a published format (Adobe "Photoshop File Format Specification").
 * This is an independent implementation of the parts TVMini needs:
 *
 *   - 8 bit RGB, one file per frame;
 *   - every drawing layer becomes a PSD layer cropped to its content, with
 *     its opacity, visibility and clipping flag;
 *   - every folder becomes a layer group (`lsct` section dividers), nested
 *     as deep as the project nests;
 *   - hidden layers are kept, switched off;
 *   - the merged picture of the frame is stored as the preview.
 *
 * Channel data is PackBits (RLE) compressed. The layer order in a PSD runs
 * bottom to top, and a group is written as a "bounding" divider, its
 * children, then the group's own record - the opposite of the project's
 * top-first list, so the tree is walked from the bottom.
 */
import { Buffer } from "./bytes.js";
import { childrenOf, isGroup } from "../timeline.js";
import { renderLayerRgba, renderProject } from "./png.js";

const GROUP_OPEN = 1;
const GROUP_DIVIDER = 3;

/** Growable big-endian byte sink. */
class Sink {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  bytes(buffer) {
    this.parts.push(buffer);
    this.length += buffer.length;
  }
  ascii(text) {
    this.bytes(Buffer.from(text, "latin1"));
  }
  u8(value) {
    this.bytes(Buffer.from([value & 0xff]));
  }
  u16(value) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value & 0xffff, 0);
    this.bytes(b);
  }
  i16(value) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value, 0);
    this.bytes(b);
  }
  u32(value) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0, 0);
    this.bytes(b);
  }
  i32(value) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value, 0);
    this.bytes(b);
  }
  pad(multiple) {
    while (this.length % multiple !== 0) this.u8(0);
  }
  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

/** PackBits-encode one row. */
export function packBitsRow(row) {
  const out = [];
  const n = row.length;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && row[i + run] === row[i]) run += 1;
    if (run >= 2) {
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    // A literal stretch ends where a run of two or more starts.
    let end = i + 1;
    while (end < n && end - i < 128 && !(end + 1 < n && row[end] === row[end + 1])) end += 1;
    out.push(end - i - 1);
    for (let k = i; k < end; k += 1) out.push(row[k]);
    i = end;
  }
  return Uint8Array.from(out);
}

/** Decode one PackBits row of a known width (used by the tests). */
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

/** One RLE channel: compression flag, row byte counts, packed rows. */
function rleChannel(plane, w, h) {
  const rows = [];
  for (let y = 0; y < h; y += 1) rows.push(packBitsRow(plane.subarray(y * w, (y + 1) * w)));
  const sink = new Sink();
  sink.u16(1);
  for (const row of rows) sink.u16(row.length);
  for (const row of rows) sink.bytes(Buffer.from(row));
  return sink.toBuffer();
}

const EMPTY_CHANNEL = () => Buffer.from([0, 0]); // compression 0, no data

/** Pascal string padded so the whole field is a multiple of 4 bytes. */
function pascalName(name) {
  const bytes = Buffer.from(Array.from(name, (ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63)).slice(0, 255));
  const total = 1 + bytes.length;
  const padded = Math.ceil(total / 4) * 4;
  const out = Buffer.alloc(padded);
  out[0] = bytes.length;
  bytes.copy(out, 1);
  return out;
}

function unicodeName(name) {
  const sink = new Sink();
  sink.u32(name.length);
  for (let i = 0; i < name.length; i += 1) sink.u16(name.charCodeAt(i));
  sink.u16(0);
  sink.pad(4);
  return sink.toBuffer();
}

function infoBlock(sink, key, payload) {
  sink.ascii("8BIM");
  sink.ascii(key);
  sink.u32(payload.length);
  sink.bytes(payload);
  if (payload.length % 2 === 1) sink.u8(0);
}

function sectionDivider(type) {
  const sink = new Sink();
  sink.u32(type);
  sink.ascii("8BIM");
  sink.ascii("norm");
  return sink.toBuffer();
}

/**
 * Describe the layers in PSD order (bottom to top) without any pixels yet.
 * Returns records like `{ kind: "layer" | "open" | "divider", index, name }`.
 */
function walk(project) {
  const records = [];
  const visit = (parent) => {
    const children = childrenOf(project, parent);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const index = children[i];
      const layer = project.layers[index];
      if (isGroup(layer)) {
        records.push({ kind: "divider", index, name: "</Layer group>" });
        visit(index);
        records.push({ kind: "open", index, name: layer.name });
      } else {
        records.push({ kind: "layer", index, name: layer.name });
      }
    }
  };
  visit(-1);
  return records;
}

/** Build the record bytes and channel data for one entry. */
function buildRecord(project, entry, frame, canvas) {
  const layer = project.layers[entry.index];
  const flags = layer.visible === false ? 0x02 : 0x00;
  const opacity = Math.round(Math.max(0, Math.min(1, layer.opacity ?? 1)) * 255);
  let bounds = { top: 0, left: 0, bottom: 0, right: 0 };
  let channels = [EMPTY_CHANNEL(), EMPTY_CHANNEL(), EMPTY_CHANNEL(), EMPTY_CHANNEL()];

  if (entry.kind === "layer") {
    const rgba = renderLayerRgba(project, layer, frame);
    const box = contentBounds(rgba, canvas.width, canvas.height);
    if (box) {
      bounds = box;
      const w = box.right - box.left;
      const h = box.bottom - box.top;
      const planes = [0, 1, 2, 3].map(() => new Uint8Array(w * h));
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const from = ((y + box.top) * canvas.width + (x + box.left)) * 4;
          const to = y * w + x;
          planes[0][to] = rgba[from];
          planes[1][to] = rgba[from + 1];
          planes[2][to] = rgba[from + 2];
          planes[3][to] = rgba[from + 3];
        }
      }
      // PSD channel order: R, G, B, then the transparency channel (-1).
      channels = planes.map((plane) => rleChannel(plane, w, h));
    }
  }

  const ids = [0, 1, 2, -1];
  const head = new Sink();
  head.i32(bounds.top);
  head.i32(bounds.left);
  head.i32(bounds.bottom);
  head.i32(bounds.right);
  head.u16(4);
  for (let i = 0; i < 4; i += 1) {
    head.i16(ids[i]);
    head.u32(channels[i].length);
  }
  head.ascii("8BIM");
  head.ascii("norm");
  head.u8(entry.kind === "layer" ? opacity : 255);
  head.u8(entry.kind === "layer" && layer.clip ? 1 : 0);
  head.u8(flags);
  head.u8(0);

  const extra = new Sink();
  extra.u32(0); // layer mask
  extra.u32(0); // blending ranges
  extra.bytes(pascalName(entry.name));
  infoBlock(extra, "luni", unicodeName(entry.name));
  if (entry.kind === "open") infoBlock(extra, "lsct", sectionDivider(GROUP_OPEN).subarray(0, 12));
  if (entry.kind === "divider") infoBlock(extra, "lsct", sectionDivider(GROUP_DIVIDER).subarray(0, 12));
  const extraBytes = extra.toBuffer();
  head.u32(extraBytes.length);
  head.bytes(extraBytes);

  return { head: head.toBuffer(), channels };
}

/**
 * Write one frame of the project as a layered PSD.
 *
 * The camera is ignored: a PSD keeps the whole canvas so every layer can be
 * edited, and the merged preview is the full canvas as well.
 *
 * @returns {{buffer: Buffer, width: number, height: number, layers: number}}
 */
export function createPsdBuffer(project, frame = project.currentFrame) {
  const canvas = { width: project.width, height: project.height };
  const flat = { ...project, camera: undefined };
  const entries = walk(project);
  const built = entries.map((entry) => buildRecord(project, entry, frame, canvas));

  const layerInfo = new Sink();
  layerInfo.i16(built.length);
  for (const item of built) layerInfo.bytes(item.head);
  for (const item of built) for (const channel of item.channels) layerInfo.bytes(channel);
  layerInfo.pad(2);

  const merged = renderProject(flat, frame);
  const pixels = canvas.width * canvas.height;

  const out = new Sink();
  out.ascii("8BPS");
  out.u16(1);
  out.bytes(Buffer.alloc(6));
  out.u16(3);
  out.u32(canvas.height);
  out.u32(canvas.width);
  out.u16(8);
  out.u16(3); // RGB
  out.u32(0); // colour mode data
  out.u32(0); // image resources

  const layerInfoBytes = layerInfo.toBuffer();
  const section = new Sink();
  section.u32(layerInfoBytes.length);
  section.bytes(layerInfoBytes);
  section.u32(0); // global layer mask info
  const sectionBytes = section.toBuffer();
  out.u32(sectionBytes.length);
  out.bytes(sectionBytes);

  // The merged picture: RLE, with every row's byte count first, then the rows.
  const packedRows = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const plane = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i += 1) plane[i] = merged.data[i * 3 + channel];
    for (let y = 0; y < canvas.height; y += 1) {
      packedRows.push(packBitsRow(plane.subarray(y * canvas.width, (y + 1) * canvas.width)));
    }
  }
  out.u16(1);
  for (const row of packedRows) out.u16(row.length);
  for (const row of packedRows) out.bytes(Buffer.from(row));

  return {
    buffer: out.toBuffer(),
    width: canvas.width,
    height: canvas.height,
    layers: built.length,
  };
}
