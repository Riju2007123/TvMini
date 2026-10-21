import { Buffer } from "./bytes.js";
import { createDatabase } from "./sqlite.js";
import { writeTar } from "./tar.js";

/**
 * Writing a Clip Studio Paint brush.
 *
 * A `.sut` file is a SQLite database with three tables:
 *
 *   `Manager`  what the file is and which version it was written by;
 *   `Node`     the brush itself: its name and the settings that belong to it;
 *   `Variant`  the settings of the brush, one row for the brush as it is
 *               now and one row for the settings it starts with.
 *
 * The picture of the tip of the brush is not in those tables. It sits in a
 * `MaterialFile` table, and that file is a TAR archive holding a few
 * pictures and a small XML file that says what the material is.
 *
 * The tables and the settings below are the shape of the file, worked out
 * from brushes that Clip Studio Paint wrote. Only the settings that the
 * brush of this program cares about are changed; the rest are the values a
 * new brush starts with.
 */

/** The tables of a brush file. */
const SCHEMA = `
CREATE TABLE Manager(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, ToolType INTEGER DEFAULT NULL, Version INTEGER DEFAULT NULL, RootUuid BLOB DEFAULT NULL, CurrentNodeUuid BLOB DEFAULT NULL, MaxVariantID INTEGER DEFAULT NULL, CommonVariantID INTEGER DEFAULT NULL, ObjectNodeUuid BLOB DEFAULT NULL, PressureGraph NULL DEFAULT NULL, SavedCount INTEGER DEFAULT NULL, PressureGraphInitialized INTEGER DEFAULT NULL, UsePressureFile INTEGER DEFAULT NULL);

CREATE TABLE Node(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, NodeUuid BLOB DEFAULT NULL, NodeName TEXT DEFAULT NULL, NodeShortCutKey INTEGER DEFAULT NULL, NodeLock INTEGER DEFAULT NULL, NodeInputOp INTEGER DEFAULT NULL, NodeOutputOp INTEGER DEFAULT NULL, NodeRangeOp INTEGER DEFAULT NULL, NodeIcon INTEGER DEFAULT NULL, NodeIconColor INTEGER DEFAULT NULL, NodeHidden INTEGER DEFAULT NULL, NodeInstalledState INTEGER DEFAULT NULL, NodeInstalledVersion INTEGER DEFAULT NULL, NodeHideByGrade INTEGER DEFAULT NULL, NodeDefaultIdentifier INTEGER DEFAULT NULL, NodeMaterialIDExists INTEGER DEFAULT NULL, NodeMaterialContentID INTEGER DEFAULT NULL, NodeMaterialUuid TEXT DEFAULT NULL, NodeNextUuid BLOB DEFAULT NULL, NodeFirstChildUuid BLOB DEFAULT NULL, NodeSelectedUuid BLOB DEFAULT NULL, NodeVariantID INTEGER DEFAULT NULL, NodeInitVariantID INTEGER DEFAULT NULL, NodeCustomIcon NULL DEFAULT NULL);

CREATE TABLE Variant(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, VariantID INTEGER DEFAULT NULL, VariantShowSeparator INTEGER DEFAULT NULL, VariantShowParam BLOB DEFAULT NULL, Opacity INTEGER DEFAULT NULL, AntiAlias INTEGER DEFAULT NULL, CompositeMode INTEGER DEFAULT NULL, FlickerReduction INTEGER DEFAULT NULL, FlickerReductionBySpeed INTEGER DEFAULT NULL, FlickerReductionBySpeedType INTEGER DEFAULT NULL, Stickness INTEGER DEFAULT NULL, TextureImage NULL DEFAULT NULL, TextureCompositeMode INTEGER DEFAULT NULL, TextureReverseDensity INTEGER DEFAULT NULL, TextureStressDensity INTEGER DEFAULT NULL, TextureScale2 REAL DEFAULT NULL, TextureRotate REAL DEFAULT NULL, TextureBrightness INTEGER DEFAULT NULL, TextureContrast INTEGER DEFAULT NULL, BrushSize REAL DEFAULT NULL, BrushSizeUnit INTEGER DEFAULT NULL, BrushSizeEffector BLOB DEFAULT NULL, BrushSizeSyncViewScale INTEGER DEFAULT NULL, BrushAtLeast1Pixel INTEGER DEFAULT NULL, BrushOpacityEffector BLOB DEFAULT NULL, BrushFlow INTEGER DEFAULT NULL, BrushFlowEffector BLOB DEFAULT NULL, BrushAdjustFlowByInterval INTEGER DEFAULT NULL, BrushHardness INTEGER DEFAULT NULL, BrushInterval REAL DEFAULT NULL, BrushIntervalEffector BLOB DEFAULT NULL, BrushAutoIntervalType INTEGER DEFAULT NULL, BrushContinuousPlot INTEGER DEFAULT NULL, BrushThickness INTEGER DEFAULT NULL, BrushThicknessEffector BLOB DEFAULT NULL, BrushVerticalThicknes INTEGER DEFAULT NULL, BrushRotation REAL DEFAULT NULL, BrushRotationEffector INTEGER DEFAULT NULL, BrushRotationRandomScale INTEGER DEFAULT NULL, BrushRotationInSpray REAL DEFAULT NULL, BrushRotationEffectorInSpray INTEGER DEFAULT NULL, BrushRotationRandomInSpray REAL DEFAULT NULL, BrushUsePatternImage INTEGER DEFAULT NULL, BrushPatternImageArray NULL DEFAULT NULL, BrushPatternOrderType INTEGER DEFAULT NULL, BrushPatternOrderType2 INTEGER DEFAULT NULL, BrushPatternReverseHorizontal INTEGER DEFAULT NULL, BrushPatternReverseVertical INTEGER DEFAULT NULL, BrushPatternNameVersion INTEGER DEFAULT NULL, TextureForPlot INTEGER DEFAULT NULL, TextureDensity INTEGER DEFAULT NULL, TextureDensityEffector BLOB DEFAULT NULL, BrushUseWaterColor INTEGER DEFAULT NULL, BrushUseWaterColor2 INTEGER DEFAULT NULL, BrushWaterColor INTEGER DEFAULT NULL, BrushMixColor INTEGER DEFAULT NULL, BrushMixColorEffector BLOB DEFAULT NULL, BrushColorMixingMode INTEGER DEFAULT NULL, BrushLMSLinearity INTEGER DEFAULT NULL, BrushMixAlpha INTEGER DEFAULT NULL, BrushMixAlphaEffector BLOB DEFAULT NULL, BrushMixColorExtension INTEGER DEFAULT NULL, BrushBlurLinkSize INTEGER DEFAULT NULL, BrushBlur REAL DEFAULT NULL, BrushBlurUnit INTEGER DEFAULT NULL, BrushBlurEffector BLOB DEFAULT NULL, BrushChangePatternColor INTEGER DEFAULT NULL, BrushHueChange INTEGER DEFAULT NULL, BrushHueChangeEffector BLOB DEFAULT NULL, BrushSaturationChange INTEGER DEFAULT NULL, BrushSaturationChangeEffector BLOB DEFAULT NULL, BrushValueChange INTEGER DEFAULT NULL, BrushValueChangeEffector BLOB DEFAULT NULL, BrushSubColor INTEGER DEFAULT NULL, BrushSubColorEffector BLOB DEFAULT NULL, BrushChangeStrokeColor INTEGER DEFAULT NULL, BrushStrokeHueChange INTEGER DEFAULT NULL, BrushStrokeSaturationChange INTEGER DEFAULT NULL, BrushStrokeValueChange INTEGER DEFAULT NULL, BrushStrokeSubColor INTEGER DEFAULT NULL, BrushChangeColorTarget INTEGER DEFAULT NULL, BrushRibbon INTEGER DEFAULT NULL, BrushBlendPatternByDarken INTEGER DEFAULT NULL, BrushUseSpray INTEGER DEFAULT NULL, BrushSpraySize REAL DEFAULT NULL, BrushSpraySizeUnit INTEGER DEFAULT NULL, BrushSpraySizeEffector BLOB DEFAULT NULL, BrushSpraySizeSyncBrushSize INTEGER DEFAULT NULL, BrushSprayDensity INTEGER DEFAULT NULL, BrushSprayDensityEffector BLOB DEFAULT NULL, BrushSprayBias INTEGER DEFAULT NULL, BrushSprayUseFixedPoint INTEGER DEFAULT NULL, BrushSprayFixedPointArray NULL DEFAULT NULL, BrushUseRevision INTEGER DEFAULT NULL, BrushRevision INTEGER DEFAULT NULL, BrushRevisionBySpeed INTEGER DEFAULT NULL, BrushRevisionByViewScale INTEGER DEFAULT NULL, BrushRevisionBezier INTEGER DEFAULT NULL, BrushInOutTarget BLOB DEFAULT NULL, BrushInOutType INTEGER DEFAULT NULL, BrushInOutBySpeed INTEGER DEFAULT NULL, BrushUseIn INTEGER DEFAULT NULL, BrushInLength REAL DEFAULT NULL, BrushInLengthUnit INTEGER DEFAULT NULL, BrushInRatio REAL DEFAULT NULL, BrushUseOut INTEGER DEFAULT NULL, BrushOutLength REAL DEFAULT NULL, BrushOutLengthUnit INTEGER DEFAULT NULL, BrushOutRatio REAL DEFAULT NULL, BrushSharpenCorner INTEGER DEFAULT NULL, BrushUseWaterEdge INTEGER DEFAULT NULL, BrushWaterEdgeRadius INTEGER DEFAULT NULL, BrushWaterEdgeRadiusUnit INTEGER DEFAULT NULL, BrushWaterEdgeAlphaPower INTEGER DEFAULT NULL, BrushWaterEdgeValuePower INTEGER DEFAULT NULL, BrushWaterEdgeAfterDrag INTEGER DEFAULT NULL, BrushWaterEdgeBlur INTEGER DEFAULT NULL, BrushWaterEdgeBlurUnit INTEGER DEFAULT NULL, BrushUseVectorEraser INTEGER DEFAULT NULL, BrushVectorEraserType INTEGER DEFAULT NULL, BrushVectorEraserReferAllLayer INTEGER DEFAULT NULL, BrushEraseAllLayer INTEGER DEFAULT NULL, BrushEnableSnap INTEGER DEFAULT NULL, BrushUseVectorMagnet INTEGER DEFAULT NULL, BrushVectorMagnetPower INTEGER DEFAULT NULL, BrushUseReferLayer INTEGER DEFAULT NULL, BrushAdjustVelocity INTEGER DEFAULT NULL, UseDualBrush INTEGER DEFAULT NULL, DualBrushCompositeMode INTEGER DEFAULT NULL, ChangeRGBByDual INTEGER DEFAULT NULL, SyncDualBrushSize INTEGER DEFAULT NULL, DualAntiAlias INTEGER DEFAULT NULL, DualSize REAL DEFAULT NULL, DualSizeUnit INTEGER DEFAULT NULL, DualSizeEffector BLOB DEFAULT NULL, DualFlow INTEGER DEFAULT NULL, DualFlowEffector BLOB DEFAULT NULL, DualAdjustFlowByInterval INTEGER DEFAULT NULL, DualHardness INTEGER DEFAULT NULL, DualInterval REAL DEFAULT NULL, DualIntervalEffector BLOB DEFAULT NULL, DualAutoIntervalType INTEGER DEFAULT NULL, DualContinuousPlot INTEGER DEFAULT NULL, DualThickness INTEGER DEFAULT NULL, DualThicknessEffector BLOB DEFAULT NULL, DualVerticalThicknes INTEGER DEFAULT NULL, DualRotation REAL DEFAULT NULL, DualRotationEffector INTEGER DEFAULT NULL, DualRotationRandomScale INTEGER DEFAULT NULL, DualRotationInSpray REAL DEFAULT NULL, DualRotationEffectorInSpray INTEGER DEFAULT NULL, DualRotationRandomInSpray REAL DEFAULT NULL, DualUsePatternImage INTEGER DEFAULT NULL, DualPatternImageArray NULL DEFAULT NULL, DualPatternOrderType INTEGER DEFAULT NULL, DualPatternReverseHorizontal INTEGER DEFAULT NULL, DualPatternReverseVertical INTEGER DEFAULT NULL, DualTextureImage NULL DEFAULT NULL, DualTextureCompositeMode INTEGER DEFAULT NULL, DualTextureReverseDensity INTEGER DEFAULT NULL, DualTextureStressDensity INTEGER DEFAULT NULL, DualTextureScale REAL DEFAULT NULL, DualTextureRotate REAL DEFAULT NULL, DualTextureBrightness INTEGER DEFAULT NULL, DualTextureContrast INTEGER DEFAULT NULL, DualTextureForPlot INTEGER DEFAULT NULL, DualTextureDensity INTEGER DEFAULT NULL, DualTextureDensityEffector BLOB DEFAULT NULL, DualRibbon INTEGER DEFAULT NULL, DualBlendPatternByDarken INTEGER DEFAULT NULL, DualBlendPatternByDarken2 INTEGER DEFAULT NULL, DualUseSpray INTEGER DEFAULT NULL, DualSpraySize REAL DEFAULT NULL, DualSpraySizeUnit INTEGER DEFAULT NULL, DualSpraySizeEffector BLOB DEFAULT NULL, DualSpraySizeSyncBrushSize INTEGER DEFAULT NULL, DualSprayDensity INTEGER DEFAULT NULL, DualSprayDensityEffector BLOB DEFAULT NULL, DualSprayBias INTEGER DEFAULT NULL, DualSprayUseFixedPoint INTEGER DEFAULT NULL, DualSprayFixedPointArray NULL DEFAULT NULL, FillReferVectorCenter INTEGER DEFAULT NULL, FillUseExpand INTEGER DEFAULT NULL, FillExpandLength REAL DEFAULT NULL, FillExpandLengthUnit INTEGER DEFAULT NULL, FillExpandType INTEGER DEFAULT NULL, FillColorMargin REAL DEFAULT NULL);

CREATE TABLE MaterialFile(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, InstallFolder INTEGER DEFAULT NULL, OriginalPath TEXT DEFAULT NULL, OldMaterial INTEGER DEFAULT NULL, FileData BLOB DEFAULT NULL, CatalogPath TEXT DEFAULT NULL, MaterialUuid TEXT DEFAULT NULL);
`;

