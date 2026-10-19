import zlib from "node:zlib";

function parseHex(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function setPixel(data, width, height, x, y, rgb) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return;
  const index = (py * width + px) * 3;
  data[index] = rgb[0];
  data[index + 1] = rgb[1];
  data[index + 2] = rgb[2];
}

/** Paint a disc with hard edges (distance test) inside a bounding box. */
function disc(data, width, height, cx, cy, radius, rgb) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  const r2 = radius * radius;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setPixel(data, width, height, x, y, rgb);
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

/** Paint a segment by sampling discs with linearly interpolated radius. */
function segment(data, width, height, [x0, y0], [x1, y1], r0, r1, rgb) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const step = Math.max(0.5, Math.min(r0, r1) / 2);
  const steps = Math.max(1, Math.ceil(length / step));

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    disc(data, width, height, x0 + dx * t, y0 + dy * t, r0 + (r1 - r0) * t, rgb);
  }
}

/** Render a validated project to an RGB byte buffer. */
export function renderProject(project) {
  const { width, height } = project;
  const data = new Uint8Array(width * height * 3);
  const background = parseHex(project.background);

  for (let i = 0; i < data.length; i += 3) {
    data[i] = background[0];
    data[i + 1] = background[1];
    data[i + 2] = background[2];
  }

  for (const stroke of project.strokes) {
    const rgb = parseHex(stroke.color);
    const radii = stroke.points.map((point) => pointRadius(stroke, point));

    if (stroke.points.length === 1) {
      disc(data, width, height, stroke.points[0][0], stroke.points[0][1], radii[0], rgb);
      continue;
    }
    for (let i = 1; i < stroke.points.length; i += 1) {
      segment(
        data,
        width,
        height,
        stroke.points[i - 1],
        stroke.points[i],
        radii[i - 1],
        radii[i],
        rgb,
      );
    }
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
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function renderPng(project) {
  const { width, height, data } = renderProject(project);
  return { buffer: encodePng(width, height, data), width, height };
}
