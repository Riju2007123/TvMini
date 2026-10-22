/**
 * Why an animation will not play: the timeline, the cut banks, the tracks and
 * their ranges, side by side for every file given on the command line.
 *
 *   node tools/playback-audit.mjs a.clip b.clip
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve, readTrackRange } from "../public/core/clip-animation.js";

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

const externalsOf = (data, db) => {
  const externals = new Map();
  for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
    const offset = Number(row.Offset);
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKExta") {
      externals.set(Buffer.from(row.ExternalID).toString("ascii"), data.subarray(offset + 16, offset + 16 + size));
    }
  }
  return externals;
};

for (const path of process.argv.slice(2)) {
  console.log("============ " + path);
  const data = fs.readFileSync(path);
  const db = await openDatabase(new Buffer(extractDatabase(data)));
  const externals = externalsOf(data, db);

  console.log("-- tables with rows:");
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  for (const { name } of tables) {
    let count = 0;
    try { count = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c; } catch { }
    if (count) console.log(`   ${name}: ${count}`);
  }

  const timeline = db.prepare("SELECT * FROM TimeLine").all();
  console.log("-- TimeLine rows:");
  for (const row of timeline) {
    const plain = { ...row };
    for (const k of Object.keys(plain)) {
      if (plain[k] instanceof Uint8Array) plain[k] = `<bytes ${plain[k].length}>`;
      if (typeof plain[k] === "bigint") plain[k] = Number(plain[k]);
    }
    console.log("   ", JSON.stringify(plain));
  }

  try {
    console.log("-- AnimationCutBank rows:");
    for (const row of db.prepare("SELECT * FROM AnimationCutBank").all()) {
      const plain = { ...row };
      for (const k of Object.keys(plain)) {
        if (plain[k] instanceof Uint8Array || typeof plain[k] === "string") {
          if ((row[k]?.length ?? 0) > 48) plain[k] = `<${plain[k]?.length}>`;
        }
        if (typeof plain[k] === "bigint") plain[k] = Number(plain[k]);
      }
      console.log("   ", JSON.stringify(plain));
    }
  } catch (e) { console.log("   !", e.message); }

  const uuidOf = new Map();
  for (const row of db.prepare("SELECT MainId, LayerUuid, LayerName, LayerFolder, AnimationFolder FROM Layer").all()) {
    if (row.LayerUuid) {
      uuidOf.set(String(row.LayerUuid).replace(/-/g, "").toLowerCase(), row);
    }
  }
  console.log("-- Layer rows:");
  for (const row of db.prepare(
    "SELECT MainId, LayerName, LayerFolder, AnimationFolder, LayerFirstChildIndex, LayerNextIndex FROM Layer ORDER BY MainId",
  ).all()) {
    console.log(`   #${row.MainId} "${row.LayerName}" folder=${row.LayerFolder} anim=${row.AnimationFolder} first=${row.LayerFirstChildIndex} next=${row.LayerNextIndex}`);
  }
  console.log("-- Track rows:");
  for (const track of db.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
    const layerId = Buffer.from(track.LayerUuidWithTrack ?? new Uint8Array(0))
      .toString("hex").replace(/-/g, "").toLowerCase();
    const layer = uuidOf.get(layerId);
    let detail = "";
    for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
      const id = track[column] ? Buffer.from(track[column]).toString("ascii") : null;
      const blob = id ? externals.get(id) : null;
      const document = blob ? readActionBlob(blob) : null;
      const curve = document ? readCelCurve(document) : null;
      const range = document ? readTrackRange(document) : null;
      detail += ` [${column} curve=${curve ? curve.keys.map((k) => JSON.stringify(k)).join(" ") : "none"}` +
        ` range=${range ? JSON.stringify(range) : "?"}]`;
    }
    console.log(
      `   track ${track.MainId} kind ${track.TrackKind} next ${track.TrackNextIndex}` +
      ` layer=${layer ? layer.LayerName : "?"} anim=${layer?.AnimationFolder ?? "-"}` + detail,
    );
  }

  try {
    console.log("-- other TimeLine-near tables:");
    for (const name of ["TimeLineSetting", "CutBank", "AnimationTimeLine", "RollingFrame", "StoryboardCt", "CameraTimeLine"]) {
      try {
        const rows = db.prepare(`SELECT * FROM "${name}" LIMIT 5`).all();
        if (rows.length) console.log(`   ${name} rows=` + JSON.stringify(rows.map((r) => ({ ...r, _b: undefined })))).slice(0, 600);
      } catch { }
    }
  } catch { }

  await db.close();
}