/**
 * The settings a brush starts with.
 *
 * These are the values Clip Studio Paint gives a brush that has never been
 * changed, so a brush written by this program looks the way a new brush in
 * Clip Studio Paint does.
 */
const DEFAULT_SETTINGS = {
  VariantShowSeparator: 0,
  Opacity: 100,
  AntiAlias: 3,
  CompositeMode: 0,
  FlickerReduction: 6,
  FlickerReductionBySpeed: 1,
  FlickerReductionBySpeedType: 1,
  Stickness: 4,
  TextureCompositeMode: 0,
  TextureReverseDensity: 0,
  TextureStressDensity: 0,
  TextureScale2: 100,
  TextureRotate: 0,
  TextureBrightness: 0,
  TextureContrast: 0,
  BrushSize: 100,
  BrushSizeUnit: 0,
  BrushSizeSyncViewScale: 0,
  BrushAtLeast1Pixel: 0,
  BrushFlow: 100,
  BrushAdjustFlowByInterval: 0,
  BrushHardness: 100,
  BrushInterval: 10,
  BrushAutoIntervalType: 2,
  BrushContinuousPlot: 0,
  BrushThickness: 100,
  BrushVerticalThicknes: 1,
  BrushRotation: 0,
  BrushRotationEffector: 3,
  BrushRotationRandomScale: 100,
  BrushRotationInSpray: 0,
  BrushRotationEffectorInSpray: 3,
  BrushRotationRandomInSpray: 100,
  BrushUsePatternImage: 0,
  BrushPatternOrderType: 0,
  BrushPatternOrderType2: 0,
  BrushPatternReverseHorizontal: 0,
  BrushPatternReverseVertical: 0,
  BrushPatternNameVersion: 1,
  TextureForPlot: 0,
  TextureDensity: 50,
  BrushUseWaterColor: 0,
  BrushUseWaterColor2: 0,
  BrushWaterColor: 0,
  BrushMixColor: 50,
  BrushColorMixingMode: 0,
  BrushLMSLinearity: 0,
  BrushMixAlpha: 50,
  BrushMixColorExtension: 10,
  BrushBlurLinkSize: 0,
  BrushBlur: 5,
  BrushBlurUnit: 0,
  BrushChangePatternColor: 0,
  BrushHueChange: 0,
  BrushSaturationChange: 0,
  BrushValueChange: 0,
  BrushSubColor: 0,
  BrushChangeStrokeColor: 0,
  BrushStrokeHueChange: 0,
  BrushStrokeValueChange: 0,
  BrushStrokeSubColor: 0,
  BrushChangeColorTarget: 1,
  BrushRibbon: 0,
  BrushBlendPatternByDarken: 0,
  BrushUseSpray: 0,
  BrushSpraySize: 2,
  BrushSpraySizeUnit: 0,
  BrushSpraySizeSyncBrushSize: 0,
  BrushSprayDensity: 5,
  BrushSprayBias: 0,
  BrushSprayUseFixedPoint: 0,
  BrushUseRevision: 0,
  BrushRevision: 10,
  BrushRevisionBySpeed: 1,
  BrushRevisionByViewScale: 1,
  BrushRevisionBezier: 0,
  BrushInOutType: 0,
  BrushInOutBySpeed: 1,
  BrushUseIn: 1,
  BrushInLength: 20,
  BrushInLengthUnit: 0,
  BrushInRatio: 30,
  BrushUseOut: 1,
  BrushOutLength: 20,
  BrushOutLengthUnit: 0,
  BrushOutRatio: 30,
  BrushSharpenCorner: 0,
  BrushUseWaterEdge: 0,
  BrushWaterEdgeRadius: 3,
  BrushWaterEdgeRadiusUnit: 0,
  BrushWaterEdgeAlphaPower: 20,
  BrushWaterEdgeValuePower: 0,
  BrushWaterEdgeAfterDrag: 0,
  BrushWaterEdgeBlur: 0,
  BrushWaterEdgeBlurUnit: 0,
  BrushUseVectorEraser: 0,
  BrushVectorEraserType: 0,
  BrushVectorEraserReferAllLayer: 1,
  BrushEraseAllLayer: 0,
  BrushEnableSnap: 1,
  BrushUseVectorMagnet: 0,
  BrushVectorMagnetPower: 30,
  BrushUseReferLayer: 0,
  BrushAdjustVelocity: 1,
  UseDualBrush: 0,
  DualBrushCompositeMode: 1,
  ChangeRGBByDual: 0,
  SyncDualBrushSize: 0,
  DualAntiAlias: 2,
  DualSize: 30,
  DualSizeUnit: 0,
  DualFlow: 100,
  DualAdjustFlowByInterval: 1,
  DualHardness: 100,
  DualInterval: 10,
  DualAutoIntervalType: 2,
  DualContinuousPlot: 0,
  DualThickness: 100,
  DualVerticalThicknes: 0,
  DualRotation: 0,
  DualRotationEffector: 3,
  DualRotationRandomScale: 100,
  DualRotationInSpray: 0,
  DualRotationEffectorInSpray: 1,
  DualRotationRandomInSpray: 100,
  DualUsePatternImage: 0,
  DualPatternOrderType: 0,
  DualPatternReverseHorizontal: 0,
  DualPatternReverseVertical: 0,
  DualTextureCompositeMode: 0,
  DualTextureReverseDensity: 0,
  DualTextureStressDensity: 0,
  DualTextureScale: 100,
  DualTextureRotate: 0,
  DualTextureBrightness: 0,
  DualTextureContrast: 0,
  DualTextureForPlot: 0,
  DualTextureDensity: 50,
  DualRibbon: 0,
  DualBlendPatternByDarken: 0,
  DualBlendPatternByDarken2: 0,
  DualUseSpray: 0,
  DualSpraySize: 2,
  DualSpraySizeUnit: 0,
  DualSpraySizeSyncBrushSize: 0,
  DualSprayDensity: 1,
  DualSprayBias: 0,
  DualSprayUseFixedPoint: 0,
  FillReferVectorCenter: 0,
  FillUseExpand: 0,
  FillExpandLength: 10,
  FillExpandLengthUnit: 0,
  FillExpandType: 2,
  FillColorMargin: 10,
};

