/**
 * MP4 video: the frames of a range encoded as H.264 by the browser itself.
 *
 * The page already knows how to draw every frame (`renderProject`), and the
 * browser already carries an H.264 encoder (WebCodecs) - what was missing
 * was the container. This module wraps the pictures in a plain MP4 file the
 * way the other writers here wrap pixels in their own formats: the boxes
 * are written by hand, from the notes of the ISO base media file format.
 *
 * The encoder is asked for the "avc" layout, which hands over the stream
 * description (the `avcC` record) and length-prefixed NAL units - exactly
 * what an MP4 sample wants, so the bytes of every chunk are copied into the
 * file as they came.
 */
import { frameRange, renderFrames } from "./exporters.js";
import { scaleRgb } from "./png.js";

/* ------------------------------------------------------------- box tools */

const ascii = (text) => {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
};

const u8 = (value) => new Uint8Array([value & 0xff]);

const u16 = (value) => {
  const out = new Uint8Array(2);
  out[0] = (value >>> 8) & 0xff;
  out[1] = value & 0xff;
  return out;
};

const u32 = (value) => {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
};

/** Concatenate a list of byte blocks without a spread, so a long list works. */
const joinAll = (parts) => {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A box: its size, its four letters, and what it holds. */
const box = (type, ...children) => {
  let size = 8;
  for (const child of children) size += child.length;
  return joinAll([u32(size), ascii(type), ...children]);
};

/** A box whose first bytes say the version and the flags. */
const fullBox = (type, version, flags, ...children) =>
  box(type, u8(version), u8(flags >>> 16), u8(flags >>> 8), u8(flags), ...children);

/** The matrix every video track carries: the plain identity. */
const matrix = () =>
  joinAll([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  ]);

/* ------------------------------------------------------------ the samples */

/**
 * The video sample description: the picture size and the `avcC` record the
 * encoder handed over. The rest of the entry is the shape every MP4 video
 * track carries, down to the depth of the pictures it once might hold.
 */
function avc1Entry(width, height, description) {
  return box(
    "avc1",
    u8(0), u8(0), u8(0), u8(0), u8(0), u8(0), // reserved
    u16(1), // data reference index
    u16(0), u16(0), // pre_defined, reserved
    u32(0), u32(0), u32(0), // pre_defined
    u16(width),
    u16(height),
    u32(0x00480000), u32(0x00480000), // 72 dpi both ways
    u32(0), // reserved
    u16(1), // frame count
    joinAll([u8(0), new Uint8Array(31)]), // compressor name, empty
    u16(0x0018), // depth
    u16(0xffff), // pre_defined, -1
    box("avcC", description),
  );
}

/**
 * Wrap the encoded H.264 samples in an MP4 file.
 *
 * `samples` is the list of chunks in the order the encoder gave them, each
 * `{ bytes, key }`. The track's clock is `fps` * 1000 ticks a second and
 * every sample lasts 1000 ticks, so the times come out exact for whole
 * frame rates. The whole file is one chunk holding every sample.
 */
export function muxAvcMp4({ width, height, fps, description, samples }) {
  const frames = samples.length;
  if (frames < 1) throw new Error("no frames were given to the MP4 writer");
  if (!description || !description.length) throw new Error("no H.264 stream description was given");

  const tick = 1000;
  const timescale = Math.max(1, Math.round(Number(fps) || 12) * tick);
  const duration = frames * tick;

  // The samples that start a group of pictures, counted from one. The first
  // sample always is one, so a file without marked keys still seeks.
  const keyNumbers = [];
  samples.forEach((sample, index) => {
    if (sample.key) keyNumbers.push(index + 1);
  });
  if (!keyNumbers.length) keyNumbers.push(1);

  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));

  // The samples live in one chunk right after the file type; the moov that
  // follows points back at where the first one begins.
  const firstOffset = ftyp.length + 8;

  const moov = box(
    "moov",
    fullBox(
      "mvhd",
      0,
      0,
      u32(0), u32(0),
      u32(1000), // the clock of the whole file: milliseconds
      u32(Math.round((frames * 1000) / (timescale / tick))),
      u32(0x00010000), // rate 1.0
      u16(0x0100), u16(0), // full volume, reserved
      u32(0), u32(0), // reserved
      matrix(),
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
      u32(2), // the next track would be number 2
    ),
    box(
      "trak",
      fullBox(
        "tkhd",
        0,
        3, // enabled, in the movie
        u32(0), u32(0),
        u32(1), // track id
        u32(0), // reserved
        u32(Math.round((frames * 1000) / (timescale / tick))),
        u32(0), u32(0), // reserved
        u16(0), u16(0), // layer, alternate group
        u16(0), u16(0), // volume 0 for a video track, reserved
        matrix(),
        u32(width * 0x10000),
        u32(height * 0x10000),
      ),
      box(
        "mdia",
        fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)),
        fullBox(
          "hdlr",
          0,
          0,
          u32(0),
          ascii("vide"),
          u32(0), u32(0), u32(0), // reserved
          joinAll([ascii("VideoHandler"), u8(0)]),
        ),
        box(
          "minf",
          fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)),
          box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
          box(
            "stbl",
            fullBox("stsd", 0, 0, u32(1), avc1Entry(width, height, description)),
            fullBox("stts", 0, 0, u32(1), u32(frames), u32(tick)),
            fullBox(
              "stss",
              0,
              0,
              u32(keyNumbers.length),
              ...keyNumbers.map((n) => u32(n)),
            ),
            fullBox("stsc", 0, 0, u32(1), u32(1), u32(frames), u32(1)),
            fullBox(
              "stsz",
              0,
              0,
              u32(0),
              u32(frames),
              ...samples.map((sample) => u32(sample.bytes.length)),
            ),
            fullBox("stco", 0, 0, u32(1), u32(firstOffset)),
          ),
        ),
      ),
    ),
  );

  // A very long list of samples would overflow a spread call, so the mdat
  // body is gathered by walking.
  const mdatBody = joinAll(samples.map((sample) => sample.bytes));
  const mdat = box("mdat", mdatBody);
  return joinAll([ftyp, mdat, moov]);
}

