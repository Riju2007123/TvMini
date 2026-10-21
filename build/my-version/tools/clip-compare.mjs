/**
 * Compare two .clip documents.
 *
 *   node tools/clip-compare.mjs a.clip b.clip
 *
 * Every table of the two documents is printed side by side, and the rows
 * that differ are marked. It is the tool to use when a document Clip Studio
 * Paint wrote is compared with one the writer wrote: the difference that
 * matters is the one in the rows the animation is made of.
 */
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

const show = (value) => {
  if (value === null || value === undefined) return "-";
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "string" && value.length > 60) return value.slice(0, 60) + "…";
  return String(value);
};

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  console.log("usage: node tools/clip-compare.mjs a.clip b.clip");
  process.exit(1);
}

const open = async (file) => {
  const data = fs.readFileSync(file);
  const database = await openDatabase(new Buffer(extractDatabase(data)));
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  return { data, database, tables };
};

const a = await open(first);
const b = await open(second);

for (const table of a.tables) {
  const rowsA = a.database.prepare(`SELECT * FROM "${table}"`).all();
  const rowsB = b.tables.includes(table) ? b.database.prepare(`SELECT * FROM "${table}"`).all() : [];
  const columns = rowsA.length
    ? Object.keys(rowsA[0]).filter((name) => name !== "_PW_ID")
    : rowsB.length
      ? Object.keys(rowsB[0]).filter((name) => name !== "_PW_ID")
      : [];

  const interesting = /Layer|Track|TimeLine|CutBank|Comp|Canvas|Project/i.test(table);
  if (!interesting && rowsA.length === rowsB.length) continue;

  console.log(`\n=== ${table}: ${rowsA.length} row(s) vs ${rowsB.length} row(s)`);
  if (!columns.length) continue;
  for (let index = 0; index < Math.max(rowsA.length, rowsB.length); index += 1) {
    const rowA = rowsA[index] ?? {};
    const rowB = rowsB[index] ?? {};
    const differences = columns.filter(
      (column) => show(rowA[column]) !== show(rowB[column]),
    );
    const label = rowA.LayerName ?? rowA.TrackKind ?? rowA.TimeLineName ?? rowA.MainId ?? index;
    if (!differences.length) {
      console.log(`  ${index} (${label}): the same`);
      continue;
    }
    console.log(`  ${index} (${label}):`);
    for (const column of differences) {
      console.log(`      ${column}: ${show(rowA[column])} -> ${show(rowB[column])}`);
    }
  }
}

await a.database.close();
await b.database.close();