/** The version of the file that is written. */
const FILE_VERSION = 142;

/** The settings that are the same in every brush of this kind. */
const NODE_SETTINGS = {
  NodeShortCutKey: 0,
  NodeLock: 0,
  NodeInputOp: 11,
  NodeOutputOp: 11,
  NodeRangeOp: 0,
  NodeIcon: 101,
  NodeIconColor: 0,
  NodeHidden: 0,
  NodeInstalledState: 0,
  NodeInstalledVersion: 134,
  NodeHideByGrade: 0,
  NodeDefaultIdentifier: 0,
  NodeMaterialIDExists: 0,
  NodeMaterialContentID: 0,
  NodeMaterialUuid: "",
};

/** A number for the name of a material. */
function randomId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/** The same number, written the way Clip Studio Paint writes it. */
function idText(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/**
 * The picture of the tip, as the material file of a brush.
 *
 * The material is a TAR archive with the picture of the tip, a small picture
 * for the list, and a file that says what the material is.
 */
function materialFile(png) {
  const uuid = idText(randomId());
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<infolist>

  <version>2.0.0</version>

  <info uuid="${uuid}">
    <datalist key="systemtag">
      <data>Resizable</data>
      <data>BrushPattern</data>
    </datalist>
    <datalist key="foldertag">
      <data>画像素材:ブラシ</data>
    </datalist>
    <datalist key="scaling">
      <data>4</data>
    </datalist>
    <datalist key="isTiling">
      <data>0</data>
    </datalist>
    <datalist key="howTiling">
      <data>0</data>
    </datalist>
    <datalist key="directionTiling">
      <data>0</data>
    </datalist>
    <datalist key="superPosition">
      <data>-1</data>
    </datalist>
    <datalist key="tone">
      <data>0</data>
    </datalist>
    <datalist key="toneLines">
      <data>60.000000</data>
    </datalist>
    <datalist key="concentrationType">
      <data>0</data>
    </datalist>
    <datalist key="concentration">
      <data>20.000000</data>
    </datalist>
    <datalist key="toneKind">
      <data>1</data>
    </datalist>
    <datalist key="toneAngle">
      <data>45.000000</data>
    </datalist>
    <datalist key="noizeSize">
      <data>10.000000</data>
    </datalist>
    <datalist key="noizeCoefficient">
      <data>0.000000</data>
    </datalist>
    <datalist key="useLayerColor">
      <data>0</data>
    </datalist>
    <datalist key="mainColorRed">
      <data>0</data>
    </datalist>
    <datalist key="mainColorGreen">
      <data>0</data>
    </datalist>
    <datalist key="mainColorBlue">
      <data>0</data>
    </datalist>
    <datalist key="subColorRed">
      <data>4294967295</data>
    </datalist>
    <datalist key="subColorGreen">
      <data>4294967295</data>
    </datalist>
    <datalist key="subColorBlue">
      <data>4294967295</data>
    </datalist>
    <datalist key="isChangeThumbnail">
      <data>0</data>
    </datalist>
    <datalist key="isChangeTitle">
      <data>0</data>
    </datalist>
    <datalist key="csauuid">
      <data></data>
    </datalist>
  </info>

</infolist>
`;

  return {
    uuid,
    path: `.:44:36:${uuid}:data:material_0.layer`,
    bytes: writeTar([
      { name: "catalog.zip", data: png },
      { name: "info.zip", data: png },
      { name: "data/material_0.layer", data: png },
      { name: "thumbnail/thumbnail.png", data: png },
      { name: "icedata/layerData.xml", data: Buffer.from(xml, "utf8") },
    ]),
  };
}

/**
 * Write a Clip Studio Paint brush.
 *
 * The brush is described by:
 *
 *   `name`      the name of the brush;
 *   `size`      the width of the brush in pixels;
 *   `opacity`   how strong the brush paints, from 0 to 100;
 *   `flow`      how much paint a single dab leaves;
 *   `hardness`  how hard the edge of the tip is;
 *   `thickness` how much of the tip the stroke uses;
 *   `texture`   the picture of the tip, as the base64 of a PNG.
 *
 * The result is the bytes of the file, ready to be written to disk.
 */
export async function writeSutBrush(brush = {}) {
  const name = String(brush.name ?? "brush").trim() || "brush";
  const size = Number.isFinite(Number(brush.size)) ? Number(brush.size) : 100;
  const opacity = clamp(Number(brush.opacity ?? 100), 0, 100);
  const flow = clamp(Number(brush.flow ?? 100), 0, 100);
  const hardness = clamp(Number(brush.hardness ?? 100), 0, 100);
  const thickness = clamp(Number(brush.thickness ?? 100), 0, 100);

  const database = await createDatabase();
  try {
    database.exec(SCHEMA);

    const root = randomId();
    const object = randomId();
    database
      .prepare(
        "INSERT INTO Manager (_PW_ID, ToolType, Version, RootUuid, CurrentNodeUuid," +
          " MaxVariantID, CommonVariantID, ObjectNodeUuid, PressureGraph, SavedCount," +
          " PressureGraphInitialized, UsePressureFile) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        1,
        0,
        FILE_VERSION,
        root,
        Buffer.from([0]),
        2,
        // The settings every brush of Clip Studio Paint starts from are
        // kept by Clip Studio Paint itself, so this points at those.
        44,
        object,
        null,
        1,
        2,
        1,
      );

    const node = { _PW_ID: 1, NodeUuid: randomId(), NodeName: name, ...NODE_SETTINGS };
    node.NodeNextUuid = Buffer.from([0]);
    node.NodeFirstChildUuid = Buffer.from([0]);
    node.NodeSelectedUuid = Buffer.from([0]);
    node.NodeVariantID = 1;
    node.NodeInitVariantID = 2;
    const nodeColumns = Object.keys(node);
    database
      .prepare(
        `INSERT INTO Node (${nodeColumns.join(", ")}) VALUES (${nodeColumns.map(() => "?").join(", ")})`,
      )
      .run(...nodeColumns.map((column) => node[column]));

    // The brush as it is now.
    const settings = {
      ...DEFAULT_SETTINGS,
      Opacity: opacity,
      BrushSize: size,
      BrushSizeUnit: 0,
      BrushFlow: flow,
      BrushHardness: hardness,
      BrushThickness: thickness,
    };
    writeVariant(database, 1, settings);

    // The settings the brush starts with when it is put back the way it was.
    const start = { ...DEFAULT_SETTINGS };
    for (const column of Object.keys(start)) {
      if (column === "BrushPatternNameVersion") continue;
      start[column] = null;
    }
    writeVariant(database, 2, start);

    // The picture of the tip, when the brush has one.
    if (brush.texture?.data) {
      const png = Buffer.from(String(brush.texture.data), "base64");
      const material = materialFile(png);
      database
        .prepare(
          "INSERT INTO MaterialFile (_PW_ID, InstallFolder, OriginalPath, OldMaterial," +
            " FileData, CatalogPath, MaterialUuid) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          1,
          0,
          material.path,
          0,
          material.bytes,
          `.:44:36:${material.uuid}`,
          "",
        );
    }

    const image = await database.export();
    return new Uint8Array(image);
  } finally {
    await database.close();
  }
}

/** Put one row of settings into the table. */
function writeVariant(database, id, settings) {
  const columns = ["_PW_ID", "VariantID", ...Object.keys(settings)];
  const values = [id, id, ...Object.values(settings)];
  database
    .prepare(
      `INSERT INTO Variant (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...values);
}

/** Keep a number between two ends. */
function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}
