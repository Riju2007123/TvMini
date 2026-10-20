import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { validateClipBytes } from "../public/core/clip-validate.js";
import { createProject } from "../src/model.js";
import { createClipBuffer } from "../src/clip-write.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(here, "..", "public", "assets", "clip-template.clip");

/**
 * Walk the container of a `.clip` and return the chunks.
 *
 * The test needs to take a document apart and put it back together, so the
 * chunk layout is spelled out here rather than borrowed from the code under
 * test.
 */
function readChunks(data) {
  const chunks = [];
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size)) break;
    if (offset + 16 + size > data.length) break;
    chunks.push({ name, size, payload: data.subarray(offset + 16, offset + 16 + size) });
    offset += 16 + size;
  }
  return chunks;
}

/**
 * Put a document back together around a new database image.
 *
 * The external blobs keep their place, so the offset the head chunk records
 * for the database stays right; only the size of the file changes.
 */
function rebuild(chunks, database) {
  const header = Buffer.alloc(0x18);
  header.write("CSFCHUNK", 0, "ascii");
  header.writeBigUInt64BE(0x18n, 16);
  const parts = [header];
  for (const chunk of chunks) {
    const payload = chunk.name === "CHNKSQLi" ? database : chunk.payload;
    const head = Buffer.alloc(16);
    head.write(chunk.name, 0, "ascii");
    head.writeBigUInt64BE(BigInt(payload.length), 8);
    parts.push(head, payload);
  }
  const out = Buffer.concat(parts);
  out.writeBigUInt64BE(BigInt(out.length), 8);
  return out;
}

/**
 * Take the template, break it in one specific way and hand back the result.
 */
async function broken(breakIt) {
  const original = new Buffer(fs.readFileSync(TEMPLATE));
  const chunks = readChunks(original);
  const databaseChunk = chunks.find((chunk) => chunk.name === "CHNKSQLi");
  const database = await openDatabase(new Buffer(databaseChunk.payload));
  try {
    breakIt(database);
    const image = await database.export();
    return rebuild(chunks, new Buffer(image));
  } finally {
    await database.close();
  }
}

/** The offscreen that holds the pixels of the drawing layer. */
const DRAWING_OFFSCREEN = `
  SELECT mi.Offscreen FROM Layer l
  JOIN Mipmap m ON m.MainId = l.LayerRenderMipmap
  JOIN MipmapInfo mi ON mi.MainId = m.BaseMipmapInfo
  WHERE l.LayerType = 1 AND l.LayerFolder = 0
  ORDER BY l.MainId LIMIT 1`;

/** The id of the blob that holds the pixels of the drawing layer. */
const DRAWING_BLOB = `
  SELECT o.BlockData FROM Layer l
  JOIN Mipmap m ON m.MainId = l.LayerRenderMipmap
  JOIN MipmapInfo mi ON mi.MainId = m.BaseMipmapInfo
  JOIN Offscreen o ON o.MainId = mi.Offscreen
  WHERE l.LayerType = 1 AND l.LayerFolder = 0
  ORDER BY l.MainId LIMIT 1`;

test("a document Clip Studio Paint wrote passes the check", async () => {
  const original = new Buffer(fs.readFileSync(TEMPLATE));
  const result = await validateClipBytes(original);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test("a document the writer produced passes the check", async () => {
  const project = createProject(320, 240, "#ffffff");
  project.layers[0].drawings = [
    { at: 1, hold: 2, strokes: [{ color: "#ff0000", width: 10, points: [[40, 40], [280, 200]] }] },
  ];
  const written = await createClipBuffer(project, { name: "checked" });
  const result = await validateClipBytes(new Buffer(written.buffer));
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test("a mipmap count that lies about the chain is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE Mipmap SET MipmapCount = MipmapCount + 1 WHERE MainId = 3").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /MipmapCount/.test(p)), result.problems.join("; "));
});

test("a layer tree that loops is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE Layer SET LayerNextIndex = MainId WHERE MainId = 3").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /loops/.test(p)), result.problems.join("; "));
});

test("a layer that the tree does not reach is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE Layer SET LayerFirstChildIndex = 0 WHERE MainId = 2").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /unreachable/.test(p)), result.problems.join("; "));
});

