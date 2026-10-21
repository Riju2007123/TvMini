/**
 * Compare a brush this program wrote with a brush Clip Studio Paint wrote.
 *
 *   node tools/sut-compare.mjs "C:\path\to\a-real-brush.sut" "C:\path\to\our-brush.sut"
 *
 * The two files are opened as databases and the tables, the columns and the
 * values are compared, so it is clear that the file this program writes has
 * the shape Clip Studio Paint expects.
 */
import { DatabaseSync } from "node:sqlite";

const [left, right] = process.argv.slice(2);
if (!left || !right) {
  console.log("usage: node tools/sut-compare.mjs <real.sut> <ours.sut>");
  process.exit(1);
}

function open(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name)
    .filter((name) => name !== "sqlite_sequence");
  const columns = {};
  for (const table of tables) {
    columns[table] = db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
  }
  const rows = {};
  for (const table of tables) {
    rows[table] = db.prepare(`SELECT * FROM '${table}'`).all();
  }
  db.close();
  return { tables, columns, rows };
}

const a = open(left);
const b = open(right);

console.log(`the tables of ${left}: ${a.tables.join(", ")}`);
console.log(`the tables of ${right}: ${b.tables.join(", ")}`);

for (const table of a.tables) {
  if (!b.tables.includes(table)) {
    console.log(`  the table ${table} is missing`);
    continue;
  }
  const missing = a.columns[table].filter((name) => !b.columns[table].includes(name));
  const extra = b.columns[table].filter((name) => !a.columns[table].includes(name));
  console.log(
    `  ${table}: ${a.columns[table].length} columns in the first, ${b.columns[table].length} in the second` +
      (missing.length ? `, missing: ${missing.join(", ")}` : "") +
      (extra.length ? `, extra: ${extra.join(", ")}` : ""),
  );
}

// The settings that both files have.
const variantA = a.rows.Variant?.[0] ?? {};
const variantB = b.rows.Variant?.[0] ?? {};
const same = [];
const different = [];
for (const [key, value] of Object.entries(variantA)) {
  if (!(key in variantB)) continue;
  const other = variantB[key];
  const left_ = value instanceof Uint8Array ? `<${value.length} bytes>` : value;
  const right_ = other instanceof Uint8Array ? `<${other.length} bytes>` : other;
  if (left_ === right_) same.push(key);
  else different.push(`${key}: ${left_} -> ${right_}`);
}
console.log(`\n${same.length} settings are the same in both files`);
console.log(`${different.length} settings are different:`);
for (const line of different.slice(0, 40)) console.log(`  ${line}`);
if (different.length > 40) console.log(`  ... and ${different.length - 40} more`);
