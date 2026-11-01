/**
 * An animated GIF encoder and decoder (GIF89a, public format).
 *
 * The encoder builds one shared palette for the whole animation with a
 * median cut, maps every pixel to it and writes LZW compressed frames with
 * a loop extension. The decoder reads frames back as straight-alpha RGBA,
 * honouring transparency, disposal methods and interlacing.
 */
import { Buffer } from "./bytes.js";

/* ------------------------------------------------------------- palette */

/** Median-cut a set of RGB pixels (from all frames) down to `size` colours. */
export function buildPalette(frames, size = 256) {
  // Sample at most ~200k pixels so a long animation stays quick.
  let total = 0;
  for (const rgb of frames) total += rgb.length / 3;
  const step = Math.max(1, Math.floor(total / 200_000));
  const counts = new Map();
  for (const rgb of frames) {
    for (let i = 0, n = 0; i < rgb.length; i += 3, n += 1) {
      if (n % step !== 0) continue;
      const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let boxes = [{ colors: [...counts.entries()] }];
  while (boxes.length < size) {
    // Split the box with the widest channel range and enough colours.
    let best = -1;
    let bestRange = 0;
    let bestChannel = 0;
    boxes.forEach((box, index) => {
      if (box.colors.length < 2) return;
      for (let channel = 0; channel < 3; channel += 1) {
        const shift = 16 - channel * 8;
        let lo = 255;
        let hi = 0;
        for (const [key] of box.colors) {
          const v = (key >> shift) & 255;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          best = index;
          bestChannel = channel;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best];
    const shift = 16 - bestChannel * 8;
    box.colors.sort((a, b) => ((a[0] >> shift) & 255) - ((b[0] >> shift) & 255));
    const half = box.colors.reduce((s, c) => s + c[1], 0) / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.colors.length - 1; i += 1) {
      acc += box.colors[i][1];
      cut = i + 1;
      if (acc >= half) break;
    }
    boxes.splice(best, 1, { colors: box.colors.slice(0, cut) }, { colors: box.colors.slice(cut) });
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (const [key, count] of box.colors) {
      r += ((key >> 16) & 255) * count;
      g += ((key >> 8) & 255) * count;
      b += (key & 255) * count;
      w += count;
    }
    return w === 0 ? [0, 0, 0] : [Math.round(r / w), Math.round(g / w), Math.round(b / w)];
  });
}

/** Index of the closest palette colour for each pixel of an RGB buffer. */
function indexFrame(rgb, palette, cache) {
  const out = new Uint8Array(rgb.length / 3);
  for (let i = 0, p = 0; i < rgb.length; i += 3, p += 1) {
    const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    let index = cache.get(key);
    if (index === undefined) {
      let bestDistance = Infinity;
      index = 0;
      for (let c = 0; c < palette.length; c += 1) {
        const dr = rgb[i] - palette[c][0];
        const dg = rgb[i + 1] - palette[c][1];
        const db = rgb[i + 2] - palette[c][2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          index = c;
          if (distance === 0) break;
        }
      }
      cache.set(key, index);
    }
    out[p] = index;
  }
  return out;
}

/* ----------------------------------------------------------------- LZW */

function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const write = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  let table = new Map();
  let next = end + 1;
  write(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    write(prefix);
    if (next < 4096) {
      table.set(key, next);
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
      next += 1;
    } else {
      write(clear);
      table = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  write(prefix);
  write(end);
  if (bitCount > 0) out.push(bitBuffer & 255);
  return Uint8Array.from(out);
}

function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new Uint8Array(pixelCount);
  let written = 0;
  let codeSize = minCodeSize + 1;
  let prefixes = new Int32Array(4096);
  let suffixes = new Uint8Array(4096);
  let lengths = new Uint16Array(4096);
  let next = end + 1;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let read = 0;
  const first = (code) => {
    while (code >= clear) code = prefixes[code];
    return code;
  };
  const emit = (code) => {
    const length = code < clear ? 1 : lengths[code];
    let at = written + length - 1;
    let c = code;
    while (true) {
      if (at < pixelCount) out[at] = c < clear ? c : suffixes[c];
      at -= 1;
      if (c < clear) break;
      c = prefixes[c];
    }
    written += length;
  };

  while (written < pixelCount) {
    while (bitCount < codeSize && read < data.length) {
      bitBuffer |= data[read] << bitCount;
      read += 1;
      bitCount += 8;
    }
    if (bitCount < codeSize) break;
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;

    if (previous === -1) {
      emit(code);
      previous = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefixes[next] = previous;
        suffixes[next] = code < clear ? code : first(code);
        lengths[next] = (previous < clear ? 1 : lengths[previous]) + 1;
        next += 1;
      }
    } else {
      // The code that is being defined right now.
      if (next < 4096) {
        prefixes[next] = previous;
        suffixes[next] = previous < clear ? previous : first(previous);
        lengths[next] = (previous < clear ? 1 : lengths[previous]) + 1;
        next += 1;
      }
      emit(code);
    }
    if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    previous = code;
  }
  return out;
}

/* ------------------------------------------------------------- encoder */

/**
 * Encode frames as an animated GIF.
 *
 * @param {{width:number,height:number,frames:{rgb:Uint8Array,delay?:number}[],loop?:number,delay?:number}} options
 *   `delay` is in hundredths of a second; `loop` 0 means forever.
 */
export function encodeGif({ width, height, frames, loop = 0, delay = 8 }) {
  if (!frames.length) throw new Error("a GIF needs at least one frame");
  for (const frame of frames) {
    if (frame.rgb.length !== width * height * 3) throw new Error("a frame does not match the GIF size");
  }
  const palette = buildPalette(frames.map((f) => f.rgb));
  let bits = 1;
  while (1 << bits < palette.length) bits += 1;
  const tableSize = 1 << bits;
  const minCode = Math.max(2, bits);

  const parts = [];
  const push = (...bytes) => parts.push(Uint8Array.from(bytes));
  const u16 = (v) => [v & 255, (v >> 8) & 255];

  parts.push(Buffer.from("GIF89a", "latin1"));
  push(...u16(width), ...u16(height), 0x80 | 0x70 | (bits - 1), 0, 0);
  const table = new Uint8Array(tableSize * 3);
  palette.forEach((c, i) => table.set(c, i * 3));
  parts.push(table);

  // Netscape loop extension.
  push(0x21, 0xff, 0x0b);
  parts.push(Buffer.from("NETSCAPE2.0", "latin1"));
  push(3, 1, ...u16(loop), 0);

  const cache = new Map();
  for (const frame of frames) {
    const frameDelay = Math.max(1, Math.round(frame.delay ?? delay));
    push(0x21, 0xf9, 4, 0x04 /* leave in place */, ...u16(frameDelay), 0, 0);
    push(0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0);
    push(minCode);
    const packed = lzwEncode(indexFrame(frame.rgb, palette, cache), minCode);
    for (let i = 0; i < packed.length; i += 255) {
      const block = packed.subarray(i, i + 255);
      push(block.length);
      parts.push(block);
    }
    push(0);
  }
  push(0x3b);
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

/* ------------------------------------------------------------- decoder */

/**
 * Decode a GIF into full-canvas RGBA frames.
 * @returns {{width:number,height:number,loop:number,frames:{rgba:Uint8Array,delay:number}[]}}
 */
export function decodeGif(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const sig = String.fromCharCode(...data.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") throw new Error("not a GIF file");
  let p = 6;
  const u16 = () => ((p += 2), data[p - 2] | (data[p - 1] << 8));
  const width = u16();
  const height = u16();
  const flags = data[p++];
  p += 2; // background, aspect
  let global = null;
  if (flags & 0x80) {
    const n = 1 << ((flags & 7) + 1);
    global = data.subarray(p, p + n * 3);
    p += n * 3;
  }
  if (width < 1 || height < 1 || width * height > 64_000_000) throw new Error("unsupported GIF size");

  const frames = [];
  let loop = 0;
  let canvas = new Uint8Array(width * height * 4);
  let control = { delay: 10, transparent: -1, disposal: 0 };

  const readBlocks = () => {
    const chunks = [];
    while (p < data.length) {
      const n = data[p++];
      if (n === 0) break;
      chunks.push(data.subarray(p, p + n));
      p += n;
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  };

  while (p < data.length) {
    const block = data[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = data[p++];
      if (label === 0xf9) {
        const size = data[p++];
        const packed = data[p];
        control = {
          delay: data[p + 1] | (data[p + 2] << 8),
          transparent: packed & 1 ? data[p + 3] : -1,
          disposal: (packed >> 2) & 7,
        };
        p += size + 1;
      } else if (label === 0xff) {
        const size = data[p++];
        const id = String.fromCharCode(...data.subarray(p, p + size));
        p += size;
        const body = readBlocks();
        if (id.startsWith("NETSCAPE") && body[0] === 1) loop = body[1] | (body[2] << 8);
      } else {
        readBlocks();
      }
      continue;
    }
    if (block !== 0x2c) throw new Error("corrupt GIF");

    const left = u16();
    const top = u16();
    const w = u16();
    const h = u16();
    const local = data[p++];
    let palette = global;
    if (local & 0x80) {
      const n = 1 << ((local & 7) + 1);
      palette = data.subarray(p, p + n * 3);
      p += n * 3;
    }
    if (!palette) throw new Error("GIF has no colour table");
    const minCode = data[p++];
    const indices = lzwDecode(readBlocks(), minCode, w * h);

    const before = control.disposal === 3 ? canvas.slice() : null;
    const rows = [];
    if (local & 0x40) {
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let y = start; y < h; y += step) rows.push(y);
      }
    } else {
      for (let y = 0; y < h; y += 1) rows.push(y);
    }
    rows.forEach((destY, sourceY) => {
      const cy = destY + top;
      if (cy >= height) return;
      for (let x = 0; x < w; x += 1) {
        const cx = x + left;
        if (cx >= width) continue;
        const index = indices[sourceY * w + x];
        if (index === control.transparent) continue;
        const at = (cy * width + cx) * 4;
        canvas[at] = palette[index * 3];
        canvas[at + 1] = palette[index * 3 + 1];
        canvas[at + 2] = palette[index * 3 + 2];
        canvas[at + 3] = 255;
      }
    });
    frames.push({ rgba: canvas.slice(), delay: control.delay });

    if (control.disposal === 2) {
      for (let y = top; y < Math.min(height, top + h); y += 1) {
        canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4);
      }
    } else if (control.disposal === 3 && before) {
      canvas = before;
    }
    control = { delay: 10, transparent: -1, disposal: 0 };
  }
  if (!frames.length) throw new Error("the GIF has no frames");
  return { width, height, loop, frames };
}
