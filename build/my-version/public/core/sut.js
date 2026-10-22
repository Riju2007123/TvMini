import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { brushPngFromBytes, biggestBrushPngFromBytes } from "./brush.js";
import { readTar } from "./tar.js";
import { decodePng } from "./png.js";

/**
 * Read a Clip Studio Paint brush.
 *
 * A `.sut` file is a SQLite database. The settings of the brush are in
 * `Variant`, its name is in `Node`, and the picture of the tip is in the
 * material files, which are TAR archives that hold a few pictures and a
 * small XML file.
 *
 * The picture of the tip is the one in `data/material_0.layer`; the other
 * pictures in the material are a tiny placeholder for the list of materials
 * and a thumbnail, so they are only used when there is no tip.
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
      "BrushInterval",
      "Opacity",
    ].filter((name) => columns.has(name));
    const variant = wanted.length
      ? db.prepare(`SELECT ${wanted.join(", ")} FROM Variant ORDER BY VariantID LIMIT 1`).get()
      : null;

    let materials = [];
    try {
      materials = db.prepare("SELECT FileData FROM MaterialFile").all();
    } catch {
      // A brush without any material file is still a brush.
    }

    let texture = tipFromMaterials(materials);

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

    if (!texture) {
      // Nothing that says what the tip is: the first picture in the file is
      // the best that is left.
      for (const material of materials) {
        const png = brushPngFromBytes(Buffer.from(material.FileData));
        if (png) {
          texture = png;
          break;
        }
      }
    }

    if (!texture) return null;

    return {
      name: String(node?.NodeName ?? "").trim(),
      size: variant?.BrushSize ?? null,
      sizeUnit: variant?.BrushSizeUnit ?? null,
      opacity: variant?.Opacity ?? null,
      flow: variant?.BrushFlow ?? null,
      hardness: variant?.BrushHardness ?? null,
      thickness: variant?.BrushThickness ?? null,
      spacing: variant?.BrushInterval ?? null,
      scale: variant?.TextureScale2 ?? null,
      rotate: variant?.TextureRotate ?? null,
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

/**
 * The picture of the tip of a brush.
 *
 * The material of a brush is a TAR archive. The tip of the brush is kept as
 * the thumbnail of the material: the picture in `data/material_0.layer` is
 * written by Clip Studio Paint in a way that cannot be read, but the
 * thumbnail is a plain picture of the same tip.
 *
 * A brush can have more than one material: a brush that has a grain of paper
 * as well keeps that in another material. The material that says it is a
 * brush shape is the one with the tip in it.
 */
function tipFromMaterials(materials) {
  const shapes = materials.filter((material) => materialIsBrushShape(material));
  const list = shapes.length ? shapes : materials;

  // The thumbnail with the most paint in it is the tip.
  let best = null;
  let bestInk = 0;
  for (const material of list) {
    for (const file of tarEntries(material)) {
      if (!file.name.includes("thumbnail")) continue;
      const png = brushPngFromBytes(file.data);
      if (!png) continue;
      const ink = inkInPicture(png);
      if (ink > bestInk) {
        best = png;
        bestInk = ink;
      }
    }
  }
  if (best) return best;

  // Nothing that says what the tip is: the biggest picture is the best that
  // is left.
  for (const material of list) {
    for (const file of tarEntries(material)) {
      if (!file.name.startsWith("data/")) continue;
      const png = biggestBrushPngFromBytes(file.data);
      if (png) return png;
    }
  }
  return null;
}

/** How much of a picture is not see-through. */
function inkInPicture(png) {
  try {
    const image = decodePng(png);
    let ink = 0;
    for (let index = 3; index < image.data.length; index += 4) {
      if (image.data[index] > 8) ink += 1;
    }
    return ink;
  } catch {
    // A picture that cannot be read holds nothing.
    return 0;
  }
}

/** The files inside the material of a brush. */
function tarEntries(material) {
  try {
    return readTar(Buffer.from(material.FileData));
  } catch {
    // Not an archive: the next material is tried.
    return [];
  }
}

/**
 * Whether a material holds the shape of a brush.
 *
 * The material says what it is in a small XML file: a brush shape is marked
 * with "BrushPattern", while a grain of paper is marked with "PaperTexture".
 */
function materialIsBrushShape(material) {
  for (const file of tarEntries(material)) {
    if (!file.name.endsWith(".xml")) continue;
    if (file.data.toString("utf8").includes("BrushPattern")) return true;
  }
  return false;
}
