import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { brushPngFromBytes } from "./brush.js";

/**
 * Read a Clip Studio Paint brush.
 *
 * A `.sut` file is a SQLite database. The settings of the brush are in
 * `Variant`, its name is in `Node`, and the picture of the tip is in the
 * material files, which are ZIP files with a PNG of the texture inside.
 *
 * Only the picture and the size are taken. The other settings of a Clip
 * Studio brush describe how the brush is drawn, which is more than a picture
 * of a tip can say.
 */
export async function readSutBrush(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const db = await openDatabase(bytes);

  try {
    const node = db.prepare("SELECT NodeName FROM Node LIMIT 1").get();

    // Not every brush has every setting, so only the ones that are there
    // are asked for.
    const columns = new Set(
      db.prepare("PRAGMA table_info('Variant')").all().map((column) => column.name),
    );
    const wanted = [
      "BrushSize",
      "BrushSizeUnit",
      "TextureScale2",
      "TextureRotate",
      "BrushFlow",
      "BrushHardness",
      "BrushThickness",
    ].filter((name) => columns.has(name));
    const variant = wanted.length
      ? db.prepare(`SELECT ${wanted.join(", ")} FROM Variant ORDER BY VariantID LIMIT 1`).get()
      : null;

    let texture = null;
    try {
      const materials = db
        .prepare("SELECT FileData FROM MaterialFile ORDER BY length(FileData)")
        .all();
      for (const material of materials) {
        const png = brushPngFromBytes(Buffer.from(material.FileData));
        if (png) {
          texture = png;
          break;
        }
      }
    } catch {
      // A brush without any material file is still a brush.
    }

    if (!texture) {
      try {
        const row = db
          .prepare("SELECT TextureImage FROM Variant WHERE TextureImage IS NOT NULL LIMIT 1")
          .get();
        if (row?.TextureImage) texture = brushPngFromBytes(Buffer.from(row.TextureImage));
      } catch {
        // No texture either.
      }
    }

    if (!texture) return null;

    return {
      name: String(node?.NodeName ?? "").trim(),
      size: variant?.BrushSize ?? null,
      sizeUnit: variant?.BrushSizeUnit ?? null,
      scale: variant?.TextureScale2 ?? null,
      rotate: variant?.TextureRotate ?? null,
      flow: variant?.BrushFlow ?? null,
      hardness: variant?.BrushHardness ?? null,
      texture: {
        data: texture.toString("base64"),
        width: texture.readUInt32BE(16),
        height: texture.readUInt32BE(20),
      },
    };
  } finally {
    await db.close();
  }
}
