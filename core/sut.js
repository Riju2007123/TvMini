import { Buffer } from "./bytes.js";
import { openDatabase } from "./sqlite.js";
import { brushPngFromBytes, biggestBrushPngFromBytes } from "./brush.js";
import { readTar } from "./tar.js";
import { decodePng, encodeRgbaPng, scaleRgba } from "./png.js";
import { parseEffector } from "./sut-effector.js";
import { normalizeDynamics } from "./brush-dynamics.js";

/** The longest side of the picture of a grain that is kept with a brush. */
const GRAIN_SIZE = 160;

/** How many steps of cover the picture of a grain keeps. */
const GRAIN_LEVELS = 16;

/**
 * Read a Clip Studio Paint brush.
 *
 * A `.sut` file is a SQLite database. The settings of the brush are in
 * `Variant`, its name is in `Node`, and the pictures are in the material
 * files, which are TAR archives that hold a few pictures and a small XML file.
 *
 * Three things come out of the file:
 *
 *   - the picture of the tip, which is what the brush draws with;
 *   - what the brush does with its paint: its size, its strength, its flow,
 *     its hardness, its thickness, its spacing, how its tip turns, the curves
 *     that follow the hand (the effectors) and the grain of the paper;
 *   - the bytes of the file itself.
 *
 * The bytes are handed back on purpose. A `.sut` holds far more than this
 * program paints with - a dual brush, the mixing of colours, the spray, the
 * watercolour edge, every column Clip Studio Paint keeps for its own sliders -
 * and a brush that is written out again has to keep all of it. `sut-write.js`
 * therefore writes the file it was given and changes only what was asked for,
 * and the bytes kept here are what makes that possible.
 */
