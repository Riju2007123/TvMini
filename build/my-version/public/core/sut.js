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
      "BrushInterval",
      "Opacity",
      "BrushFlow",
      "BrushHardness",
      "BrushThickness",
      "BrushVerticalThicknes",
      "BrushAutoIntervalType",
      "BrushUsePatternImage",
      "BrushPatternImageArray",
      "BrushPatternOrderType",
      "BrushPatternReverseVertical",
      "TextureScale2",
      "TextureRotate",
      "TextureDensity",
      "TextureCompositeMode",
      "TextureForPlot",
      "TextureReverseDensity",
      "BrushRibbon",
      "BrushRotation",
      "BrushRotationEffector",
      "BrushRotationRandomScale",
      "BrushRevision",
      "BrushUseRevision",
      "BrushInOutType",
      "BrushUseIn",
      "BrushInLength",
      "BrushInLengthUnit",
      "BrushInRatio",
      "BrushUseOut",
      "BrushOutLength",
      "BrushOutLengthUnit",
      "BrushOutRatio",
      "BrushInOutTarget",
      "AntiAlias",
      "CompositeMode",
      "BrushUseWaterColor",
      "BrushWaterColor",
      "BrushMixColor",
      "BrushMixAlpha",
      "BrushColorMixingMode",
      "BrushMixColorExtension",
      "BrushLMSLinearity",
      "BrushUseWaterEdge",
      "BrushWaterEdgeRadius",
      "BrushWaterEdgeRadiusUnit",
      "BrushWaterEdgeAlphaPower",
      "BrushWaterEdgeValuePower",
      "BrushWaterEdgeAfterDrag",
      "BrushWaterEdgeBlur",
      "BrushWaterEdgeBlurUnit",
      "BrushUseSpray",
      "BrushSpraySize",
      "BrushSprayDensity",
      "UseDualBrush",
      "DualBrushCompositeMode",
      "ChangeRGBByDual",
      "DualSize",
      "DualSizeUnit",
      "DualFlow",
      "DualAdjustFlowByInterval",
      "DualHardness",
      "DualInterval",
      "DualAutoIntervalType",
      "DualThickness",
      "DualVerticalThicknes",
      "DualRotation",
      "DualRotationEffector",
      "DualRotationRandomScale",
      "DualUsePatternImage",
      "DualAntiAlias",
      "DualPatternOrderType",
      "DualPatternReverseHorizontal",
      "DualPatternReverseVertical",
      "BrushSizeEffector",
      "BrushOpacityEffector",
      "BrushFlowEffector",
      "BrushIntervalEffector",
      "BrushThicknessEffector",
      "BrushRotationEffector",
      "TextureDensityEffector",
      "BrushMixColorEffector",
      "BrushMixAlphaEffector",
      "DualSizeEffector",
      "DualFlowEffector",
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

    // Parse effectors
    const sizeEff = readEffector(variant, "BrushSizeEffector");
    const opacityEff = readEffector(variant, "BrushOpacityEffector");
    const flowEff = readEffector(variant, "BrushFlowEffector");
    const intervalEff = readEffector(variant, "BrushIntervalEffector");
    const thickEff = readEffector(variant, "BrushThicknessEffector");
    const rotationEff = readEffector(variant, "BrushRotationEffector");
    const texEff = readEffector(variant, "TextureDensityEffector");
    const mixColorEff = readEffector(variant, "BrushMixColorEffector");
    const mixAlphaEff = readEffector(variant, "BrushMixAlphaEffector");
    const dualSizeEff = readEffector(variant, "DualSizeEffector");
    const dualFlowEff = readEffector(variant, "DualFlowEffector");

    // Parse in/out targets
    let inOutTargets = null;
    if (variant?.BrushInOutTarget) {
      try {
        inOutTargets = JSON.parse(variant.BrushInOutTarget);
      } catch {
        inOutTargets = null;
      }
    }

    // Helper to get variant value
    const v = (key, fallback = null) => variant?.[key] ?? fallback;

    return {
      name: String(node?.NodeName ?? "").trim(),
      size: v("BrushSize"),
      sizeUnit: v("BrushSizeUnit"),
      opacity: v("Opacity"),
      flow: v("BrushFlow"),
      hardness: v("BrushHardness"),
      thickness: v("BrushThickness"),
      verticalThickness: v("BrushVerticalThicknes") === 1,
      spacing: v("BrushInterval"),
      autoInterval: v("BrushAutoIntervalType"),
      usePatternImage: v("BrushUsePatternImage") === 1,
      texture: {
        data: texture.toString("base64"),
        width: texture.readUInt32BE(16),
        height: texture.readUInt32BE(20),
      },
      // Flow effector
      flowCurvePts: flowEff?.usesPressure ? squeezeCurve(flowEff.curve, pressureFloor(flowEff)) : null,
      flowJitter: flowEff?.usesRandom ? Math.max(0, Math.min(100, 100 - flowEff.rmin)) : 0,
      // Hardness (mapped from BrushHardness 0-100 to antiAlias 0-3)
      hardness: v("BrushHardness"),
      // Thickness
      thicknessCurvePts: thickEff?.usesPressure ? squeezeCurve(thickEff.curve, pressureFloor(thickEff)) : null,
      thicknessJitter: thickEff?.usesRandom ? Math.max(0, Math.min(100, 100 - thickEff.rmin)) : 0,
      // Paper texture
      paperTexScale: v("TextureScale2"),
      paperTexRotate: v("TextureRotate"),
      paperTexDepth: v("TextureDensity"),
      paperTexMode: v("TextureCompositeMode"),
      paperTexPerDab: v("TextureForPlot") === 1,
      paperTexDepthCurvePts: texEff?.usesPressure ? squeezeCurve(texEff.curve, pressureFloor(texEff)) : null,
      // Dual brush
      dualMask: v("DualBrushCompositeMode") != null ? SUT_DUAL_MODES[v("DualBrushCompositeMode")] || "normal" : null,
      dualSize: v("DualSize"),
      dualFlow: v("DualFlow"),
      dualSpacing: v("DualInterval") ? v("DualInterval") / 100 : null,
      dualAa: v("DualAntiAlias"),
      // Rotation
      tipAngle: v("BrushRotation"),
      tipRotate: rotationEff?.usesPressure || rotationEff?.usesTilt ? "dir" : null,
      tipDirCsp: true,
      tipJitAngle: rotationEff?.usesRandom ? Math.round((v("BrushRotationRandomScale") || 100) * 1.8) : 0,
      // Stabilizer
      stabilizer: v("BrushUseRevision") === 1 && v("BrushRevision") ? Math.max(0, Math.min(10, Math.round(v("BrushRevision") / 10))) : 0,
      // Taper
      taperIn: v("BrushUseIn") === 1 && v("BrushInLengthUnit") === 0 ? Math.round(v("BrushInLength") || 0) : 0,
      taperOut: v("BrushUseOut") === 1 && v("BrushOutLengthUnit") === 0 ? Math.round(v("BrushOutLength") || 0) : 0,
      taperBySpeed: v("BrushInOutBySpeed") === 1,
      // Watercolor edge
      waterEdge: v("BrushUseWaterEdge") === 1 && v("BrushWaterEdgeRadiusUnit") === 0,
      waterEdgeRadius: v("BrushWaterEdgeRadius"),
      waterEdgePower: v("BrushWaterEdgeAlphaPower"),
      waterEdgeCsp: true,
      waterEdgeValue: v("BrushWaterEdgeValuePower"),
      waterEdgeBlur: v("BrushWaterEdgeAfterDrag") === 1 ? v("BrushWaterEdgeBlur") : 0,
      // Composite/blend
      blendMode: v("CompositeMode") != null ? SUT_BLEND_MODES[v("CompositeMode")] || "normal" : "normal",
      // Anti-alias
      antiAlias: v("AntiAlias") != null ? Math.max(0, Math.min(3, v("AntiAlias"))) : -1,
      // Mixing
      mixOn: v("BrushUseWaterColor") === 1,
      mixModel: v("BrushWaterColor") === 0 ? "csp" : null,
      mixAmount: v("BrushMixColor"),
      mixExtend: v("BrushMixColorExtension"),
      mixDensity: v("BrushMixAlpha"),
      mixAmtCurvePts: mixColorEff?.usesPressure ? squeezeCurve(mixColorEff.curve, pressureFloor(mixColorEff)) : null,
      mixDensCurvePts: mixAlphaEff?.usesPressure ? squeezeCurve(mixAlphaEff.curve, pressureFloor(mixAlphaEff)) : null,
      // Tip order
      tipRibbon: v("BrushRibbon") === 1,
      tipRibbonFlip: v("BrushPatternReverseVertical") === 3 ? "fold" : v("BrushPatternReverseVertical") === 2 ? "random" : null,
      tipDarken: v("BrushBlendPatternByDarken") === 1,
    };
  } finally {
    await db.close();
  }
}

