// Decode the Track table of several real CSP animation documents:
// TrackValueMap bytes, mixer presence/sizes, kinds. This decides where the
// per-frame timing lives and whether TrackActionMixer2 is optional.
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    if (!/^[\x20-\xe]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) return null;
    offset += 16 + size;
  }
  return null;
}

for (const file of process.argv.slice(2)) {
  console.log(`\n===== ${file}`);
  try {
    const data = fs.readFileSync(file);
    const raw = extractDatabase(data);
    if (!raw) { console.log("  no database"); continue; }
    const db = await openDatabase(new Buffer(raw));
    const cols = new Set(db.prepare("PRAGMA table_info(Track)").all().map((c) => c.name));
    const wants = ["MainId", "TrackKind", "TrackActionMixerSize", "TrackActionMixer", "TrackActionMixer2Size", "TrackActionMixer2", "TrackValueMap", "LayerUuidWithTrack", "TrackNextIndex", "TrackOptionFlag"]
      .filter((c) => cols.has(c));
    const tracks = db.prepare(`SELECT ${wants.map((c) => `[${c}]`).join(", ")} FROM Track ORDER BY MainId`).all();
    for (const t of tracks) {
      const map = t.TrackValueMap ? Buffer.from(t.TrackValueMap) : null;
      let mapText = "null";
      if (map) {
        mapText = map.toString("hex");
        if (map.length > 64) mapText = mapText.slice(0, 128) + `… (${map.length} bytes)`;
        // try a "count+values" reading
        const words = [];
        for (let i = 0; i + 4 <= map.length; i += 4) words.push(map.readUInt32LE(i));
        mapText += `  LE u32s=[${words.slice(0, 14).join(", ")}${words.length > 14 ? ",…" : ""}]`;
      }
      const mixer1 = t.TrackActionMixer ? Buffer.from(t.TrackActionMixer).toString("ascii").slice(0, 16) + "…" : "null";
      const mixer2 = t.TrackActionMixer2 ? Buffer.from(t.TrackActionMixer2).toString("ascii").slice(0, 16) + "…" : "null";
      console.log(`  track ${t.MainId}: kind=${t.TrackKind} next=${t.TrackNextIndex} opt=${t.TrackOptionFlag} mixer=${mixer1} (${t.TrackActionMixerSize}) mixer2=${mixer2} (${t.TrackActionMixer2Size}) valueMap=${mapText}`);
    }
    const tl = db.prepare("SELECT * FROM TimeLine LIMIT 1").get();
    if (tl) console.log(`  TimeLine: fps=${tl.FrameRate} start=${tl.StartFrame} end=${tl.EndFrame} firstTrack=${tl.FirstTrack} cut=${tl.CutIndexForName} scene=${tl.SceneIndexForName}`);
    await db.close();
  } catch (e) {
    console.log(`  error: ${e.message}`);
  }
}