export async function readSutBrush(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const db = await openDatabase(bytes);

  try {
    const node = db.prepare("SELECT NodeName FROM Node LIMIT 1").get();

    // Not every brush has every setting, so only the ones that are there are
    // asked for.
    const columns = new Set(
      db.prepare("PRAGMA table_info('Variant')").all().map((column) => column.name),
    );
    const wanted = [
      // how the brush paints
      "BrushSize",
      "BrushSizeUnit",
      "Opacity",
      "BrushFlow",
      "BrushHardness",
      "BrushThickness",
      "BrushVerticalThicknes",
      "BrushInterval",
      "BrushAutoIntervalType",
      "AntiAlias",
      "CompositeMode",
      "BrushAtLeast1Pixel",
      // how the tip turns and how it is laid down
      "BrushRotation",
      "BrushRotationEffector",
      "BrushRotationRandomScale",
      "BrushUsePatternImage",
      // the paper of the brush
      "TextureScale2",
      "TextureRotate",
      "TextureDensity",
      "TextureReverseDensity",
      "TextureCompositeMode",
      "TextureForPlot",
      // the curves that follow the hand
      "BrushSizeEffector",
      "BrushOpacityEffector",
      "BrushFlowEffector",
      "BrushIntervalEffector",
      "BrushThicknessEffector",
      "BrushRotationEffector",
      "TextureDensityEffector",
      // the settings this program does not paint with, but tells the user about
      "UseDualBrush",
      "BrushUseWaterColor",
      "BrushUseSpray",
      "BrushRibbon",
      "BrushUseRevision",
      "BrushRevision",
      "BrushInOutType",
      "BrushUseIn",
      "BrushInLength",
      "BrushInLengthUnit",
      "BrushUseOut",
      "BrushOutLength",
      "BrushOutLengthUnit",
      "BrushInOutBySpeed",
      "BrushUseWaterEdge",
      "BrushWaterEdgeRadius",
      "BrushWaterEdgeRadiusUnit",
      "BrushInOutTarget",
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

    const value = (key, fallback = null) => variant?.[key] ?? fallback;

    // A brush with no settings row at all is not a brush; a brush with a
    // settings row and no picture is a round brush, which is a brush too.
    if (!variant) return null;

    const dynamics = normalizeDynamics({
      size: readEffector(variant, "BrushSizeEffector"),
      opacity: readEffector(variant, "BrushOpacityEffector"),
      flow: readEffector(variant, "BrushFlowEffector"),
      interval: readEffector(variant, "BrushIntervalEffector"),
      thickness: readEffector(variant, "BrushThicknessEffector"),
      rotation: readEffector(variant, "BrushRotationEffector"),
      paper: readEffector(variant, "TextureDensityEffector"),
    });

    const grain = grainFromMaterials(materials, variant);

    const rotation = rotationOf(
      value("BrushRotationEffector"),
      value("BrushRotationRandomScale"),
    );

    return {
      name: String(node?.NodeName ?? "").trim(),

      // The width of the brush, and the unit it is measured in (0 is pixels).
      size: value("BrushSize"),
      sizeUnit: value("BrushSizeUnit"),
      opacity: value("Opacity"),

      // How the paint goes down.
      flow: value("BrushFlow"),
      hardness: value("BrushHardness"),
      thickness: value("BrushThickness"),
      spacing: value("BrushInterval"),
      autoInterval: value("BrushAutoIntervalType"),

      // The turn of the tip. `BrushRotationEffector` is a small bit field:
      // 3 is a fixed angle, 0x43 and 0xC3 turn the tip along the line, 0x80
      // shakes it at random, and 0x20 and 0x10 are the barrel and the
      // direction of the pen, which this program does not have. A brush that
      // carries the low bits of the line with an input that is not known is
      // read as following the line, which is what those bits say. The raw
      // number is kept so that writing the brush out changes nothing.
      // (INFERRED from the brushes on this machine, and it agrees with the
      // way the column is described by MoArt's own notes.)
      rotation: value("BrushRotation", 0),
      rotationFollow: rotation.followsDirection,
      rotationJitter: rotation.jitter,
      rotationEffector: rotation.raw,

      // Anti-alias 0 is the hard edge Clip Studio Paint calls "no
      // anti-aliasing"; every other value keeps the soft edge of the tip.
      binarize: value("AntiAlias") === 0,

      // The picture of the tip. Null is a round brush.
      texture: texture
        ? {
            data: texture.toString("base64"),
            width: texture.readUInt32BE(16),
            height: texture.readUInt32BE(20),
          }
        : null,

      // The grain of the paper, when the brush has one.
      grain,

      // The curves that follow the hand, and the settings they drive.
      dyn: dynamics,

      // What the brush has that this program does not paint with. It is shown
      // to the user so the loss is visible, and it is kept in the file when
      // the brush is written out again.
      keeps: keepsOf(variant),

      // The bytes of the file, so that the brush can be written out whole.
      source: Buffer.from(bytes).toString("base64"),
    };
  } finally {
    await db.close();
  }
}

/**
 * The parts of a brush this program keeps but does not paint with.
 *
 * A brush of Clip Studio Paint can mix its colours with the paper, spray its
 * paint, run a second brush inside the first, and wet the edge of its stroke.
 * None of that is painted here; the file keeps it, and the panel says so
 * rather than pretending the brush is complete.
 */
function keepsOf(variant) {
  if (!variant) return [];
  const keeps = [];
  const on = (key) => variant[key] === 1;
  if (on("UseDualBrush")) keeps.push("dualBrush");
  if (on("BrushUseWaterColor")) keeps.push("colourMixing");
  if (on("BrushUseSpray")) keeps.push("spray");
  if (on("BrushRibbon")) keeps.push("ribbon");
  if (on("BrushUseWaterEdge")) keeps.push("waterEdge");
  if (on("BrushUseRevision")) keeps.push("stabilizer");
  if (on("BrushUseIn") || on("BrushUseOut")) keeps.push("taper");
  return keeps;
}

/**
 * What the tip of a brush turns with.
 *
 * `BrushRotationEffector` says where the angle of the tip comes from, and
 * `BrushRotationRandomScale` says how far a random turn reaches, in percent of
 * a half turn: 100 is a full half turn each way. The bit field was read from
 * the brushes on this machine and agrees with the description another reader
 * of these files (MoArt) gives of the same column:
 *
 *   3, 0        a fixed angle
 *   0x43, 0xC3  the direction of the line (0xC3 shakes it at random as well)
 *   0x80        a random shake of a fixed angle
 *   0x20        the turn of the pen barrel, which this program has no axis for
 *   0x10        the direction of the pen, which a mouse does not have either
 *
 * Any other value that carries the two low bits of the line is read as the
 * line, because those bits are the part that was seen to mean it.
 */
function rotationOf(effector, randomScale) {
  const raw = Number(effector);
  const scale = Number(randomScale);
  const known = Number.isFinite(raw) && raw !== 0 ? raw : 0;

  let followsDirection = false;
  if (known === 0x43 || known === 0xc3) {
    followsDirection = true;
  } else if (known !== 0 && known !== 3 && !(known & 0x80) && !(known & 0x20) && !(known & 0x10)) {
    followsDirection = (known & 0x03) === 3;
  }

  const jitter =
    known & 0x80 && Number.isFinite(scale) && scale > 0
      ? Math.max(0, Math.min(100, scale)) * 1.8
      : 0;

  return {
    followsDirection,
    jitter,
    raw: Number.isFinite(raw) ? raw : null,
  };
}

/** Read one `Brush*Effector` column, whatever kind of value it holds. */function readEffector(variant, key) {
  const data = variant[key];
  if (data === null || data === undefined) return null;
  if (typeof data === "number") return null;
  return parseEffector(data);
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
  const shapes = materials.filter((material) => materialIs(material, "BrushPattern"));
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

/**
 * The grain of the paper of a brush.
 *
 * A brush that is drawn on paper keeps a second material that says
 * `PaperTexture`; its thumbnail is the pattern, in the alpha channel. The
 * picture is kept small and the alpha is kept in a few steps, because it is
 * saved with every stroke that is drawn on it.
 */
function grainFromMaterials(materials, variant) {
  const paper = materials.find((material) => materialIs(material, "PaperTexture"));
  if (!paper) return null;

  let picture = null;
  let ink = -1;
  for (const file of tarEntries(paper)) {
    if (!file.name.includes("thumbnail")) continue;
    const png = brushPngFromBytes(file.data);
    if (!png) continue;
    const amount = inkInPicture(png);
    if (amount > ink) {
      picture = png;
      ink = amount;
    }
  }
  if (!picture) return null;

  let small = picture;
  try {
    const image = decodePng(picture);
    const longest = Math.max(image.width, image.height);
    if (longest > GRAIN_SIZE) {
      const scale = GRAIN_SIZE / longest;
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const scaled = new Uint8Array(width * height * 4);
      // The alpha is the pattern; the colour is not used, so the picture is
      // kept as black with the alpha of the grain.
      for (let at = 0; at < width * height; at += 1) scaled[at * 4 + 3] = 255;
      const source = scaleRgba(image.data, image.width, image.height, width, height);
      for (let at = 0; at < width * height; at += 1) {
        const alpha = source[at * 4 + 3];
        const step = Math.round((alpha / 255) * (GRAIN_LEVELS - 1));
        scaled[at * 4 + 3] = Math.round((step / (GRAIN_LEVELS - 1)) * 255);
      }
      small = encodeRgbaPng(width, height, scaled);
    }
  } catch {
    // A grain that cannot be decoded is not used; the brush still draws.
    return null;
  }

  const value = (key, fallback) => variant?.[key] ?? fallback;
  return {
    data: Buffer.from(small).toString("base64"),
    width: small.readUInt32BE(16),
    height: small.readUInt32BE(20),
    density: value("TextureDensity", 50),
    scale: value("TextureScale2", 100),
    rotate: value("TextureRotate", 0),
    reverse: value("TextureReverseDensity") === 1,
  };
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
 * Whether a material says it is a kind of material.
 *
 * The material says what it is in a small XML file: a brush shape is marked
 * with `BrushPattern`, a grain of paper with `PaperTexture`. The word is
 * searched for in the raw text, because the way the XML is written changes
 * from one material to the next and the name of the file is not a sign of
 * anything.
 */
function materialIs(material, word) {
  for (const file of tarEntries(material)) {
    if (!file.name.endsWith(".xml")) continue;
    if (file.data.toString("utf8").includes(word)) return true;
  }
  return false;
}
