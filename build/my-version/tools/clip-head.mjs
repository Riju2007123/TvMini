import fs from "node:fs";

for (const path of process.argv.slice(2)) {
  console.log("============ " + path);
  const buf = fs.readFileSync(path);
  let offset = 0x18;
  let index = 0;
  while (offset + 16 <= buf.length) {
    const name = buf.toString("ascii", offset, offset + 8);
    const size = Number(buf.readBigUInt64BE(offset + 8));
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > buf.length) break;
    const payload = buf.subarray(offset + 16, offset + 16 + size);
    if (name === "CHNKHead") {
      console.log("CHNKHead:", payload.toString("hex"), "|", JSON.stringify(payload.toString("latin1")));
    } else if (name === "CHNKExta") {
      const text = payload.toString("latin1", 8, 40).replace(/[^\x20-\x7e]/g, ".");
      console.log(`CHNKExta[${index}] size=${size} head4=${payload.subarray(0, 4).toString("latin1")} text=${JSON.stringify(text.slice(0, 60))}`);
    } else if (name === "CHNKSQLi") {
      console.log(`CHNKSQLi size=${size}`);
    }
    offset += 16 + size;
    index += 1;
  }
  // version-ish strings in the whole file
  const text = buf.toString("latin1");
  const hits = [...new Set([...text.matchAll(/[Vv]ersion[: ]?[\d.]+/g)].map(m => m[0]))].slice(0, 5);
  console.log("version strings:", hits.join(" | "));
}
