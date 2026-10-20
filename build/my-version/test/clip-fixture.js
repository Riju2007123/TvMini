import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Buffer } from "../public/core/bytes.js";
import { buildBlockRecord, buildTrailers, encodeRgbaBlock } from "../public/core/clip-blocks.js";

/**
 * Build a tiny but genuine CSFCHUNK container around an SQLite database with
 * a CanvasPreview table, mirroring how Clip Studio Paint stores its preview.
 *
 * `layers` and `project` are optional: they add the Project, Canvas and Layer
 * tables that the native document reader inspects, so a test can cover the
 * layer metadata path as well as the preview path.
 *
 * `raster` is optional as well: it adds an `ExternalChunk` blob and the
 * Offscreen, Mipmap and MipmapInfo rows that point at it, so a test can
 * cover the path where the pixels live outside the database.
 */
export async function writeClipFixture(
  target,
  {
    width = 32,
    height = 24,
    png,
    corrupt = false,
    project = null,
    layers = null,
    raster = null,
  },
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
          LayerOpacity INTEGER,
          LayerRenderMipmap INTEGER
        )`,
      );
      const insert = db.prepare(
        "INSERT INTO Layer VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
          layer.mipmap ?? 0,
        );
      }
    }

    if (raster) {
      // The tables that hold a raster: the layer points at a mipmap, the
      // mipmap points at the chain of mipmap levels, and every level points
      // at an offscreen. The offscreen names the blob that holds the tiles.
      db.exec(
        `CREATE TABLE Offscreen (
          MainId INTEGER PRIMARY KEY,
          LayerId INTEGER,
          Attribute BLOB,
          BlockData BLOB
        )`,
      );
      db.exec(
        "CREATE TABLE Mipmap (MainId INTEGER PRIMARY KEY, LayerId INTEGER, BaseMipmapInfo INTEGER)",
      );
      db.exec(
        "CREATE TABLE MipmapInfo (MainId INTEGER PRIMARY KEY, LayerId INTEGER, ThisScale REAL, Offscreen INTEGER, NextIndex INTEGER)",
      );
      db.exec("CREATE TABLE ExternalChunk (ExternalID TEXT, Offset INTEGER)");
      // The first external chunk sits right after the head chunk, so its
      // offset is known before the file is written.
      db.prepare("INSERT INTO ExternalChunk VALUES (?, ?)").run(
        raster.id,
        0x18 + 16 + 40,
      );
      db.prepare("INSERT INTO Offscreen VALUES (?, ?, ?, ?)").run(
        1,
        raster.layerId ?? 1,
        raster.attribute ?? Buffer.alloc(0),
        Buffer.from(raster.id, "ascii"),
      );
      db.prepare("INSERT INTO Mipmap VALUES (?, ?, ?)").run(
        1,
        raster.layerId ?? 1,
        1,
      );
      db.prepare("INSERT INTO MipmapInfo VALUES (?, ?, ?, ?, ?)").run(
        1,
        raster.layerId ?? 1,
        100,
        1,
        0,
      );
    }
  } finally {
    db.close();
  }

  const dbBytes = corrupt ? Buffer.from("this is not a database") : await fs.readFile(dbPath);
  await fs.rm(dbPath, { force: true });

  // The container is laid out the way Clip Studio Paint writes it: the
  // header, then CHNKHead, then the external blobs, then the database and
  // then the terminator.
  const header = Buffer.alloc(0x18);
  header.write("CSFCHUNK", 0, "ascii");
  // The header records the size of the file and of the header itself.
  header.writeBigUInt64BE(0x18n, 16);

  const head = Buffer.alloc(40);
  head.writeBigUInt64BE(256n, 0);
  head.writeBigUInt64BE(16n, 16);

  const externalChunks = [];
  if (raster) {
    const payload = Buffer.concat([
      Buffer.alloc(8),
      Buffer.from(raster.id, "ascii"),
      Buffer.alloc(8),
      raster.payload,
    ]);
    payload.writeBigUInt64BE(40n, 0);
    payload.writeBigUInt64BE(BigInt(raster.payload.length), 48);
    externalChunks.push({ id: raster.id, payload });
  }

  const database = Buffer.alloc(16);
  database.write("CHNKSQLi", 0, "ascii");
  database.writeBigUInt64BE(BigInt(dbBytes.length), 8);

  const foot = Buffer.alloc(16);
  foot.write("CHNKFoot", 0, "ascii");

  // The first external chunk starts right after the head chunk, at 80.
  let position = 0x18 + 16 + head.length;
  const externalParts = [];
  for (const entry of externalChunks) {
    externalParts.push({ id: entry.id, offset: position });
    position += 16 + entry.payload.length;
  }
  const databaseOffset = position;
  head.writeBigUInt64BE(BigInt(databaseOffset), 8);

  const parts = [header, Buffer.alloc(16), head];
  for (const entry of externalChunks) {
    // Sixteen bytes of chunk header, then the payload. The name and the size
    // are written into the header further down.
    parts.push(Buffer.alloc(16), entry.payload);
  }
  parts.push(database, dbBytes, foot);
  // The chunk header is an eight byte name and the size of the payload.
  const out = Buffer.concat(parts);
  let cursor = 0x18;
  out.write("CHNKHead", cursor, "ascii");
  out.writeBigUInt64BE(BigInt(head.length), cursor + 8);
  cursor += 16 + head.length;
  for (const entry of externalChunks) {
    out.write("CHNKExta", cursor, "ascii");
    out.writeBigUInt64BE(BigInt(entry.payload.length), cursor + 8);
    cursor += 16 + entry.payload.length;
  }
  out.writeBigUInt64BE(BigInt(out.length), 8);
  await fs.writeFile(target, out);
}

/**
 * Build the `Offscreen.Attribute` blob that describes a raster.
 *
 * The blob holds three sections after the size table: the parameters, the
 * initial colour and the table of block sizes.
 */
export function buildOffscreenAttribute({ width, height, blockWidth = 256, blockHeight = 256, blockSizes }) {
  const cols = Math.ceil(width / blockWidth);
  const rows = Math.ceil(height / blockHeight);
  const count = cols * rows;
  const sizes = blockSizes ?? Array(count).fill(104);

  const parameter = Buffer.alloc(102);
  parameter.writeUInt32BE(width, 22);
  parameter.writeUInt32BE(height, 26);
  parameter.writeUInt32BE(cols, 30);
  parameter.writeUInt32BE(rows, 34);
  parameter.writeUInt32BE(33, 38);
  parameter.writeUInt32BE(4, 46);
  parameter.writeUInt32BE(5, 50);
  parameter.writeUInt32BE(blockHeight, 78);
  parameter.writeUInt32BE(blockWidth, 82);

  const initColor = Buffer.alloc(42);
  initColor.writeUInt32BE(12, 22);
  initColor.writeUInt32BE(0, 26);

  const blockSize = Buffer.alloc(34 + sizes.length * 4);
  blockSize.writeUInt32BE(12, 22);
  blockSize.writeUInt32BE(count, 26);
  blockSize.writeUInt32BE(4, 30);
  sizes.forEach((size, index) => blockSize.writeUInt32BE(size, 34 + index * 4));

  const u32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer;
  };
  return Buffer.concat([
    u32(16),
    u32(parameter.length),
    u32(initColor.length),
    u32(blockSize.length),
    parameter,
    initColor,
    blockSize,
  ]);
}

/** Build the tile records of one raster, the way CSP stores them. */
export function buildRasterPayload({ width, height, blockWidth = 256, blockHeight = 256, pixels }) {
  const cols = Math.ceil(width / blockWidth);
  const rows = Math.ceil(height / blockHeight);
  const records = [];
  const sizes = [];
  for (let index = 0; index < cols * rows; index += 1) {
    const row = Math.floor(index / cols);
    const column = index % cols;
    const tile = Buffer.alloc(blockWidth * blockHeight * 4);
    const sourceWidth = Math.min(blockWidth, width - column * blockWidth);
    const sourceHeight = Math.min(blockHeight, height - row * blockHeight);
    let hasAlpha = false;
    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const source = ((row * blockHeight + y) * width + column * blockWidth + x) * 4;
        const target = (y * blockWidth + x) * 4;
        tile[target] = pixels[source];
        tile[target + 1] = pixels[source + 1];
        tile[target + 2] = pixels[source + 2];
        tile[target + 3] = pixels[source + 3];
        if (pixels[source + 3] !== 0) hasAlpha = true;
      }
    }
    const record = buildBlockRecord(
      index,
      hasAlpha ? encodeRgbaBlock(tile, blockWidth, blockHeight) : null,
      blockWidth,
      blockHeight,
    );
    records.push(record);
    sizes.push(record.length);
  }
  return { payload: Buffer.concat([...records, buildTrailers(records.length)]), sizes };
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