test("a canvas that points at a deleted layer is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE Canvas SET CanvasCurrentLayer = 9999").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /CanvasCurrentLayer/.test(p)), result.problems.join("; "));
});

test("a block id stored as text is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE Offscreen SET BlockData = CAST(BlockData AS TEXT)").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /BlockData must be stored as blob/.test(p)), result.problems.join("; "));
});

test("an external id stored as bytes is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE ExternalChunk SET ExternalID = CAST(ExternalID AS BLOB)").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /ExternalID must be stored as text/.test(p)), result.problems.join("; "));
});

test("an external row that points at nothing is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE ExternalChunk SET Offset = 999999").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /is not a blob header/.test(p)), result.problems.join("; "));
});

test("an external row that was lost is caught", async () => {
  const file = await broken((db) => {
    db.prepare("DELETE FROM ExternalChunk WHERE Offset = (SELECT MIN(Offset) FROM ExternalChunk)").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /rows but the file has/.test(p)), result.problems.join("; "));
});

test("a drawing layer whose pixels are not in the file is reported", async () => {
  // Clip Studio Paint's own files have empty layers, so this is reported
  // rather than counted as a fault. The writer knows which layers it filled
  // and refuses to write a file where one of them lost its pixels.
  const file = await broken((db) => {
    db.prepare(
      `UPDATE Offscreen SET BlockData = 'extrnlid0000000000000000000000000000'
       WHERE MainId = (${DRAWING_OFFSCREEN})`,
    ).run();
  });
  const result = await validateClipBytes(file);
  assert.ok(result.notes.some((p) => /no pixels/.test(p)), result.notes.join("; "));
});

test("a broken mipmap chain is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE MipmapInfo SET NextIndex = 9999 WHERE MainId = 7").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => /chain breaks/.test(p) || /MipmapCount/.test(p)),
    result.problems.join("; "),
  );
});

test("an offscreen that belongs to no layer is caught", async () => {
  const file = await broken((db) => {
    db.prepare("UPDATE Offscreen SET LayerId = 9999 WHERE MainId = 3").run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /orphan rows/.test(p)), result.problems.join("; "));
});

test("a blob that nothing points at is reported", async () => {
  // Clip Studio Paint keeps blobs that no column points at, so this is
  // information and not a fault.
  const file = await broken((db) => {
    db.prepare(
      "INSERT INTO ExternalChunk (ExternalID, Offset) VALUES ('extrnlid1111111111111111111111111111', 12345)",
    ).run();
  });
  const result = await validateClipBytes(file);
  assert.ok(result.notes.some((p) => /no column points at them/.test(p)), result.notes.join("; "));
});

test("the id inside a blob is the id the database names", async () => {
  // The blob in the file carries its own id and the database names the same
  // one. When the two disagree the layer that needs the blob cannot find
  // it, and CSP opens that layer empty.
  const original = new Buffer(fs.readFileSync(TEMPLATE));
  const chunks = readChunks(original);
  const databaseChunk = chunks.find((chunk) => chunk.name === "CHNKSQLi");
  const database = await openDatabase(new Buffer(databaseChunk.payload));
  const rows = database.prepare("SELECT ExternalID FROM ExternalChunk").all();
  await database.close();

  const inFile = new Set();
  for (const chunk of chunks) {
    if (chunk.name !== "CHNKExta") continue;
    inFile.add(chunk.payload.toString("ascii", 8, 48));
  }
  const inDatabase = new Set(
    rows.map((row) =>
      typeof row.ExternalID === "string"
        ? row.ExternalID
        : Buffer.from(row.ExternalID).toString("ascii"),
    ),
  );

  assert.equal(inFile.size, inDatabase.size);
  for (const id of inFile) {
    assert.ok(inDatabase.has(id), `the database does not name ${id}`);
  }
});

test("a blob whose id the database does not name is caught", async () => {
  const file = await broken((db) => {
    db.prepare(
      "UPDATE ExternalChunk SET ExternalID = 'extrnlid2222222222222222222222222222' WHERE Offset = (SELECT MIN(Offset) FROM ExternalChunk)",
    ).run();
  });
  const result = await validateClipBytes(file);
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => /does not name it|does not hold it/.test(p)),
    result.problems.join("; "),
  );
});