// Dual brush composite mode mapping
const SUT_DUAL_MODES = {
  0: "normal", 1: "multiply", 2: "add", 3: "subtract", 4: "darken",
  5: "lighten", 6: "screen", 7: "overlay", 8: "dodge", 9: "burn",
  10: "linearburn", 11: "hardmix", 12: "height",
};

// Composite mode mapping
const SUT_BLEND_MODES = {
  1: "darken", 2: "multiply", 3: "color-burn", 7: "lighten", 8: "screen",
  9: "dodge", 14: "overlay", 15: "soft-light", 16: "hard-light",
  21: "difference", 22: "exclusion", 23: "hue", 24: "saturation",
  25: "colorize", 26: "luminosity", 29: "behind", 31: "replace-alpha",
};

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
  return materialSays(material, "BrushPattern");
}

/** Whether the XML of a material carries a word. */
function materialSays(material, word) {
  for (const file of tarEntries(material)) {
    if (!file.name.endsWith(".xml")) continue;
    if (file.data.toString("utf8").includes(word)) return true;
  }
  return false;
}

/**
 * Parse a .sut Effector BLOB.
 *
 * The effector carries pressure/tilt/velocity/random curves and ranges.
 * Returns null when the blob cannot be read.
 * Structure (big-endian):
 *   header: nHeader(40|44), ?, flag, pmin, tmin, vmax, rmin, ?, ?, ?, [tmax]
 *   section1: ?, nPoints, ?  followed by nPoints × (x,y) double pairs
 *   section2: same
 * flag bits: 0x10 pressure, 0x20 tilt, 0x40 velocity, 0x80 random
 */
