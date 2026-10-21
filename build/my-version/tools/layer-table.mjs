import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    offset += 16 + size;
  }
  return null;
}

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));
for (const row of db.prepare(
  "SELECT MainId, LayerName, LayerFolder, LayerType, LayerFirstChildIndex, LayerNextIndex, AnimationFolder FROM Layer ORDER BY MainId",
).all()) {
  console.log(
    `${String(row.MainId).padStart(3)} ${JSON.stringify(row.LayerName).padEnd(22)} ` +
    `folder=${String(row.LayerFolder).padStart(3)} type=${String(row.LayerType).padStart(4)} ` +
    `first=${String(row.LayerFirstChildIndex).padStart(3)} next=${String(row.LayerNextIndex).padStart(3)} ` +
    `anim=${row.AnimationFolder ?? ""}`,
  );
}
await db.close();
