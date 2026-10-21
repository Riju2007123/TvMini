/**
 * Look inside a Clip Studio Paint brush (a `.sut` file).
 *
 * A `.sut` file is a SQLite database. This prints the tables, the rows and
 * the size of every blob, so the layout can be worked out from real brushes.
 *
 *   node tools/sut-inspect.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.log("usage: node tools/sut-inspect.mjs <brush.sut>");
  process.exit(1);
}

const bytes = readFileSync(file);
console.log(`${file}: ${bytes.length} bytes`);
console.log(`the header says: ${bytes.subarray(0, 16).toString("latin1")}`);

const db = new DatabaseSync(file, { readOnly: true });

const tables = db
  .prepare("SELECT name, type FROM sqlite_master ORDER BY type, name")
  .all();
console.log("\n-- the things inside --");
for (const row of tables) {
  console.log(`  ${row.type} ${row.name}`);
}

for (const { name } of tables.filter((row) => row.type === "table")) {
  const columns = db.prepare(`PRAGMA table_info('${name}')`).all();
  const count = db.prepare(`SELECT count(*) AS n FROM '${name}'`).get().n;
  console.log(`\n-- ${name} (${count} rows) --`);
  console.log(
    `  ${columns.map((column) => `${column.name}:${column.type}`).join(", ")}`,
  );
  for (const row of db.prepare(`SELECT * FROM '${name}' LIMIT 6`).all()) {
    const parts = [];
    for (const [key, value] of Object.entries(row)) {
      if (value === null) {
        parts.push(`${key}=null`);
      } else if (value instanceof Uint8Array) {
        parts.push(`${key}=<${value.length} bytes>`);
      } else {
        const text = String(value);
        parts.push(`${key}=${text.length > 70 ? `${text.slice(0, 70)}...` : text}`);
      }
    }
    console.log(`  ${parts.join(" | ")}`);
  }
}

db.close();
