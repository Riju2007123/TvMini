import fs from "node:fs";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readAnimationCurves, readTrackRange } from "../public/core/clip-animation.js";

/**
 * Report the curves of every animation track in the given `.clip` files.
 *
 *   node tools/curve-probe.mjs <dir-or-file> [...]
 *
 * This is the tool that found the cel timing. It prints the `Frame`, `Value`
 * and `Tag` of an `ImageCelName` curve both as stored (60 Hz ticks) and as
 * frames at the frame rate of the document, so a file whose keys do not land
 * on whole frames shows up at once.
 */
function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) return null;
    offset += 16 + size;
  }
  return null;
}

const files = [];
for (const arg of process.argv.slice(2)) {
  if (fs.statSync(arg).isDirectory()) {
    for (const entry of fs.readdirSync(arg)) {
      if (/\.clip$/i.test(entry)) files.push(path.join(arg, entry));
    }
  } else {
    files.push(arg);
  }
}

const round = (value) => Number(value.toFixed(3));

for (const file of files) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    continue;
  }
  if (data.toString("ascii", 0, 8) !== "CSFCHUNK") continue;

  let db;
  try {
    const database = extractDatabase(data);
    if (!database) continue;
    db = await openDatabase(new Buffer(database));
  } catch {
    continue;
  }

  let timeline = null;
  try {
    timeline = db.prepare("SELECT FrameRate, StartFrame, EndFrame, BiggestEndFrame FROM TimeLine").get();
  } catch {}

  const externals = new Map();
  try {
    for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
      const id = Buffer.from(row.ExternalID).toString("ascii");
      let offset = 0x18;
      while (offset + 16 <= data.length) {
        const name = data.toString("ascii", offset, offset + 8);
        const size = Number(data.readBigUInt64BE(offset + 8));
        if (name === "CHNKExta" && offset === Number(row.Offset)) {
          externals.set(id, data.subarray(offset + 16, offset + 16 + size));
          break;
        }
        offset += 16 + size;
      }
    }
  } catch {}

  let tracks = [];
  try {
    tracks = db.prepare("SELECT MainId, TrackKind, TrackActionMixer, TrackActionMixer2 FROM Track ORDER BY MainId").all();
  } catch {}

  const rows = [];
  for (const track of tracks) {
    for (const [which, column] of [["1", "TrackActionMixer"], ["2", "TrackActionMixer2"]]) {
      const id = Buffer.from(track[column]).toString("ascii");
      const chunk = externals.get(id);
      if (!chunk) continue;
      const doc = readActionBlob(chunk);
      if (!doc) continue;
      for (const curve of readAnimationCurves(doc)) {
        rows.push({ track, which, doc, curve, range: readTrackRange(doc) });
      }
    }
  }
  await db.close();
  if (!rows.length) continue;

  const fps = Number(timeline?.FrameRate) || 30;
  console.log(`\n=== ${path.basename(file)}  fps=${fps} range=${timeline?.StartFrame}..${timeline?.EndFrame} biggest=${timeline?.BiggestEndFrame}`);
  for (const { track, which, doc, curve, range } of rows) {
    const field = (name) => curve.fields.get(name)?.values ?? [];
    const names = field("Tag").map((at) => doc.pool[at]);
    const frames = field("Frame");
    console.log(
      `  track ${track.MainId} kind=${track.TrackKind} col=${which} @${curve.start} ${curve.kind}` +
      ` range=${JSON.stringify(range)}` +
      (curve.axis ? ` axis=${curve.axis}` : "") +
      ` fields=${[...curve.fields.keys()].join(",")}`,
    );
    if (frames.length) {
      console.log(`    ticks=${frames.map(round).join(",")} -> frames=${frames.map((t) => round((t * fps) / 60)).join(",")}`);
    }
    if (names.length) console.log(`    tag=${names.join(",")}`);
  }
}
