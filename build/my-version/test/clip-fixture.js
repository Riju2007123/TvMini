import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

/**
 * Build a tiny but genuine CSFCHUNK container around an SQLite database with
 * a CanvasPreview table, mirroring how Clip Studio Paint stores its preview.
 *
 * `layers` and `project` are optional: they add the Project, Canvas and Layer
 * tables that the native document reader inspects, so a test can cover the
 * layer metadata path as well as the preview path.
 */
export async function writeClipFixture(
  target,
  { width = 32, height = 24, png, corrupt = false, project = null, layers = null },
) {
  const dbPath = `${target}.db`;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE CanvasPreview (_PW_ID INTEGER PRIMARY KEY, ImageWidth INTEGER, ImageHeight INTEGER, ImageData BLOB)",
    );
    if (!corrupt) {
      db.prepare(
        "INSERT INTO CanvasPreview (_PW_ID, ImageWidth, ImageHeight, ImageData) VALUES (1, ?, ?, ?)",
      ).run(width, height, png);
    }

    if (project) {
      db.exec(
        "CREATE TABLE Project (ProjectName TEXT, DefaultPageWidth INTEGER, DefaultPageHeight INTEGER)",
      );
      db.prepare("INSERT INTO Project VALUES (?, ?, ?)").run(
        project.name ?? "",
        project.width ?? 0,
        project.height ?? 0,
      );
      db.exec("CREATE TABLE Canvas (CanvasWidth INTEGER, CanvasHeight INTEGER)");
      db.prepare("INSERT INTO Canvas VALUES (?, ?)").run(
        project.width ?? 0,
        project.height ?? 0,
      );
    }

    if (layers) {
      db.exec(
        `CREATE TABLE Layer (
          MainId INTEGER PRIMARY KEY,
          LayerName TEXT,
          LayerType INTEGER,
          LayerFolder INTEGER,
          LayerVisibility INTEGER,
          LayerLock INTEGER,
          LayerOpacity INTEGER
        )`,
      );
      const insert = db.prepare(
        "INSERT INTO Layer VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const layer of layers) {
        insert.run(
          layer.id,
          layer.name ?? "",
          layer.type ?? 0,
          layer.folder ?? 0,
          layer.visible ?? 1,
          layer.locked ?? 0,
          layer.opacity ?? 256,
        );
      }
    }
  } finally {
    db.close();
  }

  const dbBytes = corrupt ? Buffer.from("this is not a database") : await fs.readFile(dbPath);
  await fs.rm(dbPath, { force: true });

  const header = Buffer.alloc(0x18);
  header.write("CSFCHUNK", 0, "ascii");

  const database = Buffer.alloc(16);
  database.write("CHNKSQLi", 0, "ascii");
  database.writeBigUInt64BE(BigInt(dbBytes.length), 8);

  const trailing = Buffer.alloc(16);
  trailing.write("CHNKHead", 0, "ascii");
  trailing.writeBigUInt64BE(0n, 8);

  await fs.writeFile(target, Buffer.concat([header, database, dbBytes, trailing]));
}

/** Solid-colour RGB buffer. */
export function solid(width, height, [r, g, b]) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return data;
}