function parseEffector(blob) {
  try {
    const u8 = blob instanceof Uint8Array ? blob : Buffer.from(blob);
    if (u8.length < 12) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 0;
    const u32 = () => { const v = dv.getUint32(p, false); p += 4; return v; };
    const i32 = () => { const v = dv.getInt32(p, false); p += 4; return v; };
    const f64 = () => { const v = dv.getFloat64(p, false); p += 8; return v; };

    const nHeader = u32();
    if (nHeader !== 40 && nHeader !== 44) return null;
    if (u8.length < nHeader) return null;

    u32(); // undetermined2
    const flag = u32();
    const pmin = i32();
    const tmin = i32();
    const vmax = i32();
    const rmin = i32();
    u32(); // undetermined
    const sec1 = u32();
    const sec2 = u32();
    const tmax = nHeader > 40 ? i32() : null;

    if (p !== nHeader || nHeader + sec1 + sec2 !== u8.length) return null;

    const readSection = (bytes) => {
      if (!bytes || bytes < 12) return null;
      const header = u32(), n = u32(), stride = u32();
      if (header !== 12 || stride !== 16 || n <= 0 || bytes !== 12 + n * 16) return null;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const x = f64(), y = f64();
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        pts.push({ x, y });
      }
      return pts;
    };

    const curve = readSection(sec1);
    const curve2 = readSection(sec2);

    return {
      usesPressure: (flag & 0x10) !== 0,
      usesTilt: (flag & 0x20) !== 0,
      usesVelocity: (flag & 0x40) !== 0,
      usesRandom: (flag & 0x80) !== 0,
      pmin,
      tmin,
      rmin,
      vmax,
      max: tmax,
      curve,
      curve2,
    };
  } catch {
    return null;
  }
}

/**
 * Convert pressure minimum (0..100%) to 0..1 floor.
 */
function pressureFloor(eff) {
  const m = Number(eff?.pmin);
  return (Number.isFinite(m) && m > 0) ? Math.min(1, m / 100) : 0;
}

/**
 * Squeeze a curve onto a floor: y' = floor + (1 - floor) * y.
 */
function squeezeCurve(pts, floor) {
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const f = Math.max(0, Math.min(1, Number(floor) || 0));
  return pts.map(pt => ({
    x: Math.max(0, Math.min(1, Number(pt.x))),
    y: f + (1 - f) * Math.max(0, Math.min(1, Number(pt.y))),
  }));
}

/**
 * Read an effector from the variant and return parsed object.
 */
function readEffector(variant, key) {
  const data = variant[key];
  if (data == null) return null;
  return parseEffector(data);
}