/* --------------------------------------------------------------- encoding */

/** The frames a canvas of some size may ask of an H.264 encoder. */
const LEVEL_LIMITS = [
  [921600, "1F"], // level 3.1: 720p
  [2073600, "28"], // level 4.0: 1080p
  [4200000, "2A"], // level 4.2
  [8847360, "33"], // level 5.1: 4K
  [16777216, "36"], // level 5.2: as far as the table goes
];

/** MP4 video is possible where the browser carries the WebCodecs encoder. */
export function mp4EncoderAvailable() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/** RGB with three bytes a pixel becomes RGBA with four, opaque. */
function rgbaOf(rgb) {
  const out = new Uint8ClampedArray((rgb.length / 3) * 4);
  for (let at = 0, to = 0; at < rgb.length; at += 3, to += 4) {
    out[to] = rgb[at];
    out[to + 1] = rgb[at + 1];
    out[to + 2] = rgb[at + 2];
    out[to + 3] = 255;
  }
  return out;
}

/**
 * An MP4 of the frames of a project.
 *
 * The frames are drawn the way the canvas shows them (camera included),
 * scaled like the other exports scale, and encoded with a key frame every
 * two seconds so the video can be seeked. `onPhase` receives a word for
 * the status bar as the work goes along.
 */
export async function createMp4Buffer(project, { range = "all", scale = 100, keyframeSeconds = 2, onPhase = null } = {}) {
  if (!mp4EncoderAvailable()) {
    throw new Error("this browser cannot encode MP4 video (WebCodecs is missing); use Chrome, Edge or the desktop app");
  }
  const fps = Math.max(1, Math.round(Number(project.fps) || 12));
  const built = renderFrames(project, frameRange(project, range), scale);
  // H.264 carries pictures of even sizes only, so an odd picture is
  // carried up to the next even one.
  const width = built.width % 2 ? built.width + 1 : built.width;
  const height = built.height % 2 ? built.height + 1 : built.height;
  const pictures = built.frames.map((frame) =>
    frame.width === width && frame.height === height
      ? frame.data
      : scaleRgb(frame.data, frame.width, frame.height, width, height),
  );

  // A bitrate in the usual range: about a tenth of a bit a pixel a frame,
  // never below what a small clip needs and never above what plays well.
  const bitrate = Math.round(Math.min(60_000_000, Math.max(1_500_000, width * height * fps * 0.09)));
  const pixels = width * height;
  let config = null;
  for (const [limit, level] of LEVEL_LIMITS) {
    if (pixels > limit) continue;
    const candidate = {
      codec: `avc1.4200${level}`,
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: "quality",
      // "avc" hands the description over and length-prefixed units: the
      // layout an MP4 sample wants.
      avc: { format: "avc" },
    };
    const answer = await VideoEncoder.isConfigSupported(candidate);
    if (answer?.supported) {
      config = candidate;
      break;
    }
  }
  if (!config) {
    throw new Error(`this browser has no H.264 encoder for a picture of ${width}×${height}`);
  }

  const chunks = [];
  let description = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (!description) {
        const decoder = metadata?.decoderConfig;
        const raw = decoder?.description;
        if (raw) {
          description =
            raw instanceof ArrayBuffer
              ? new Uint8Array(raw)
              : new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
        }
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      chunks.push({ bytes, key: chunk.type === "key" });
    },
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });
  encoder.configure(config);

  const keyEvery = Math.max(1, Math.round(fps * keyframeSeconds));
  const perFrame = 1_000_000 / fps;
  for (let index = 0; index < pictures.length; index += 1) {
    if (failure) throw failure;
    const videoFrame = new VideoFrame(rgbaOf(pictures[index]), {
      format: "RGBA",
      codedWidth: width,
      codedHeight: height,
      timestamp: Math.round(index * perFrame),
      duration: Math.round(perFrame),
    });
    encoder.encode(videoFrame, { keyFrame: index % keyEvery === 0 });
    videoFrame.close();
    if (onPhase && (index % 8 === 0 || index === pictures.length - 1)) {
      onPhase(`Encoding frame ${index + 1} of ${pictures.length}`);
    }
    // An encoder slower than the page would pile frames up without end;
    // the wait lets it catch up, the way it lets the page breathe.
    while (encoder.encodeQueueSize > 12) {
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!description) throw new Error("the H.264 encoder gave no stream description");

  const buffer = muxAvcMp4({ width, height, fps, description, samples: chunks });
  const frames = pictures.length;
  return {
    buffer,
    width,
    height,
    frames,
    fps,
    summary: `${frames} frame${frames === 1 ? "" : "s"}, ${width}×${height}, ${fps} fps`,
  };
}
