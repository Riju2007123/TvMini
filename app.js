import { History } from "./history.js";
import { onionTargets } from "./onion.js";
import { detectBackend, bytesToBase64 } from "./core/platform.js";
import { planDrop } from "./core/drop-import.js";
import { normalizeProject } from "./core/model.js";
import { EXPORT_KINDS, cleanOptions as cleanExportOptions } from "./core/export-kinds.js";
import { buildTimeSheetLayout, todayStamp } from "./core/time-sheet-image.js";
import { renderTimeSheetPage, timeSheetPngBytes } from "./time-sheet-render.js";
import { decodeSound, soundPeaks } from "./audio.js";
import {
  clipMaskFromSpans,
  floodFillRgba,
  parseHexColor,
  sampleEllipse,
  smoothPoint,
  drawBrushTipShape,
  strokeOutline,
  strokePathGroups,
  strokeRadii as sharedStrokeRadii,
} from "./core/paint.js";
import { brushImageFromBytes } from "./core/brush.js";
import { brushSmoothPath, floodFillWithGaps } from "./core/flash8-drawing.js";
import {
  clipStroke,
  combineSelections,
  invertSelection,
  selectAll,
  selectionArea,
  selectionBounds,
  selectionContains,
  selectionFromEllipse,
  selectionFromPolygon,
  selectionFromRect,
  selectionIsEmpty,
  selectionOutline,
  selectionSpans,
  shiftSelection,
  translateStroke,
} from "./core/selection.js";
import * as shapeModel from "./core/shape-model.js";

import { catmullRomResample, dynamicsOf, strokeDabs } from "./core/brush-dynamics.js";
import { isPlain, pointToPicture, transformAt, transformMatrix, transformOf } from "./core/transform.js";
import { readSutBrush } from "./core/sut.js";
import {
  WHEEL_SIZE,
  hsvToRgb,
  huePoint,
  rgbToHsv,
  wheelLayout,
  wheelPick,
} from "./core/wheel.js";
import {
  ancestorsOf,
  cameraAt,
  cameraCorners,
  cameraKeyAt,
  cameraOfRatio,
  cameraView,
  cameraWindow,
  cellName,
  childrenOf,
  clipSourceOf,
  closeCellGaps,
  contentEnd,
  deleteCameraKey,
  deleteDrawing,
  drawingAt,
  duplicateDrawing,
  effectiveOpacity,
  exposureInfo,
  holdDrawing,
  insertDrawing,
  insertLayer,
  isAnimationFolder,
  isGroup,
  insideAnimationFolder,
  keyframes,
  layerBounds,
  layerDepth,
  layerIsVisible,
  layerTree,
  moveBlock,
  moveDrawing,
  nextKeyframe,
  packLayers,
  paperPixels,
  previousKeyframe,
  removeLayers,
  resolveDrawing,
  setCameraKey,
  setExposure,
  shiftStartFrame,
  showLayer,
  timelineColumns,
  trimToFrame,
  blockSize,
} from "./timeline.js";

const FORMAT = "tvmini";
const VERSION = 3;
const MAX_COLUMNS = 1000;
// Keep these in sync with src/model.js.
const MAX_LAYERS = 500;
const MAX_DRAWINGS_PER_LAYER = 2000;
const MAX_TOTAL_DRAWINGS = 20000;
const MAX_HOLD = 10000;
const MAX_START_FRAME = 100000;
const MAX_FRAME = 10_000_000;
/** Colour behind the camera window when the stage shows the camera view. */
const CAMERA_BACKDROP = "#12161c";
/** The pasteboard: the light grey Flash puts around the stage. */
const PASTEBOARD = "#c8c8c8";
/** The hairline that marks where the stage (the canvas) ends. */
const STAGE_EDGE = "#6f6f6f";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
// The sheet on top of the stage: the shape of the brush and the stroke that is
// being drawn. It is drawn again for every move of the pointer, so the
// document underneath is only drawn when the document itself changes.
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
// The box the stage is in. It scrolls when the document is larger than the
// pane, and the bars of it show where the document is.
const canvasScroll = document.querySelector(".canvas-scroll");
// The sheet of the document inside the box. The zoom may shift it, so the
// point under the pointer can be kept there.
const canvasStack = document.querySelector(".canvas-stack");
// The world the document sits in. It is bigger than the pane, so the bars
// of the pane have somewhere to go at any zoom.
const canvasWorld = document.querySelector(".canvas-world");
// The room around the document inside the world.
const WORLD_PAD = 120;
const statusEl = document.getElementById("status");
const statusBar = document.querySelector(".statusbar");
const pathLabel = document.getElementById("pathLabel");
const fileButton = document.getElementById("fileButton");
const fileMenu = document.getElementById("fileMenu");
const recentMenu = document.getElementById("recentMenu");
const colorInput = document.getElementById("color");
const widthInput = document.getElementById("width");
const widthValue = document.getElementById("widthValue");
const pressureInput = document.getElementById("pressure");
const pressureValue = document.getElementById("pressureValue");
const clearButton = document.getElementById("clearButton");
const undoButton = document.getElementById("undoButton");
const redoButton = document.getElementById("redoButton");
const brushButton = document.getElementById("brushButton");
const pencilButton = document.getElementById("pencilButton");
const eraserButton = document.getElementById("eraserButton");
const pickButton = document.getElementById("pickButton");
const lineToolButton = document.getElementById("lineTool");
const rectToolButton = document.getElementById("rectTool");
const ellipseToolButton = document.getElementById("ellipseTool");
const fillToolButton = document.getElementById("fillTool");
const cameraToolButton = document.getElementById("cameraTool");
const marqueeButton = document.getElementById("marqueeTool");
const lassoButton = document.getElementById("lassoTool");

const marqueeShapeSelect = document.getElementById("marqueeShape");
const stabilizerInput = document.getElementById("stabilizer");
const stabilizerValue = document.getElementById("stabilizerValue");
const strokeOpacityInput = document.getElementById("strokeOpacity");
const strokeOpacityValue = document.getElementById("strokeOpacityValue");
const strokeBlendSelect = document.getElementById("strokeBlend");
const binarizeInput = document.getElementById("binarize");
const flowInput = document.getElementById("flow");
const flowValue = document.getElementById("flowValue");
const hardnessInput = document.getElementById("hardness");
const hardnessValue = document.getElementById("hardnessValue");
const thicknessInput = document.getElementById("thickness");
const thicknessValue = document.getElementById("thicknessValue");
const spacingInput = document.getElementById("spacing");
const spacingValue = document.getElementById("spacingValue");
const paperInput = document.getElementById("paper");
const cameraAddButton = document.getElementById("cameraAdd");
const cameraRemoveButton = document.getElementById("cameraRemove");
const cameraFitButton = document.getElementById("cameraFit");
const cameraZoomButton = document.getElementById("cameraZoom");
const cameraZoomInButton = document.getElementById("cameraZoomIn");
const cameraZoomOutButton = document.getElementById("cameraZoomOut");
const zoomLabel = document.getElementById("zoomLabel");
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const zoomFitButton = document.getElementById("zoomFitButton");
const cameraXInput = document.getElementById("cameraX");
const cameraYInput = document.getElementById("cameraY");
const cameraWidthInput = document.getElementById("cameraWidth");
const cameraHeightInput = document.getElementById("cameraHeight");
const cameraRotationInput = document.getElementById("cameraRotation");
const cameraInterpSelect = document.getElementById("cameraInterp");
const cameraHint = document.getElementById("cameraHint");
const layerTreeEl = document.getElementById("layerTree");
const layerKindSelect = document.getElementById("layerKind");
const layerOpacityInput = document.getElementById("layerOpacity");
const layerOpacityOut = document.getElementById("layerOpacityOut");
const layerLockButton = document.getElementById("layerLock");
const panelAddLayerButton = document.getElementById("panelAddLayer");
const panelAddFolderButton = document.getElementById("panelAddFolder");
const panelAddAnimationFolderButton = document.getElementById("panelAddAnimationFolder");
const panelDuplicateLayerButton = document.getElementById("panelDuplicateLayer");
const panelUnfoldButton = document.getElementById("panelUnfold");
const panelDeleteLayerButton = document.getElementById("panelDeleteLayer");
const panelLayerUpButton = document.getElementById("panelLayerUp");
const panelLayerDownButton = document.getElementById("panelLayerDown");
const quickBar = document.getElementById("quickBar");
const quickSwatch = document.getElementById("quickSwatch");
const quickWidth = document.getElementById("quickWidth");
const quickWidthValue = document.getElementById("quickWidthValue");
const quickUndo = document.getElementById("quickUndo");
const quickRedo = document.getElementById("quickRedo");
const quickHide = document.getElementById("quickHide");
const pressureGainInput = document.getElementById("pressureGain");
const pressureGainValue = document.getElementById("pressureGainValue");
const touchDrawInput = document.getElementById("touchDraw");

const layerNameInput = document.getElementById("layerName");
const opacityInput = document.getElementById("opacity");
const transformXInput = document.getElementById("transformX");
const transformYInput = document.getElementById("transformY");
const transformScaleInput = document.getElementById("transformScale");
const transformScaleValue = document.getElementById("transformScaleValue");
const transformRotationInput = document.getElementById("transformRotation");
const transformResetButton = document.getElementById("transformReset");
const opacityValue = document.getElementById("opacityValue");
const preBehaviorInput = document.getElementById("preBehavior");
const postBehaviorInput = document.getElementById("postBehavior");

const playButton = document.getElementById("playButton");
const loopInput = document.getElementById("loop");
const fpsInput = document.getElementById("fps");
const startFrameInput = document.getElementById("startFrame");
const frameCountInput = document.getElementById("frameCount");
const frameLabel = document.getElementById("frameLabel");
const addLayerButton = document.getElementById("addLayerButton");
const addGroupButton = document.getElementById("addGroupButton");
const removeGroupButton = document.getElementById("removeGroupButton");
const deleteLayerButton = document.getElementById("deleteLayerButton");
const firstFrameButton = document.getElementById("firstFrameButton");
const previousKeyButton = document.getElementById("previousKeyButton");
const nextKeyButton = document.getElementById("nextKeyButton");
const lastFrameButton = document.getElementById("lastFrameButton");
const clipLayerInput = document.getElementById("clipLayer");
const frameReadout = document.getElementById("frameReadout");
const cellNamesButton = document.getElementById("cellNamesButton");
const keyMarkersButton = document.getElementById("keyMarkersButton");
const compactViewButton = document.getElementById("compactViewButton");
const timelineMenuButton = document.getElementById("timelineMenuButton");
const timelineMenu = document.getElementById("timelineMenu");
const menuFps = document.getElementById("menuFps");
const menuStartFrame = document.getElementById("menuStartFrame");
const menuLoop = document.getElementById("menuLoop");
const menuOnion = document.getElementById("menuOnion");
const menuAddFolder = document.getElementById("menuAddFolder");
const menuFirstFrame = document.getElementById("menuFirstFrame");
const menuLastFrame = document.getElementById("menuLastFrame");
const layerUpButton = document.getElementById("layerUpButton");
const layerDownButton = document.getElementById("layerDownButton");
const addFrameButton = document.getElementById("addFrameButton");
const duplicateFrameButton = document.getElementById("duplicateFrameButton");
const holdButton = document.getElementById("holdButton");
const deleteFrameButton = document.getElementById("deleteFrameButton");
const exposureInput = document.getElementById("exposure");
const timelineEl = document.getElementById("timeline");

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const dirInput = document.getElementById("dirInput");
const dirList = document.getElementById("dirList");
const nameInput = document.getElementById("nameInput");
const upButton = document.getElementById("upButton");
const goButton = document.getElementById("goButton");
const cancelButton = document.getElementById("cancelButton");
const confirmButton = document.getElementById("confirmButton");

const helpButton = document.getElementById("helpButton");
const helpMenu = document.getElementById("helpMenu");
const startOverlay = document.getElementById("startOverlay");
const startRecent = document.getElementById("startRecent");
const startDrawButton = document.getElementById("startDraw");
const startOpenButton = document.getElementById("startOpen");
const startImportButton = document.getElementById("startImport");
const startImportFlaButton = document.getElementById("startImportFla");
const startGuideButton = document.getElementById("startGuide");
const startKeysButton = document.getElementById("startKeys");
const showStartInput = document.getElementById("showStart");
const guideDialog = document.getElementById("guideDialog");
const keysDialog = document.getElementById("keysDialog");
const keysBody = document.getElementById("keysBody");

const state = {
  project: blankProject(960, 600),
  currentPath: null,
  suggestedName: null,
  clipSourcePath: null,
  dirty: false,
  // The open documents. The active one is mirrored in the fields above.
  documents: [],
  activeIndex: 0,
  recent: [],
  drawing: null,
  // The part of the canvas the tools may touch, as a mask (see
  // `core/selection.js`). It belongs to the document that is open, not to the
  // picture, so it is not written to the file: Flash does not save a
  // selection either.
  selection: null,
  // The selection being dragged out, or the ink of a selection being moved.
  selectionDrag: null,
  // The shape the marquee drags out: a rectangle or an oval.
  marqueeShape: "rect",
  strokeBefore: null,
  strokeWasNew: false,
  pressureEnabled: true,
  tool: "brush",
  // Show the camera's shot in the stage (off = whole canvas with a frame on it).
  cameraView: true,
  // The camera frame being dragged, and the drag itself.
  cameraLive: null,
  cameraDrag: null,
  // Waveform of the sound track, and the element that plays it.
  audioPeaks: null,
  audioElement: null,
  // Line smoothing while drawing (0 = off, up to 10 = very smooth).
  smoothedPoint: null,
  // The run of a freehand stroke as the hand put it down (after the
  // stabiliser). The Flash 8 brush fit reads this whole run, so the line
  // that is shown while drawing is the line that is left behind.
  rawSamples: null,
  // The settings of each tool, so that one tool does not change the other:
  // how wide it draws, how steady the line is, how strong it paints and how
  // it mixes with the paint under it.
  toolSettings: {
    brush: {
      width: 6,
      stabilizer: 0,
      opacity: 100,
      blend: "normal",
      binarize: false,
      flow: 100,
      hardness: 100,
      thickness: 100,
      spacing: 25,
      paper: false,
    },
    pencil: {
      width: 3,
      stabilizer: 0,
      opacity: 100,
      blend: "normal",
      binarize: false,
      flow: 100,
      hardness: 100,
      thickness: 100,
      spacing: 25,
      paper: false,
    },
    eraser: {
      width: 30,
      stabilizer: 0,
      opacity: 100,
      blend: "normal",
      binarize: false,
      flow: 100,
      hardness: 100,
      thickness: 100,
      spacing: 25,
      paper: false,
    },
    line: { width: 3, stabilizer: 0, opacity: 100, blend: "normal" },
    rect: { width: 3, stabilizer: 0, opacity: 100, blend: "normal" },
    ellipse: { width: 3, stabilizer: 0, opacity: 100, blend: "normal" },
    fill: { width: 6, stabilizer: 0, opacity: 100, blend: "normal" },
  },
  homeDir: ".",
  playing: false,
  playTimer: null,
  // The folders that are closed in the timeline.
  collapsed: new Set(),
  // Write the name of every cell in the timeline, and mark the keys above
  // the frame numbers.
  showCellNames: true,
  showKeyMarkers: true,
  // Small rows in the timeline (off = rows with room for a name).
  compactTimeline: true,
  opacityBefore: null,
  tvppSourcePath: null,
  // Remembered preferences (pressure gain, touch drawing, start screen).
  pressureGain: 1,
  touchDraw: true,
  showStart: true,
  playSpeed: 1,
  onion: { enabled: false, before: 2, after: 1 },
};

// The undo stack of the document that is being edited. Every open document
// keeps its own stack, so switching tabs does not lose the history.
let history = new History({ limit: 100 });

/* ------------------------------------------------------------------ model */

function createLayer(name) {
  return {
    name,
    type: "anim",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    preBehavior: "none",
    postBehavior: "hold",
    clip: false,
    parent: -1,
    drawings: [],
  };
}

/** A folder holds other layers. */
function createGroup(name) {
  return {
    ...createLayer(name),
    type: "group",
  };
}

function blankProject(width, height) {
  return {
    format: FORMAT,
    version: VERSION,
    width,
    height,
    background: "#ffffff",
    image: null,
    fps: 12,
    startFrame: 1,
    currentLayer: 0,
    currentFrame: 1,
    loop: true,
    layers: [createLayer("Layer 1")],
  };
}

function currentLayer() {
  return state.project.layers[state.project.currentLayer];
}

function totalDrawings(project) {
  return project.layers.reduce((sum, layer) => sum + layer.drawings.length, 0);
}

function canAddDrawings(project, layer, count) {
  if (layer.drawings.length + count > MAX_DRAWINGS_PER_LAYER) {
    setStatus(`A layer can hold at most ${MAX_DRAWINGS_PER_LAYER} drawings`, true);
    return false;
  }
  if (totalDrawings(project) + count > MAX_TOTAL_DRAWINGS) {
    setStatus(`A project can hold at most ${MAX_TOTAL_DRAWINGS} drawings`, true);
    return false;
  }
  return true;
}

function snapshot() {
  const project = state.project;
  return structuredClone({
    layers: project.layers,
    currentLayer: project.currentLayer,
    currentFrame: project.currentFrame,
    fps: project.fps,
    startFrame: project.startFrame,
    loop: project.loop,
    camera: project.camera,
    audio: project.audio,
    // The room the sheet grew to hold the ink travels with the history: a
    // stroke that grew the sheet is undone with the room it asked for.
    pasteboardPad: project.pasteboardPad ?? null,
  });
}

function restore(snapshotValue) {
  const clean = structuredClone(snapshotValue);
  // The sheet the project had, so the view can follow a sheet that changed:
  // a room that was grown is taken back with the stroke that asked for it.
  const docBefore = state.project ? documentSize(state.project) : null;
  const padBefore = docBefore ? stagePadding(docBefore.width, docBefore.height) : null;
  Object.assign(state.project, {
    layers: clean.layers,
    currentLayer: clean.currentLayer,
    currentFrame: clean.currentFrame,
    fps: clean.fps,
    startFrame: clean.startFrame,
    loop: clean.loop,
    camera: clean.camera ?? null,
    audio: clean.audio ?? null,
    pasteboardPad: clean.pasteboardPad ?? null,
  });
  clampSelection();
  const docAfter = documentSize(state.project);
  const padAfter = stagePadding(docAfter.width, docAfter.height);
  if (padBefore && (padAfter.x !== padBefore.x || padAfter.y !== padBefore.y)) {
    const zoom = viewZoom || 1;
    applyView();
    canvasScroll.scrollLeft += (padAfter.x - padBefore.x) * zoom;
    canvasScroll.scrollTop += (padAfter.y - padBefore.y) * zoom;
    expectedScrollLeft = canvasScroll.scrollLeft;
    expectedScrollTop = canvasScroll.scrollTop;
  }
}

function clampSelection() {
  const project = state.project;
  if (!Array.isArray(project.layers) || project.layers.length === 0) {
    project.layers = [createLayer("Layer 1")];
  }
  project.currentLayer = Math.max(
    0,
    Math.min(project.layers.length - 1, Number.isInteger(project.currentLayer) ? project.currentLayer : 0),
  );
  project.currentFrame = Math.max(
    project.startFrame,
    Math.min(10_000_000, Number.isInteger(project.currentFrame) ? project.currentFrame : project.startFrame),
  );
}

function updateHistoryButtons() {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
  if (quickUndo) quickUndo.disabled = !history.canUndo;
  if (quickRedo) quickRedo.disabled = !history.canRedo;
}

/* --------------------------------------------------------- quick bar over the canvas */

/** Keep the quick bar in step with the tools panel. */
function syncQuickBar() {
  if (!quickBar) return;
  quickSwatch.style.background = colorInput.value;
  quickWidth.value = widthInput.value;
  quickWidthValue.textContent = widthInput.value;
}

quickSwatch?.addEventListener("click", () => {
  colorInput.click();
});

quickWidth?.addEventListener("input", () => {
  widthInput.value = quickWidth.value;
  widthValue.textContent = quickWidth.value;
  if (brushShapeSize) brushShapeSize.textContent = `${quickWidth.value}px`;
  toolSettings().width = Number(quickWidth.value);
  syncQuickBar();
  syncBrushSizeGrid();
  syncGauges();
});

quickUndo?.addEventListener("click", () => undo());
quickRedo?.addEventListener("click", () => redo());

quickHide?.addEventListener("click", () => {
  const collapsed = quickBar.classList.toggle("collapsed");
  quickHide.textContent = collapsed ? "▣" : "×";
  quickHide.title = collapsed ? "Show this bar" : "Hide this bar";
});

function recordHistory(before) {
  if (!before) return;
  history.record(before);
  updateHistoryButtons();
}

function markDirty() {
  state.dirty = true;
  refreshTitle();
  renderDocumentTabs();
}

function undo() {
  if (state.drawing) return;
  stopPlayback();
  const previous = history.undo(snapshot());
  if (!previous) return;
  restore(previous);
  state.dirty = true;
  afterChange();
  setStatus("Undo");
}

function redo() {
  if (state.drawing) return;
  stopPlayback();
  const next = history.redo(snapshot());
  if (!next) return;
  restore(next);
  state.dirty = true;
  afterChange();
  setStatus("Redo");
}

function baseName(filePath) {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function isAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

function joinPath(dir, name) {
  if (isAbsolute(name)) return name;
  const base = dir || state.homeDir || ".";
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function withTvminiExtension(filePath) {
  const trimmed = filePath.trim();
  return /\.[^\\/]*$/.test(trimmed) ? trimmed : `${trimmed}.tvmini`;
}

function withClipExtension(filePath) {
  const trimmed = filePath.trim();
  if (!/\.[^\\/]*$/.test(trimmed)) return `${trimmed}.clip`;
  return /\.clip$/i.test(trimmed) ? trimmed : `${trimmed}.clip`;
}

/** Windows paths are case-insensitive; this only guards the imported source. */
function samePath(left, right) {
  const clean = (value) =>
    value.replace(/\//g, "\\").replace(/\\+/g, "\\").replace(/\\$/, "").toLowerCase();
  return clean(left) === clean(right);
}

/* --------------------------------------------------------------- backend */

/**
 * The file backend. This is the Node server when one is running, and the
 * browser's own storage on a static host such as GitHub Pages.
 */
let backend = null;

/* ------------------------------------------------------------------- view */

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusBar.classList.toggle("error", isError);
}

function refreshTitle() {
  // The title follows the tab: an imported document that is not saved yet
  // keeps the name the import gave it.
  const open = activeDocument();
  const name = open
    ? documentName(open)
    : state.currentPath
      ? baseName(state.currentPath)
      : "Untitled";
  document.title = `${name}${state.dirty ? " *" : ""} — TVMini`;
  pathLabel.textContent = state.currentPath || "not saved yet";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A small button that shows one of the icons in the sprite.
 *
 * The icons are the shapes of the timeline: a rectangle is a layer, a circle
 * is a folder, a triangle is a drawing. They are drawn in one place — the
 * sprite at the top of the page — so a row of the timeline and the panel
 * beside it always show the same mark.
 */
function iconButton(className, symbol, title) {
  const button = element("button", className);
  button.title = title;
  button.append(iconGlyph(symbol));
  return button;
}

/** The same icon, but not a button — for a mark inside a button. */
function iconGlyph(symbol) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tli");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${symbol}`);
  svg.append(use);
  return svg;
}

/**
 * The play button shows a triangle while the animation is stopped and two
 * bars while it runs.
 */
function setPlayIcon(playing) {
  if (!playButton) return;
  const use = playButton.querySelector("use");
  if (use) use.setAttribute("href", playing ? "#i-pause" : "#i-play");
  const label = document.getElementById("playLabel");
  if (label) label.textContent = playing ? "Pause" : "Play";
  playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
}

/* ------------------------------------------------------------- documents */

/** The record of the document that is being edited. */
function activeDocument() {
  return state.documents[state.activeIndex] ?? null;
}

/** Copy the live fields into the active document record. */
function captureDocument() {
  const open = activeDocument();
  if (!open) return;
  open.project = state.project;
  open.currentPath = state.currentPath;
  open.suggestedName = state.suggestedName;
  open.clipSourcePath = state.clipSourcePath;
  open.tvppSourcePath = state.tvppSourcePath;
  open.dirty = state.dirty;
  open.history = history;
}

/** True when a document has never been saved and holds no work. */
function isPristine(open) {
  if (!open) return true;
  if (open.currentPath || open.dirty) return false;
  for (const layer of open.project.layers) {
    if (layer.drawings.length > 0) return false;
  }
  return true;
}

/** Put a document's fields into the live ones. */
function loadDocument(open) {
  state.project = open.project;
  state.currentPath = open.currentPath;
  state.suggestedName = open.suggestedName;
  state.clipSourcePath = open.clipSourcePath;
  state.tvppSourcePath = open.tvppSourcePath;
  state.dirty = open.dirty;
  history = open.history;
  // A selection belongs to the picture it was made on, so another document
  // starts with none.
  state.selection = null;
  state.selectionDrag = null;
}

/** The name shown on a tab. */
function documentName(open) {
  if (open.currentPath) return baseName(open.currentPath);
  if (open.suggestedName) return open.suggestedName.replace(/\.tvmini$/i, "");
  return "Untitled";
}

/** Show another document. */
function activateDocument(index) {
  if (index === state.activeIndex) return;
  if (index < 0 || index >= state.documents.length) return;
  stopPlayback();
  captureDocument();
  state.activeIndex = index;
  loadDocument(state.documents[index]);

  resizeCanvas();
  refreshTitle();
  updateHistoryButtons();
  updateFrameLabel();
  renderDocumentTabs();
  loadSoundTrack();
  setStatus(`Switched to ${documentName(state.documents[index])}`);
}

/**
 * Put a project on the screen.
 *
 * An untouched empty document is reused, so opening a file does not leave a
 * blank tab behind; anything else opens in a new tab.
 */
function showDocument(project, options = {}) {
  const current = activeDocument();
  const fresh = {
    project,
    currentPath: options.currentPath ?? null,
    suggestedName: options.suggestedName ?? null,
    clipSourcePath: options.clipSourcePath ?? null,
    tvppSourcePath: options.tvppSourcePath ?? null,
    dirty: false,
    history: new History({ limit: 100 }),
  };

  if (current && isPristine(current) && state.documents.length === 1) {
    state.documents[0] = fresh;
    state.activeIndex = 0;
  } else {
    state.documents.push(fresh);
    state.activeIndex = state.documents.length - 1;
  }
  loadDocument(state.documents[state.activeIndex]);

  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  renderDocumentTabs();
  loadSoundTrack();
}

/** Start a new empty document in its own tab. */
function newDocument() {
  const fresh = {
    project: blankProject(960, 600),
    currentPath: null,
    suggestedName: null,
    clipSourcePath: null,
    tvppSourcePath: null,
    dirty: false,
    history: new History({ limit: 100 }),
  };
  captureDocument();
  state.documents.push(fresh);
  state.activeIndex = state.documents.length - 1;
  loadDocument(fresh);

  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  renderDocumentTabs();
  setStatus("New document");
}

/** Close a document. The last one is never closed, it is emptied instead. */
function closeDocument(index) {
  if (index < 0 || index >= state.documents.length) return;
  captureDocument();

  const open = state.documents[index];
  if (open.dirty && !confirm(`"${documentName(open)}" has unsaved changes. Close it anyway?`)) {
    return;
  }

  if (state.documents.length === 1) {
    // Keep one document open: empty the current one instead.
    state.documents[0] = {
      project: blankProject(960, 600),
      currentPath: null,
      suggestedName: null,
      clipSourcePath: null,
      tvppSourcePath: null,
      dirty: false,
      history: new History({ limit: 100 }),
    };
    state.activeIndex = 0;
  } else {
    state.documents.splice(index, 1);
    state.activeIndex = Math.min(index, state.documents.length - 1);
  }
  loadDocument(state.documents[state.activeIndex]);

  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  renderDocumentTabs();
  loadSoundTrack();
  setStatus("Document closed");
}

/** Draw the tab strip in the top bar. */
function renderDocumentTabs() {
  const bar = document.getElementById("docTabBar");
  if (!bar) return;
  // The live fields belong to the active document, so put them into its
  // record before the names and the dirty dots are read.
  captureDocument();
  bar.replaceChildren();

  state.documents.forEach((open, index) => {
    const tab = element("div", "doc-tab");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(index === state.activeIndex));
    if (index === state.activeIndex) tab.classList.add("active");

    const dot = element("span", "doc-tab-dot");
    dot.setAttribute("aria-hidden", "true");
    if (!open.dirty) dot.style.opacity = "0.25";
    tab.append(dot);

    tab.append(element("span", "doc-tab-name", documentName(open)));

    const close = element("button", "doc-tab-close", "✕");
    close.title = "Close this document";
    close.setAttribute("aria-label", `Close ${documentName(open)}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeDocument(index);
    });
    tab.append(close);

    tab.addEventListener("click", () => activateDocument(index));
    bar.append(tab);
  });

  const add = element("button", "doc-tab-add", "+");
  add.title = "New document (Ctrl+N)";
  add.setAttribute("aria-label", "New document");
  add.addEventListener("click", () => newDocument());
  bar.append(add);
}

function updateFrameLabel() {
  const project = state.project;
  const end = Math.max(project.startFrame, contentEnd(project));
  const outside = project.currentFrame > end ? " (outside content)" : "";
  frameLabel.textContent = `Frame ${project.currentFrame} / ${end}${outside}`;
  updateFrameReadout();
}

/**
 * The size of the stage's own buffer.
 *
 * The document is drawn in the pixels of the document, but the buffer it is
 * drawn into is the size the stage is shown at, times the number of dots a
 * pixel of the screen has. That is what keeps the picture sharp on a screen
 * with many dots per pixel, and it is the way MoArt draws as well.
 *
 * A big zoom would ask for a buffer that no screen can show, so the buffer
 * is held back at four thousand pixels on its longest side.
 */
const MAX_STAGE_BUFFER = 4096;

function stageBuffer() {
  const project = state.project;
  const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const zoom = viewZoom || 1;
  // The buffer must hold the whole document, including strokes outside the
  // project canvas (the Flash pasteboard).
  const doc = documentSize(project);
  const docWidth = doc.width;
  const docHeight = doc.height;
  // The size the stage is shown at, measured from the element itself. That is
  // the size the buffer has to match, whatever the page, the window or the
  // browser does to it.
  const box = canvas.getBoundingClientRect();
  const shownWidth = box.width || docWidth * zoom;
  const shownHeight = box.height || docHeight * zoom;
  // The buffer holds the dots of the screen: the size on the screen, times
  // the number of dots a pixel of the screen has.
  let width = Math.round(shownWidth * ratio);
  let height = Math.round(shownHeight * ratio);
  const biggest = Math.max(width, height);
  if (biggest > MAX_STAGE_BUFFER) {
    const shrink = MAX_STAGE_BUFFER / biggest;
    width = Math.max(1, Math.round(width * shrink));
    height = Math.max(1, Math.round(height * shrink));
  }
  return { width, height, ratio, scale: (width / project.width) };
}

/** Put a context into the pixels of the document. */
function useDocumentSpace(docWidth, docHeight, target = ctx) {
  // One document pixel equals so many pixels of the buffer the target draws
  // into. The buffer is sized to hold the whole document; when a big zoom
  // would ask for a buffer no screen can show, the buffer is held back at
  // its cap and the scale follows the buffer, so the whole document still
  // lands in it: the drawing is only a little softer there, never shifted,
  // and the brush stays under the pointer.
  const scale = target.canvas.width / docWidth;
  // The canvas is in the middle of the sheet, so the sheet starts half of
  // what it gained before the canvas does.
  const pad = stagePadding(docWidth, docHeight);
  target.setTransform(scale, 0, 0, scale, pad.x * scale, pad.y * scale);
  return scale;
}

/**
 * The shot the camera takes, or null when the whole canvas is shown.
 *
 * The camera tool works on the whole canvas, so the camera view is left
 * alone while that tool is in the hand.
 */
function currentCameraView() {
  const project = state.project;
  if (!state.cameraView || state.tool === "camera") return null;
  return cameraView(
    project.camera,
    project.currentFrame,
    project.width,
    project.height,
  );
}

/**
 * Put a context into the pixels of the stage.
 *
 * The stage shows the shot the camera takes: the context is scaled to the
 * document and, when the camera view is on, moved so that the camera window
 * is in the middle of the stage. Everything outside the window is cut away.
 *
 * The sheet on top of the stage is put in the same place, so the shape of
 * the brush sits under the pointer and the stroke that is being drawn is
 * shown where it will be.
 */
function useStageSpace(docWidth, docHeight, target = ctx) {
  const scale = useDocumentSpace(docWidth, docHeight, target);
  const view = currentCameraView();
  if (!view) return { scale, view: null };
  const pad = stagePadding(docWidth, docHeight);
  target.save();
  target.setTransform(
    view.scale * scale,
    0,
    0,
    view.scale * scale,
    (pad.x + view.offsetX - view.camera.x * view.scale) * scale,
    (pad.y + view.offsetY - view.camera.y * view.scale) * scale,
  );
  target.beginPath();
  target.rect(view.camera.x, view.camera.y, view.camera.width, view.camera.height);
  target.clip();
  return { scale, view };
}

// The stage follows the window: the buffer of the stage holds the dots of
// the screen, so it is made again when the window changes.
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    const buffer = stageBuffer();
    if (canvas.width !== buffer.width || canvas.height !== buffer.height) {
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      renderCanvas();
    }
    // The world follows the pane, so the bars of the pane keep their room
    // when the window is made bigger.
    const project = state.project;
    if (project) {
      const zoom = viewZoom || 1;
      const doc = documentSize(project);
      sizeWorld(Math.round(doc.width * zoom), Math.round(doc.height * zoom));
    }
  });

  // The panels of the window can be pulled out of it and made bigger, so
  // the world of the stage follows the panel it sits in.
  window.addEventListener("tvmini:layout", () => {
    const project = state.project;
    if (!project) return;
    const zoom = viewZoom || 1;
    const doc = documentSize(project);
    sizeWorld(Math.round(doc.width * zoom), Math.round(doc.height * zoom));
  });
}

function resizeCanvas() {
  const buffer = stageBuffer();
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  // The element is the size the document is shown at, and the buffer holds
  // the dots of the screen.
  applyView();
  centreStage();
  renderCanvas();
  renderTimeline();
  renderLayerPanel();
  syncLayerControls();
  updateFrameLabel();
}

let previewKey = null;
let previewImage = null;

/** Lazily decode the imported .clip preview and redraw once it is ready. */
function projectImage() {
  const data = state.project.image?.data;
  if (!data) {
    previewKey = null;
    previewImage = null;
    return null;
  }

  if (data !== previewKey) {
    previewKey = data;
    previewImage = new Image();
    previewImage.onload = queueCanvasRepaint;
    previewImage.src = `data:image/png;base64,${data}`;
  }

  return previewImage?.complete ? previewImage : null;
}

const paintCanvas = document.createElement("canvas");
// No willReadFrequently: nothing reads these scratch canvases back, and a
// GPU-backed one makes the translucent and clipped layers of an imported
// document compositing work instead of memory traffic.
const paintCtx = paintCanvas.getContext("2d");
// Scratch canvas for a layer that is drawn through one: an eraser has to
// take ink away from its own layer only. It is the size of the screen, so
// the strokes in it are drawn in the pixels of the screen and a line that
// is magnified stays sharp.
const layerCanvas = document.createElement("canvas");
const layerCtx = layerCanvas.getContext("2d");
// Scratch canvas for transparent/blending strokes: the stroke is painted
// opaque here first, then applied to the paint canvas in a single pass.
const blendCanvas = document.createElement("canvas");
const blendCtx = blendCanvas.getContext("2d");
// The box of the buffer the mask was last worked on, so a stroke's pass is
// the size of its ink and not of the whole buffer.
const blendScratch = { stroke: null, box: { x: 0, y: 0, w: 0, h: 0 } };
// Scratch canvas for a stroke that is drawn on paper: the stroke is painted
// here first, then the grain of the paper is taken out of the whole stroke in
// one place, so the overlaps of the dabs do not keep their ink.
const grainCanvas = document.createElement("canvas");
const grainCtx = grainCanvas.getContext("2d");
// Scratch canvas that holds the picture of the layer below a clipped one.
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
// Scratch canvas where a clipped layer is cut by the layer below it.
const clipCanvas = document.createElement("canvas");
const clipCtx = clipCanvas.getContext("2d");

/* Raster bases (imported .clip/.tvpp frames), cached by data.
 *
 * An <img> element's decoded pixels live in the browser's image cache,
 * which throws pictures away under memory pressure. A document from Clip
 * Studio Paint carries dozens of full-canvas pictures - tens of megabytes
 * each once decoded - so playback kept evicting and re-decoding them every
 * frame, and the animation stuttered. An ImageBitmap stays decoded for as
 * long as we hold it: every picture is decoded once, off the main thread,
 * and drawn straight away afterwards. The cache keeps a bounded budget and
 * drops the least recently seen pictures first.
 */
const drawingImages = new Map();
// Sized to hold every cel of a 4K document that was imported from Clip
// Studio Paint - its painted boxes add up to a few hundred megabytes once
// decoded, and letting the cache hold all of them is what keeps playback
// from re-decoding pictures it has already seen.
const DRAWING_BITMAP_BUDGET = 768 * 1024 * 1024;
let drawingBitmapBytes = 0;

function drawingImageElement(drawing) {
  if (!drawing?.image?.data) return null;
  const data = drawing.image.data;
  let entry = drawingImages.get(data);
  if (!entry) {
    entry = { source: null };
    drawingImages.set(data, entry);
    decodeDrawingImage(data, entry);
  }
  // Re-inserting moves the entry to the end of the Map, which is where the
  // eviction scan looks last - the pictures on screen stay the longest.
  drawingImages.delete(data);
  drawingImages.set(data, entry);
  return entry.source;
}

async function decodeDrawingImage(data, entry) {
  try {
    if (typeof createImageBitmap === "function") {
      const response = await fetch(`data:image/png;base64,${data}`);
      entry.source = await createImageBitmap(await response.blob());
      entry.bytes = entry.source.width * entry.source.height * 4;
      drawingBitmapBytes += entry.bytes;
      trimDrawingBitmaps();
    } else {
      // A browser without bitmap decoding: the element cache is all we have.
      const element = new Image();
      element.onload = () => {
        entry.source = element;
        queueCanvasRepaint();
      };
      element.src = `data:image/png;base64,${data}`;
      if (element.complete) entry.source = element;
    }
  } catch {
    entry.source = null; // the layer shows its strokes without the picture
  }
  queueCanvasRepaint();
}

function trimDrawingBitmaps() {
  if (drawingBitmapBytes <= DRAWING_BITMAP_BUDGET) return;
  for (const [data, entry] of drawingImages) {
    if (drawingBitmapBytes <= DRAWING_BITMAP_BUDGET) break;
    if (!entry.source || !entry.bytes) continue;
    drawingImages.delete(data);
    drawingBitmapBytes -= entry.bytes;
    entry.source = null; // dropped for the collector; drawn again on demand
  }
}

/**
 * One repaint for however many pictures arrive.
 *
 * An imported document hands the stage dozens of pictures at once, and each
 * of them finishes decoding on its own moment. A repaint per picture would
 * walk the whole document dozens of times for nothing; the requests are
 * gathered into the next frame instead.
 */
function queueCanvasRepaint() {
  if (state.canvasRepaintQueued) return;
  state.canvasRepaintQueued = true;
  requestAnimationFrame(() => {
    state.canvasRepaintQueued = false;
    renderCanvas();
  });
}

const MIN_PRESSURE_SCALE = 0.2;

function strokeRadius(stroke, point) {
  const base = stroke.width / 2;
  const radius =
    point.length === 3
      ? base * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * point[2])
      : base;
  return Math.max(0.5, radius);
}

/**
 * The width of a stroke at every one of its points.
 *
 * The width follows the pressure of the hand, the way the brush of Clip Studio
 * Paint does.
 */
function strokeRadii(stroke) {
  return sharedStrokeRadii(stroke);
}

/**
 * Show the shape of the brush that is in the hand.
 *
 * The panel shows the brush itself, the way MoArt does, so that the shape
 * of the tip can be seen without drawing with it.
 */
function drawBrushShape() {
  const surface = document.getElementById("brushShapePreview");
  if (!surface) return;
  const context = surface.getContext("2d");
  const width = surface.width;
  const height = surface.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#292c2f";
  context.fillRect(0, 0, width, height);

  // The picture is a stroke across the panel, drawn by the same code as the
  // stage: the shape of the tip and the hard edge of the brush show up here,
  // so the panel cannot promise a brush the paper does not get.
  const settings = toolSettings();
  const size = Math.max(2, Math.min(30, settings.width));
  const points = [];
  const steps = 40;
  for (let step = 0; step <= steps; step += 1) {
    const at = step / steps;
    points.push([
      8 + (width - 16) * at,
      height - 8 - Math.sin(at * Math.PI) * (height - 20),
    ]);
  }
  drawStrokeDirect(
    context,
    { color: colorInput.value, width: size, points },
    width,
    height,
    strokeBrushFor(settings),
  );
}

/** The brush of a stroke.
 *
 * A stroke remembers the brush it was made with, so that changing the brush
 * does not change the strokes that are already on the paper. A stroke that
 * was made before strokes remembered their brush takes the brush of the
 * drawing.
 */
function brushOfStroke(stroke, fallback) {
  if ("brush" in stroke) return stroke.brush ?? null;
  return fallback ?? null;
}

/**
 * The settings of a brush that travel with a stroke.
 *
 * Everything that shapes the paint is kept with the stroke: the picture of the
 * tip, its size, its flow, its hardness, its thickness, the spacing of its
 * dabs, the turn of the tip, the curves that follow the hand and the grain of
 * the paper. The file a brush came from is not among them: it stays in the
 * brush library, where it is kept out of the project file.
 */
const BRUSH_SETTING_KEYS = [
  "size", "opacity", "spacing", "binarize", "flow", "hardness", "thickness",
  "rotation", "rotationFollow", "rotationJitter", "rotationEffector", "dyn", "grain",
  "autoInterval",
];

function carriedBrush(brush) {
  const carried = { data: brush?.data ?? null };
  for (const key of BRUSH_SETTING_KEYS) {
    const value = brush?.[key];
    if (value !== undefined && value !== null) carried[key] = value;
  }
  return carried;
}

/**
 * Paint strokes into a context.
 *
 * `brush` is the brush the strokes were made with. A brush that has a
 * picture paints that picture along the stroke, the way Clip Studio Paint
 * paints the shape of a brush, instead of a plain round line.
 */
// The smoothing of the hand for this program's own brushes, at the
// strength Flash 8 defaulted to. It has no control of its own any more.
const BRUSH_SMOOTHING = 50;

function drawStrokesInto(ctx, strokes, brush = null) {
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const canvasWidth = ctx.canvas.width;
  const canvasHeight = ctx.canvas.height;

  for (const stroke of strokes) {
    if (stroke.kind === "fill") {
      floodFillCanvas(ctx, canvasWidth, canvasHeight, stroke);
      continue;
    }

    const opacity = stroke.opacity ?? 1;
    const blend = stroke.blend ?? "normal";
    if (opacity < 1 || blend !== "normal") {
      // Draw the stroke opaque into a mask canvas, then apply it in one
      // pass — a multi-part stroke must not darken its own overlaps. The
      // pass is the size of the ink, not of the whole buffer, and the mask
      // is moved by the pad of the sheet, so the pasteboard is covered too.
      const pad = stagePadding(canvasWidth, canvasHeight);
      if (blendCanvas.width !== canvasWidth || blendCanvas.height !== canvasHeight) {
        blendCanvas.width = canvasWidth;
        blendCanvas.height = canvasHeight;
        blendScratch.stroke = null;
        blendScratch.box = { x: 0, y: 0, w: 0, h: 0 };
      }
      blendCtx.setTransform(1, 0, 0, 1, 0, 0);
      if (blendScratch.stroke !== stroke) {
        // A different stroke was in the mask: its room is taken out first.
        if (blendScratch.stroke) {
          blendCtx.clearRect(blendScratch.box.x, blendScratch.box.y, blendScratch.box.w, blendScratch.box.h);
        }
        blendScratch.stroke = stroke;
        blendScratch.box = { x: 0, y: 0, w: 0, h: 0 };
      }
      const extent = strokeExtent(stroke);
      const cover = { x: -pad.x, y: -pad.y, w: canvasWidth, h: canvasHeight };
      const box = extent ? intersectBoxes(extent, cover) : null;
      if (!box) continue;
      const dirty = unionBox(blendScratch.box, {
        x: box.x + pad.x,
        y: box.y + pad.y,
        w: box.w,
        h: box.h,
      });
      blendCtx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
      blendCtx.setTransform(1, 0, 0, 1, pad.x, pad.y);
      drawStrokeDirect(blendCtx, stroke, canvasWidth, canvasHeight, brushOfStroke(stroke, brush), true);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation =
        stroke.eraser === true ? "destination-out" : blend === "normal" ? "source-over" : blend;
      ctx.drawImage(
        blendCanvas,
        dirty.x,
        dirty.y,
        dirty.w,
        dirty.h,
        dirty.x - pad.x,
        dirty.y - pad.y,
        dirty.w,
        dirty.h,
      );
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      blendScratch.box = dirty;
      continue;
    }

    drawStrokeDirect(ctx, stroke, canvasWidth, canvasHeight, brushOfStroke(stroke, brush));
  }

  ctx.globalCompositeOperation = "source-over";
}

/* ------------------------------------------------- the ink in the hand */

// The stroke in the hand is stamped into layers of its own as the pointer
// moves: only the dabs that are new are put down, so a long stroke costs
// the same as a short one, and the sheet on top of the stage is not built
// from the beginning on every move. The layers are emptied when the stroke
// is out of the hand, and the finished line is the document's to draw.
const liveInkCanvas = document.getElementById("liveInk");
const liveInkCtx = liveInkCanvas?.getContext("2d");
const liveGrainCanvas = document.getElementById("liveGrain");
const liveGrainCtx = liveGrainCanvas?.getContext("2d");

const liveStrokeState = {
  active: false,
  brush: null,
  style: null,
  grained: false,
  stamped: 0,       // how many raw samples the layers hold
  box: null,        // the room the ink covers, in the canvas coordinates
};

/** Take the stroke in the hand onto the layers of the living ink. A brush
    with a picture of its own is what stamps itself here; a plain line and
    the shapes are drawn on the sheet as they always were. */
function startLiveStroke(stroke, brush) {
  liveStrokeState.active = false;
  if (!liveInkCtx || !liveGrainCtx || !brush?.data || stroke.eraser || stroke.kind) return;
  liveInkCanvas.width = ctx.canvas.width;
  liveInkCanvas.height = ctx.canvas.height;
  liveGrainCanvas.width = ctx.canvas.width;
  liveGrainCanvas.height = ctx.canvas.height;
  liveStrokeState.brush = brush;
  liveStrokeState.style = strokeStyleOf(brush);
  liveStrokeState.grained = Boolean(liveStrokeState.style.grain?.data);
  liveStrokeState.stamped = 0;
  liveStrokeState.box = null;
  const opacity = String(stroke.opacity ?? 1);
  const blend = stroke.blend ?? "normal";
  liveInkCanvas.style.opacity = opacity;
  liveInkCanvas.style.mixBlendMode = blend;
  liveGrainCanvas.style.opacity = opacity;
  liveGrainCanvas.style.mixBlendMode = blend;
  // The grained layer carries the ink with the grain taken out, and stands
  // over the plain one, so both are never seen at once.
  liveInkCanvas.hidden = liveStrokeState.grained;
  liveGrainCanvas.hidden = !liveStrokeState.grained;
  liveStrokeState.active = true;
}

/** Put the dabs of the samples that came in onto the layers. */
function stampLiveStroke() {
  if (!liveStrokeState.active) return;
  const stroke = state.drawing;
  if (!stroke) {
    endLiveStroke();
    return;
  }
  const run = state.rawSamples;
  if (!run || liveStrokeState.stamped >= run.length) return;
  // A zoom or a grown sheet made the buffer again: everything is stamped
  // from the beginning, the samples hold the whole stroke.
  if (liveInkCanvas.width !== ctx.canvas.width || liveInkCanvas.height !== ctx.canvas.height) {
    liveInkCanvas.width = ctx.canvas.width;
    liveInkCanvas.height = ctx.canvas.height;
    liveGrainCanvas.width = ctx.canvas.width;
    liveGrainCanvas.height = ctx.canvas.height;
    liveStrokeState.stamped = 0;
    liveStrokeState.box = null;
  }
  const project = state.project;
  const doc = documentSize(project);
  const scale = useDocumentSpace(doc.width, doc.height, liveInkCtx);
  const pad = stagePadding(doc.width, doc.height);
  const shape = tintedTip(liveStrokeState.brush, stroke.color, liveStrokeState.style.binarize);
  // The run of samples only ever grows, so the dabs that are in are the
  // ones of the samples before the last stamp, and the segment from there
  // to the end carries the ones that are new.
  const from = Math.max(0, liveStrokeState.stamped - 1);
  const continuing = liveStrokeState.stamped > 0;
  const segment = { ...stroke, points: run.slice(from) };
  const dabs = strokeDabs(segment, liveStrokeState.style, null);
  const fresh = continuing && dabs.length > 1 ? dabs.slice(1) : dabs;
  const aspect = shape ? shape.width / Math.max(1, shape.height) : 1;
  let box = null;
  for (const dab of fresh) {
    stampDab(liveInkCtx, dab, liveStrokeState.style, shape, stroke.color, "circle");
    const reach = Math.max(2, dab.r * 2 * Math.max(1, aspect));
    box = unionBox(box, { x: dab.x - reach, y: dab.y - reach, w: reach * 2, h: reach * 2 });
  }
  liveStrokeState.stamped = run.length;
  liveStrokeState.box = unionBox(liveStrokeState.box, box);
  if (liveStrokeState.grained && box) {
    // The grain is taken out of the room the new dabs cover: the plain ink
    // is copied over and the grain is laid on it, so a place is never
    // grained twice however often the stroke crosses itself.
    const region = {
      x: Math.max(0, Math.floor((box.x + pad.x) * scale)),
      y: Math.max(0, Math.floor((box.y + pad.y) * scale)),
    };
    region.w = Math.min(liveGrainCanvas.width, Math.ceil((box.x + pad.x + box.w) * scale)) - region.x;
    region.h = Math.min(liveGrainCanvas.height, Math.ceil((box.y + pad.y + box.h) * scale)) - region.y;
    if (region.w > 0 && region.h > 0) {
      liveGrainCtx.setTransform(1, 0, 0, 1, 0, 0);
      liveGrainCtx.clearRect(region.x, region.y, region.w, region.h);
      liveGrainCtx.drawImage(
        liveInkCanvas,
        region.x,
        region.y,
        region.w,
        region.h,
        region.x,
        region.y,
        region.w,
        region.h,
      );
      applyGrainToCanvas(
        liveGrainCtx,
        region,
        liveStrokeState.style.grain,
        { x: pad.x * scale, y: pad.y * scale },
        scale,
      );
    }
  }
}

/** The stroke is out of the hand: the living layers are emptied and put
    away, and the finished line is the document's to draw. */
function endLiveStroke() {
  if (!liveStrokeState.active) return;
  liveStrokeState.active = false;
  liveInkCanvas.hidden = true;
  liveGrainCanvas.hidden = true;
  liveInkCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveInkCtx.clearRect(0, 0, liveInkCanvas.width, liveInkCanvas.height);
  liveGrainCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveGrainCtx.clearRect(0, 0, liveGrainCanvas.width, liveGrainCanvas.height);
}

/** The pictures of the brushes, in the colours they were used in. */
const tintedTips = new Map();

/**
 * The picture of a brush in the colour of the stroke.
 *
 * The picture of a brush is only the shape of the tip, so the colour of the
 * stroke is mixed into it. The result is kept, because the same brush and
 * the same colour are used again and again.
 */
function tintedTip(brush, color, binarize = false) {
  const picture = tipImage(brush);
  if (!picture.complete || !picture.naturalWidth) return null;
  const key = `${brush.data}|${color}|${binarize ? 1 : 0}`;
  if (tintedTips.has(key)) return tintedTips.get(key);

  const surface = document.createElement("canvas");
  surface.width = picture.naturalWidth;
  surface.height = picture.naturalHeight;
  const context = surface.getContext("2d");
  context.drawImage(picture, 0, 0);
  // "source-in" keeps the picture and takes the colour of the fill, so the
  // shape of the tip is painted in the colour of the stroke.
  context.globalCompositeOperation = "source-in";
  context.fillStyle = color;
  context.fillRect(0, 0, surface.width, surface.height);
  context.globalCompositeOperation = "source-over";
  // Binarize takes the fade of the picture away, so the tip keeps its shape
  // but none of its soft edge.
  if (binarize) binarizeSurface(surface);

  if (tintedTips.size > 8) tintedTips.clear();
  tintedTips.set(key, surface);
  // The key travels with the picture, so the dabs can keep a copy of it at
  // the size they draw it at.
  surface.__tipKey = key;
  return surface;
}

/** The pictures of the brushes at the sizes the dabs draw them at. */
const scaledTips = new Map();

/**
 * The tinted picture of a brush, made small once for the size of a dab.
 *
 * A dab draws the picture of the brush at its own size, and drawing a big
 * picture small, turned, for every dab of a dense brush, is the lag of a
 * CSP brush. The picture is made small once for each size and every dab of
 * that size puts the small picture down instead.
 */
function scaledTip(picture, along, across) {
  const width = Math.max(1, Math.round(along));
  const height = Math.max(1, Math.round(across));
  const key = `${picture.__tipKey ?? ""}|${width}x${height}`;
  let surface = scaledTips.get(key);
  if (!surface) {
    surface = document.createElement("canvas");
    surface.width = width;
    surface.height = height;
    const context = surface.getContext("2d");
    context.drawImage(picture, 0, 0, width, height);
    if (scaledTips.size > 400) scaledTips.clear();
    scaledTips.set(key, surface);
  }
  return surface;
}

/** Where a stroke, and the paint around it, lies in the document. */
function strokeBox(stroke, radii) {
  const pad = Math.max(2, Math.max(...radii) * 1.5);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const point of stroke.points) {
    x0 = Math.min(x0, point[0]);
    y0 = Math.min(y0, point[1]);
    x1 = Math.max(x1, point[0]);
    y1 = Math.max(y1, point[1]);
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/**
 * The dabs of a stroke.
 *
 * A brush puts its paint down one dab at a time, a little apart along the
 * path, and that is what makes a brush feel like a brush. Where the dabs go,
 * how big they are, how flat the tip is, how it is turned and how much paint
 * each one leaves is worked out by `brush-dynamics.js`, the same plan the
 * software renderer uses, so the line on the stage and the line in the file
 * are the same line.
 */
function drawStrokeWithDabs(ctx, stroke, style, picture = null, outline = null) {
  const tip = stroke?.tip || "circle";
  for (const dab of strokeDabs(stroke, style, outline)) {
    stampDab(ctx, dab, style, picture, stroke.color, tip);
  }
}

/**
 * One dab of the brush.
 *
 * The picture of the brush (in the colour of the stroke) or a disc is put
 * down at the place of the dab, turned by its angle, squashed by the
 * thickness of the brush, and at the share of the paint the dab leaves.
 */
function stampDab(ctx, dab, style, picture, color, tipShape = "circle") {
  const across = Math.max(1, dab.r * 2 * dab.flat);
  const along = picture
    ? across * (picture.width / Math.max(1, picture.height))
    : Math.max(1, dab.r * 2);
  let tip;
  if (picture) {
    // The picture at the size of the dab: made small once and kept, so a
    // dense brush puts down small pictures instead of scaling its big one
    // for every dab.
    tip = scaledTip(picture, along, across);
  } else if (tipShape && tipShape !== "circle") {
    tip = shapedDab(color, Math.max(2, Math.round(along)), tipShape, style.hardness, style.binarize, dab.flat);
  } else {
    tip = roundDab(color, Math.max(2, Math.round(along)), style.hardness, style.binarize);
  }

  ctx.globalAlpha = style.accumulates ? Math.max(0, Math.min(1, dab.flow)) : 1;
  ctx.save();
  ctx.translate(dab.x, dab.y);
  if (dab.angle) ctx.rotate(dab.angle);
  ctx.drawImage(tip, -along / 2, -across / 2, along, across);
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** The dabs of a round brush, in the colours and shapes they were used in. */
const roundDabs = new Map();

/**
 * One dab of a round brush.
 *
 * The tip is a disc whose edge is as hard as the brush says: a hard brush
 * stops at its edge, a soft one fades out from its middle.
 */
function roundDab(color, diameter, hardness = 1, binarize = false) {
  const hard = Math.max(0, Math.min(1, Number(hardness)));
  const key = `${color}|${diameter}|${Math.round(hard * 100)}|${binarize ? 1 : 0}`;
  if (roundDabs.has(key)) return roundDabs.get(key);
  const surface = document.createElement("canvas");
  surface.width = Math.max(2, diameter);
  surface.height = Math.max(2, diameter);
  const context = surface.getContext("2d");
  const centre = surface.width / 2;
  const radius = Math.max(0.5, centre);
  if (hard >= 0.999) {
    context.beginPath();
    context.arc(centre, centre, Math.max(0.5, radius - 0.5), 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  } else {
    // The middle of the tip keeps its paint out to `hardness`, then the
    // paint fades out to the edge of the tip.
    const fade = context.createRadialGradient(centre, centre, 0, centre, centre, radius);
    const solid = Math.max(0, Math.min(1, hard));
    fade.addColorStop(0, colorWithAlpha(color, 1));
    fade.addColorStop(solid, colorWithAlpha(color, 1));
    fade.addColorStop(1, colorWithAlpha(color, 0));
    context.fillStyle = fade;
    context.fillRect(0, 0, surface.width, surface.height);
  }
  if (binarize) binarizeSurface(surface);
  if (roundDabs.size > 24) roundDabs.clear();
  roundDabs.set(key, surface);
  return surface;
}

/**
 * The holes of the paper, in the plane of its alpha.
 *
 * The picture of a grain is ink: a pixel that is see-through is a hole. The
 * canvas takes the ink of a stroke away by its alpha, so the picture is turned
 * over once: a hole becomes see-through ink, and a painted pixel becomes a
 * hole that takes nothing away. The turn, the size and the strength are
 * applied when the picture is put over the stroke.
 */
const shapedDabs = new Map();

function shapedDab(color, diameter, shape, hardness = 1, binarize = false, flat = 1) {
  const hard = Math.max(0, Math.min(1, Number(hardness)));
  const key = `${color}|${diameter}|${shape}|${Math.round(hard * 100)}|${binarize ? 1 : 0}|${Math.round(flat * 100)}`;
  if (shapedDabs.has(key)) return shapedDabs.get(key);
  const surface = document.createElement("canvas");
  const size = Math.max(2, diameter);
  surface.width = size;
  surface.height = Math.max(2, Math.round(size * Math.max(0.25, flat)));
  const context = surface.getContext("2d");
  context.fillStyle = color;
  drawBrushTipShape(context, surface.width / 2, surface.height / 2, Math.min(surface.width, surface.height), shape, 0);
  if (binarize) binarizeSurface(surface);
  if (shapedDabs.size > 24) shapedDabs.clear();
  shapedDabs.set(key, surface);
  return surface;
}

const grainHoles = new Map();

function grainHolesFor(grain) {
  const key = grain.data;
  if (grainHoles.has(key)) return grainHoles.get(key);
  const entry = { ready: false, surface: null };
  grainHoles.set(key, entry);
  const image = new Image();
  image.onload = () => {
    try {
      const surface = document.createElement("canvas");
      surface.width = image.naturalWidth;
      surface.height = image.naturalHeight;
      const context = surface.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, surface.width, surface.height);
      const data = pixels.data;
      for (let at = 0; at < data.length; at += 4) {
        const ink = data[at + 3];
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
        data[at + 3] = grain.reverse === true ? ink : 255 - ink;
      }
      context.putImageData(pixels, 0, 0);
      entry.surface = surface;
      entry.ready = true;
      renderCanvas();
    } catch {
      entry.ready = false;
    }
  };
  image.src = `data:image/png;base64,${key}`;
  return entry;
}

/** Take the grain of the paper out of a stroke that is in a scratch canvas. */
function applyGrainToCanvas(context, box, grain, origin = { x: 0, y: 0 }, pixelScale = 1) {
  const entry = grainHolesFor(grain);
  if (!entry.ready || !entry.surface) return;
  const pattern = context.createPattern(entry.surface, "repeat");
  if (!pattern) return;
  const scale = Math.max(0.05, Math.min(10, (Number(grain.scale) || 100) / 100));
  if (pattern.setTransform && typeof DOMMatrix !== "undefined") {
    pattern.setTransform(
      new DOMMatrix()
        .translate(origin.x, origin.y)
        .scale(scale * pixelScale)
        .rotate(-(Number(grain.rotate) || 0)),
    );
  }
  context.save();
  context.globalCompositeOperation = "destination-out";
  // The strength of the grain: a grain of 0 takes nothing away at all.
  context.globalAlpha = Math.max(0, Math.min(1, Number(grain.density ?? 100) / 100));
  context.fillStyle = pattern;
  context.fillRect(box.x, box.y, box.w, box.h);
  context.restore();
}

/**
 * Take the soft edge of a dab away.
 *
 * Binarize is the hard edge of Clip Studio Paint and MoArt: every pixel of the
 * tip is either paint or paper, with no fade in between, so the picture is
 * read once and every half-covered pixel is made whole or dropped.
 */
function binarizeSurface(surface) {
  const context = surface.getContext("2d");
  const image = context.getImageData(0, 0, surface.width, surface.height);
  const data = image.data;
  for (let at = 3; at < data.length; at += 4) {
    data[at] = data[at] >= 128 ? 255 : 0;
  }
  context.putImageData(image, 0, 0);
  return surface;
}

/** The colour of a stroke with a strength, as `#rrggbbaa`. */
function colorWithAlpha(color, alpha) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#000000";
  return `${hex}${Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** Bucket fill: flood the paint canvas from the seed with the stroke colour. */
function floodFillCanvas(ctx, canvasWidth, canvasHeight, stroke) {
  const rgb = parseHexColor(stroke.color);
  if (!rgb) return;
  const image = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  // The seed is in the pixels of the document, and the context may be
  // scaled to the pixels of the screen.
  const matrix = ctx.getTransform();
  // A fill that was made while a selection was up carries the runs of that
  // selection, so the paint is kept to the part of the canvas that was
  // allowed, exactly as a stroke that was cut is kept to its piece.
  const effective = clipMaskFromSpans(stroke.clip, canvasWidth, canvasHeight, matrix.a);
  if (stroke.gap > 0) {
    floodFillWithGaps(
      image.data,
      canvasWidth,
      canvasHeight,
      stroke.points[0][0] * matrix.a,
      stroke.points[0][1] * matrix.d,
      [rgb[0], rgb[1], rgb[2]],
      stroke.gap,
      undefined,
      effective,
    );
  } else {
    floodFillRgba(
      image.data,
      canvasWidth,
      canvasHeight,
      stroke.points[0][0] * matrix.a,
      stroke.points[0][1] * matrix.d,
      rgb,
      undefined,
      undefined,
      effective,
    );
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * The way the paint of a stroke goes down, read from its brush.
 *
 * A brush says how much paint one dab leaves (its flow), how hard the edge of
 * its tip is (its hardness), how flat the tip is (its thickness), how far
 * apart the dabs are (its spacing), how its tip turns and what the grain of
 * the paper takes away. All of that is read once per stroke, in
 * `brush-dynamics.js`, and both painters use the same reading.
 */
function strokeStyleOf(brush) {
  const style = brush ? dynamicsOf(brush) : dynamicsOf(null);
  // A brush from Clip Studio Paint that carries no pressure curve of its
  // own draws with a constant width: the ends taper the way Umoupen's
  // vector engine tapers the strokes of such brushes.
  if (brush && brushFromSut(brush) && !style.effectors.size) style.taperEnds = true;
  return style;
}

/**
 * Paint one stroke (shape or freehand) directly into a 2D context.
 *
 * `brush` is the brush the stroke was made with. A brush that has a picture
 * paints that picture along the stroke instead of a plain line.
 *
 * `asMask` paints the shape of the stroke even when it is an eraser: a stroke
 * that is painted into a mask of its own first is taken out of the drawing
 * afterwards, with the strength of the stroke.
 */
function drawStrokeDirect(ctx, stroke, canvasWidth, canvasHeight, brush = null, asMask = false) {
  const style = strokeStyleOf(brush);
  const eraser = !asMask && stroke.eraser === true;
  // A stroke that is drawn on paper goes through a scratch of its own, so the
  // grain is taken out of the whole stroke in one place. The dabs of a stroke
  // must not each be eaten by the paper on their own, or the overlaps would
  // keep their ink and the grain would disappear.
  if (style.grain?.data) {
    drawStrokeOnPaper(ctx, stroke, canvasWidth, canvasHeight, brush, style, eraser);
    return;
  }
  ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
  paintStrokeShape(ctx, stroke, brush, style);
  ctx.globalCompositeOperation = "source-over";
}

/**
 * The box a stroke covers: its points, with the reach of the brush and the
 * slack of its tip around them. The box is not held inside anything - the
 * caller does that, because the pasteboard around the canvas carries ink at
 * coordinates below zero.
 */
function strokeExtent(stroke) {
  if (!stroke) return null;
  const runs = stroke.kind === "paths" ? (stroke.paths ?? []) : [stroke.points];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const run of runs) {
    for (const point of run ?? []) {
      const x = point[0];
      const y = point[1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const reach = (Number(stroke.width) || 1) * 2 + 16;
  minX -= reach;
  minY -= reach;
  maxX += reach;
  maxY += reach;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The box that covers both of two boxes. An empty box stands aside: it
    would otherwise pin the union to the corner of the buffer. */
function unionBox(a, b) {
  if (!a || a.w === 0 || a.h === 0) return { ...b };
  if (!b || b.w === 0 || b.h === 0) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Where two boxes overlap, or null when they do not. */
function intersectBoxes(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Paint a stroke into a scratch canvas, then take the paper's grain out.
 *
 * The scratch is moved by the pad of the sheet, so its room covers the
 * pasteboard around the canvas as well, and it is only ever worked on
 * inside the box the stroke covers - the grain pass and the copy of a
 * whole buffer were the better part of a second of every move of the
 * pointer.
 */
const grainScratch = { canvas: null, stroke: null, box: { x: 0, y: 0, w: 0, h: 0 } };

function drawStrokeOnPaper(ctx, stroke, canvasWidth, canvasHeight, brush, style, eraser) {
  const pad = stagePadding(canvasWidth, canvasHeight);
  if (grainCanvas.width !== canvasWidth || grainCanvas.height !== canvasHeight) {
    grainCanvas.width = canvasWidth;
    grainCanvas.height = canvasHeight;
    grainScratch.stroke = null;
    grainScratch.box = { x: 0, y: 0, w: 0, h: 0 };
  }
  // All the clearing of the scratch happens without a transform, in the
  // coordinates of the scratch itself.
  grainCtx.setTransform(1, 0, 0, 1, 0, 0);
  if (grainScratch.stroke !== stroke) {
    // A stroke that is not the one in the scratch was there before: its room
    // is taken out, and the box starts from this stroke's own ink.
    if (grainScratch.stroke) {
      grainCtx.clearRect(grainScratch.box.x, grainScratch.box.y, grainScratch.box.w, grainScratch.box.h);
    }
    grainScratch.stroke = stroke;
    grainScratch.box = { x: 0, y: 0, w: 0, h: 0 };
  }
  const extent = strokeExtent(stroke);
  if (!extent) return;
  // The room the scratch has, in the coordinates the strokes are drawn in.
  const cover = { x: -pad.x, y: -pad.y, w: canvasWidth, h: canvasHeight };
  const box = intersectBoxes(extent, cover);
  if (!box) return;
  const dirty = unionBox(grainScratch.box, {
    x: box.x + pad.x,
    y: box.y + pad.y,
    w: box.w,
    h: box.h,
  });
  grainCtx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
  // The stroke is painted with the brush it has, but without the grain: the
  // grain belongs to the paper under the whole stroke, not to one dab.
  const plain = { ...(brush ?? {}), grain: null };
  grainCtx.setTransform(1, 0, 0, 1, pad.x, pad.y);
  drawStrokeDirect(grainCtx, { ...stroke, eraser: false }, canvasWidth, canvasHeight, plain, true);
  applyGrainToCanvas(grainCtx, box, style.grain);
  ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
  ctx.drawImage(
    grainCanvas,
    dirty.x,
    dirty.y,
    dirty.w,
    dirty.h,
    dirty.x - pad.x,
    dirty.y - pad.y,
    dirty.w,
    dirty.h,
  );
  ctx.globalCompositeOperation = "source-over";
  grainScratch.box = dirty;
  return grownX > 0 || grownY > 0;
}

/** Paint the shape of a stroke, in the colour of the stroke and at full strength. */
/* The half-edge shape of a stroke, kept beside the stroke so the contour that
 * is painted is the contour the model holds. A WeakMap keeps the shape out of
 * the document, so saving and loading are unaffected. */
const strokeShapeCache = new WeakMap();

function shapeForStroke(stroke) {
  if (!stroke || stroke.kind || stroke.eraser) return null;
  // The stroke in the hand is still growing: its shape would be rebuilt on
  // every move of the pointer, which is the lag a long stroke feels. The
  // half-edge model is only worth building once the stroke is finished, so
  // the live stroke is painted from its outline instead.
  if (stroke === state.drawing) return null;
  if (strokeShapeCache.has(stroke)) return strokeShapeCache.get(stroke);
  let shape = null;
  try {
    shape = shapeModel.shapeForStroke(stroke);
  } catch (error) {
    console.error("shapeForStroke failed", error);
  }
  strokeShapeCache.set(stroke, shape);
  return shape;
}

/** Paint a closed path as one filled region. */
function paintFilledPath(ctx, stroke) {
  const points = stroke.points;
  if (!points || points.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.closePath();
  ctx.fill();
}

/** Fill every subpath of a multi-path stroke; the canvas combines their
 * winding (nonzero rule), so an inner contour carves a hole. */
function paintFilledPaths(ctx, stroke) {
  const paths = stroke.paths;
  if (!paths || paths.length === 0) return;
  ctx.beginPath();
  for (const points of paths) {
    if (!points || points.length < 2) continue;
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
  }
  ctx.fill();
}

function paintStrokeShape(ctx, stroke, brush, style) {
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  // A closed filled contour (the ink of a brush in a legacy .fla, or a filled
  // shape) is painted as the region it outlines, not as a line around it.
  if (stroke.kind === "path") {
    paintFilledPath(ctx, stroke);
    return;
  }

  // A filled region of several subpaths (a legacy .fla fill style): every
  // subpath contributes to the same winding number.
  if (stroke.kind === "paths") {
    paintFilledPaths(ctx, stroke);
    return;
  }

  // A hard stroke, the way the pencil of Flash draws it: the ends are cut
  // square and the corners are sharp. Every other stroke is round.
  ctx.lineCap = stroke.hard ? "butt" : "round";
  ctx.lineJoin = stroke.hard ? "miter" : "round";
  const radii = strokeRadii(stroke);

  // A brush that has a picture, or that says anything about how its paint goes
  // down, is painted one dab at a time. A plain hard round brush is painted as
  // one shape, which is quicker and has one clean edge.
  if (brush?.data || style.needsDabs || (stroke.tip && stroke.tip !== "circle")) {
    const shape = brush?.data
      ? tintedTip(brush, stroke.color, style.binarize)
      : null;
    if (!brush?.data || shape) {
      const outline =
        stroke.kind === "ellipse"
          ? sampleEllipse(
              stroke.points[0][0],
              stroke.points[0][1],
              stroke.points[1][0],
              stroke.points[1][1],
            )
          : null;
      if (stroke.kind !== "ellipse" || outline) {
        drawStrokeWithDabs(ctx, stroke, style, shape, outline);
        return;
      }
    }
  }

  if (stroke.kind === "line") {
    const [x0, y0] = stroke.points[0];
    const [x1, y1] = stroke.points[1];
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    if (Math.hypot(x1 - x0, y1 - y0) < 0.25) {
      ctx.arc(x0, y0, radii[0], 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  if (stroke.kind === "rect") {
    const [x0, y0] = stroke.points[0];
    const [x1, y1] = stroke.points[1];
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  if (stroke.kind === "ellipse") {
    const [x0, y0] = stroke.points[0];
    const [x1, y1] = stroke.points[1];
    const radiusX = Math.abs(x1 - x0) / 2;
    const radiusY = Math.abs(y1 - y0) / 2;
    if (radiusX < 0.25 || radiusY < 0.25) {
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.ellipse(
      Math.min(x0, x1) + radiusX,
      Math.min(y0, y1) + radiusY,
      radiusX,
      radiusY,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  // A hard round brush is painted as one shape, which is quicker and has one
  // clean edge.

  if (stroke.points.length === 1) {
    ctx.beginPath();
    ctx.arc(stroke.points[0][0], stroke.points[0][1], radii[0], 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  const tapered = stroke.points.some((point) => point.length === 3);
  if (!tapered) {
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let i = 1; i < stroke.points.length; i += 1) {
      ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    return;
  }

  // A pressure stroke is one shape: the left side of the line and the
  // right side of it, filled together. The width then changes the way the
  // width of a pen changes, instead of in steps, and the edge of the line
  // is one clean edge. The shape of the stroke is held by the half-edge
  // model, so the contour that is painted is the contour that is stored.
  const shape = shapeForStroke(stroke);
  let ribbon = null;
  try {
    ribbon = shape ? shapeModel.ribbonFromShape(shape) : null;
  } catch (error) {
    console.error("ribbonFromShape failed", error);
    ribbon = null;
  }
  const { left, right } = ribbon && ribbon.left?.length ? ribbon : strokeOutline(stroke.points, radii);
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (const point of left.slice(1)) ctx.lineTo(point[0], point[1]);
  for (const point of right.reverse()) ctx.lineTo(point[0], point[1]);
  ctx.closePath();
  ctx.fill();
  // The ends of the line are round, the way the end of a pen stroke is.
  for (const index of [0, stroke.points.length - 1]) {
    ctx.beginPath();
    ctx.arc(
      stroke.points[index][0],
      stroke.points[index][1],
      radii[index],
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawStrokesToPaint(strokes) {
  drawStrokesInto(paintCtx, strokes);
}

/**
 * The size a cell's raster base is painted at, in document pixels: the pixels
 * the picture was imported at. It is never stretched to the sheet — the sheet
 * also holds the pasteboard around the stage, and filling that would blow the
 * picture up past the size it has in Flash.
 */
function cellBaseSize(project, drawing) {
  return [drawing.image?.width || project.width, drawing.image?.height || project.height];
}

/**
 * Where the raster base of a drawing sits on the canvas. A picture trimmed
 * to the box it paints carries the place of that box; a full-canvas picture
 * sits at the origin.
 */
function cellBaseOrigin(drawing) {
  return [drawing.image?.x ?? 0, drawing.image?.y ?? 0];
}

/** Paint one drawing (raster base + strokes) into a scratch canvas. */

/* The finished picture of a drawing. Building a layer from its strokes is
   the dearest work of the stage: every dab of every brush is put down again
   each time the sheet is drawn, so a document with many layers is built for
   seconds on every stroke and every zoom. The picture of each drawing is
   therefore kept in a canvas of its own, in the pixels of the document, and
   the stage puts the finished pictures on the buffer. A drawing that did not
   change keeps its picture; the stroke that was let go is put on the
   picture of its own cell alone. */

const cellPaintCache = new Map();
const CELL_PAINT_BUDGET = 320 * 1024 * 1024;
let cellPaintBytes = 0;

/** What a drawing's picture is made of: the strokes that are on it (the one
    in the hand is left out, the living ink shows it), the raster base and
    the brush the strokes are drawn with. */
function cellPaintKeyOf(drawing, base) {
  const inHand = state.drawing;
  let count = 0;
  let first = null;
  let last = null;
  for (const stroke of drawing.strokes) {
    if (stroke === inHand) continue;
    if (!first) first = stroke;
    last = stroke;
    count += 1;
  }
  return { count, first, last, image: drawing.image || null, base: base || null, brush: drawing.brush || null };
}

function cellPaintKeySame(a, b) {
  return (
    a.count === b.count &&
    a.first === b.first &&
    a.last === b.last &&
    a.image === b.image &&
    a.base === b.base &&
    a.brush === b.brush
  );
}

function trimCellPaintCache() {
  while (cellPaintBytes > CELL_PAINT_BUDGET && cellPaintCache.size > 1) {
    const oldest = cellPaintCache.keys().next().value;
    const entry = cellPaintCache.get(oldest);
    cellPaintCache.delete(oldest);
    if (entry) cellPaintBytes -= entry.bytes;
  }
}

/**
 * The finished picture of a drawing, in the pixels of the document.
 *
 * The picture is built again only when the strokes, the base or the brush
 * of the drawing have changed; otherwise the canvas that was built before
 * is handed back as it is. Returns null when the picture cannot be kept
 * (a canvas of the document's size cannot be made).
 */
function cellPaintOf(drawing, project) {
  if (!drawing || !project) return null;
  let entry = cellPaintCache.get(drawing);
  if (!entry) {
    const canvas = document.createElement("canvas");
    try {
      canvas.width = project.width;
      canvas.height = project.height;
    } catch {
      return null; // the room for the picture cannot be had
    }
    entry = {
      canvas,
      ctx: canvas.getContext("2d"),
      key: null,
      bytes: project.width * project.height * 4,
    };
    cellPaintCache.set(drawing, entry);
    cellPaintBytes += entry.bytes;
  } else {
    // The newest picture stands last, so the eviction takes the oldest.
    cellPaintCache.delete(drawing);
    cellPaintCache.set(drawing, entry);
  }
  const base = drawingImageElement(drawing);
  const key = cellPaintKeyOf(drawing, base);
  if (entry.key && cellPaintKeySame(entry.key, key)) {
    trimCellPaintCache();
    return entry;
  }
  const { ctx, canvas } = entry;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (base) ctx.drawImage(base, ...cellBaseOrigin(drawing), ...cellBaseSize(project, drawing));
  drawStrokesInto(
    ctx,
    state.drawing ? drawing.strokes.filter((stroke) => stroke !== state.drawing) : drawing.strokes,
    drawing.brush,
  );
  entry.key = key;
  trimCellPaintCache();
  return entry;
}

/** The stroke is out of the hand: it goes onto the picture of its own cell
    alone, so the cell is not built from the beginning for every stroke. */
function appendStrokeToCellPaint(drawing, stroke) {
  const entry = cellPaintCache.get(drawing);
  if (!entry || !entry.key) return;
  const base = drawingImageElement(drawing);
  const key = cellPaintKeyOf(drawing, base);
  if (cellPaintKeySame(entry.key, key)) return; // the picture is up to date
  drawStrokesInto(entry.ctx, [stroke], drawing.brush);
  entry.key = key;
}

function drawDrawingToPaint(project, drawing, alpha = 1, target = paintCtx, targetCanvas = paintCanvas) {
  // The scratch may be larger than the canvas (the sheet holds the
  // pasteboard too), so all of it is cleared, not just the canvas part.
  target.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  target.globalAlpha = alpha;
  const painted = cellPaintOf(drawing, project);
  if (painted) {
    target.drawImage(painted.canvas, 0, 0);
    // The stroke in the hand is left out of the finished picture; while it
    // erases, the hand must see the ink go away as it moves, so the stroke
    // is put on the scratch as well.
    if (state.drawing && drawing.strokes.includes(state.drawing)) {
      drawStrokesInto(target, [state.drawing], drawing.brush);
    }
  } else {
    const base = drawingImageElement(drawing);
    if (base) target.drawImage(base, ...cellBaseOrigin(drawing), ...cellBaseSize(project, drawing));
    drawStrokesInto(target, drawing.strokes, drawing.brush);
  }
  target.globalAlpha = 1;
  return targetCanvas;
}

/** Make a scratch canvas the size of the canvas. */
function fitScratch(scratch, scratchCtx, width, height) {
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  scratchCtx.clearRect(0, 0, width, height);
  return scratch;
}

const ONION_TINT = { before: "#e5484d", after: "#2da44e" };
const ONION_BASE_ALPHA = 0.45;

function drawOnionSkins(project, layer, frame) {
  const { width, height } = project;
  const targets = onionTargets(layer, frame, state.onion);
  // Furthest first, so the nearest ghost ends up on top.
  for (const target of [...targets].reverse()) {
    drawDrawingToPaint(project, target.drawing);

    // Tint only the pixels that were drawn.
    paintCtx.globalCompositeOperation = "source-atop";
    paintCtx.fillStyle = ONION_TINT[target.side];
    paintCtx.fillRect(0, 0, width, height);
    paintCtx.globalCompositeOperation = "source-over";

    ctx.globalAlpha = layer.opacity * ONION_BASE_ALPHA * target.weight;
    ctx.drawImage(paintCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
}

/**
 * The size of the sheet: the canvas plus a wide strip of pasteboard around
 * it, the way Flash keeps a large work area around the stage. A stroke may
 * be drawn anywhere on the sheet, and when a stroke reaches past the sheet
 * the sheet grows around the canvas to hold it, so the room to draw in is
 * for all intents without an end.
 *
 * The room is held back by a budget of pixels: the scratch canvases that
 * put a layer together are the size of the sheet, so the sheet of a big
 * canvas carries a smaller strip than the sheet of a small one. A document
 * that was imported keeps the size of its source instead: its sheet is the
 * canvas, so the stage shows exactly the resolution the file was made in
 * and a write-back of it matches what is on screen.
 */
const PASTEBOARD_FRACTION = 1.0;

/** How far drawing outward may grow the sheet, past the room it starts with. */
const PASTEBOARD_GROWN_FRACTION = 2.0;

/** The most pixels the sheet may take: three scratch canvases are built at
    the size of the sheet, so this is what keeps their memory in hand. */
const PASTEBOARD_PIXEL_BUDGET = 24_000_000;

/**
 * The share of the canvas a side of the sheet may carry: the share that is
 * asked for, held inside the pixel budget and never smaller than a quarter,
 * which is the room every document has always had.
 */
function sheetPadFractionFor(project, desiredFraction) {
  const byBudget =
    (Math.sqrt(PASTEBOARD_PIXEL_BUDGET / (project.width * project.height)) - 1) / 2;
  return Math.max(0.25, Math.min(desiredFraction, byBudget));
}

/** How much pasteboard each side of the sheet carries: the share every
    project starts with, and the room that was grown for the strokes that
    were drawn past it. */
function pasteboardPadOf(project) {
  return {
    x: Math.round(project.width * sheetPadFractionFor(project, PASTEBOARD_FRACTION)),
    y: Math.round(project.height * sheetPadFractionFor(project, PASTEBOARD_FRACTION)),
  };
}

function documentSize(project) {
  if (project.pasteboard === false) {
    return { width: project.width, height: project.height };
  }
  const base = pasteboardPadOf(project);
  const stored = project.pasteboardPad;
  return {
    width: project.width + (base.x + Math.max(0, Math.round(stored?.x ?? 0))) * 2,
    height: project.height + (base.y + Math.max(0, Math.round(stored?.y ?? 0))) * 2,
  };
}

/**
 * How far the canvas sits inside the sheet: half of what the sheet gained on
 * each side, so the middle of the sheet is the middle of the canvas.
 */
function stagePadding(docWidth, docHeight) {
  const project = state.project;
  if (!project) return { x: 0, y: 0 };
  return {
    x: Math.max(0, (docWidth - project.width) / 2),
    y: Math.max(0, (docHeight - project.height) / 2),
  };
}

/**
 * Grow the sheet around the canvas to hold a stroke that reached past it.
 *
 * The room to draw in is without an end in the way Flash's work area is: a
 * stroke that runs past the edge of the sheet grows the sheet by a canvas
 * and a half past the ink, so the next stroke can be started still further
 * out. The sheet grows around the canvas, so the canvas stays where it is
 * in the sheet, and the view is moved by the growth, so the drawing stays
 * where it is on the screen.
 *
 * @returns {boolean} whether the sheet grew.
 */
function growSheetForStroke(stroke) {
  const project = state.project;
  if (!project || project.pasteboard === false) return false;
  const base = pasteboardPadOf(project);
  const stored = project.pasteboardPad ?? { x: 0, y: 0 };
  const currentX = base.x + Math.max(0, Math.round(stored.x ?? 0));
  const currentY = base.y + Math.max(0, Math.round(stored.y ?? 0));

  // The reach of the stroke: its points, half the brush wide besides.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of stroke?.points ?? []) {
    const x = point[0];
    const y = point[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return false;
  const reach = Math.max(4, (Number(widthInput.value) || 1) / 2);
  minX -= reach;
  minY -= reach;
  maxX += reach;
  maxY += reach;

  // Room to keep drawing outward: a whole strip of the starting sheet past
  // the ink, so drawing outward does not grow the sheet on every stroke.
  const wantedX = Math.max(
    currentX,
    Math.round(-minX + base.x),
    Math.round(maxX - project.width + base.x),
  );
  const wantedY = Math.max(
    currentY,
    Math.round(-minY + base.y),
    Math.round(maxY - project.height + base.y),
  );
  const capX = Math.round(project.width * sheetPadFractionFor(project, PASTEBOARD_GROWN_FRACTION));
  const capY = Math.round(project.height * sheetPadFractionFor(project, PASTEBOARD_GROWN_FRACTION));
  const nextX = Math.min(capX, wantedX);
  const nextY = Math.min(capY, wantedY);
  if (nextX <= currentX && nextY <= currentY) return false;

  project.pasteboardPad = {
    x: Math.max(0, nextX - base.x),
    y: Math.max(0, nextY - base.y),
  };

  // The canvas sits deeper in the grown sheet, so the view follows the
  // growth and the ink stays where it was put.
  const zoom = viewZoom || 1;
  const grownX = nextX - currentX;
  const grownY = nextY - currentY;
  applyView();
  if (grownX > 0 || grownY > 0) {
    canvasScroll.scrollLeft += grownX * zoom;
    canvasScroll.scrollTop += grownY * zoom;
    expectedScrollLeft = canvasScroll.scrollLeft;
    expectedScrollTop = canvasScroll.scrollTop;
  }
  return true;
}

function renderCanvas(frame = state.project.currentFrame) {
  const project = state.project;
  const { width, height } = project;
  const camera = cameraAt(project.camera, frame);
  // The stage shows the shot the camera takes; switching the camera view off
  // shows the whole canvas with the camera frame drawn on it instead.
  const view = currentCameraView();

  // The stage shows the whole document, including strokes that sit outside
  // the project canvas (the Flash pasteboard). The render bounds are the
  // project size extended to cover every stroke, so nothing drawn off-stage
  // is clipped away.
  const doc = documentSize(project);
  const docWidth = doc.width;
  const docHeight = doc.height;
  // The sheet is larger than the canvas when strokes reach onto the
  // pasteboard; it starts that much before the canvas does.
  const pad = stagePadding(docWidth, docHeight);

  // The document is drawn in its own pixels; the buffer is the size of the
  // screen, so the context is scaled to the document.
  useDocumentSpace(docWidth, docHeight);

  if (view) {
    // The area outside the camera window is the letterbox.
    ctx.fillStyle = CAMERA_BACKDROP;
    ctx.fillRect(-pad.x, -pad.y, docWidth, docHeight);
  }
  // The camera window is cut out of the drawing, so only the shot is shown.
  useStageSpace(docWidth, docHeight);

  ctx.fillStyle = PASTEBOARD;
  ctx.fillRect(-pad.x, -pad.y, docWidth, docHeight);

  // The stage itself: the paper of the document, in its own colour.
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, project.width, project.height);

  const image = projectImage();
  if (image) ctx.drawImage(image, 0, 0, project.width, project.height);

  if (paintCanvas.width !== docWidth || paintCanvas.height !== docHeight) {
    paintCanvas.width = docWidth;
    paintCanvas.height = docHeight;
  }

  // Layers are stored top-to-bottom, so paint them in reverse order. A
  // folder is not painted itself; the layers inside it are.
  for (let index = project.layers.length - 1; index >= 0; index -= 1) {
    const layer = project.layers[index];
    if (isGroup(layer)) continue;
    if (!layerIsVisible(project, index)) continue;
    const opacity = effectiveOpacity(project, index);
    if (opacity <= 0) continue;

    // Onion skins sit just under the current layer's own drawing and are
    // hidden during playback so they never flicker.
    if (state.onion.enabled && !state.playing && index === project.currentLayer) {
      drawOnionSkins(project, layer, frame);
    }

    const resolved = resolveDrawing(layer, frame);
    if (!resolved) continue;

    // A cell may sit somewhere else than it was drawn: moved, made bigger or
    // smaller, and turned. The picture of the cell is put on the stage with
    // it, so that the cell is where it says it is. A layer may have a
    // transform of its own as well, and it comes first. A cell that tweens
    // is where its walk along the span of the cell is at this frame.
    const transform = transformAt(resolved.drawing, resolved.sourceFrame);
    const layerTransform = transformOf(layer);

    // A clipped layer is cut by the picture of the layer below it.
    if (layer.clip) {
      const source = clipSourceOf(project, index);
      const sourceResolved = source >= 0 ? resolveDrawing(project.layers[source], frame) : null;
      if (sourceResolved) {
        const sourceTransform = transformAt(sourceResolved.drawing, sourceResolved.sourceFrame);
        drawDrawingToPaint(project, resolved.drawing, 1, paintCtx, paintCanvas);
        const sourceOpacity = effectiveOpacity(project, source);
        drawDrawingToPaint(project, sourceResolved.drawing, sourceOpacity, maskCtx, maskCanvas);
        fitScratch(clipCanvas, clipCtx, docWidth, docHeight);
        clipCtx.globalCompositeOperation = "source-over";
        withCellTransform(clipCtx, [transformOf(project.layers[source]), sourceTransform], docWidth, docHeight, () => {
          clipCtx.drawImage(maskCanvas, 0, 0);
        });
        clipCtx.globalCompositeOperation = "destination-in";
        withCellTransform(clipCtx, [layerTransform, transform], docWidth, docHeight, () => {
          clipCtx.drawImage(paintCanvas, 0, 0);
        });
        clipCtx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = opacity;
        ctx.drawImage(clipCanvas, 0, 0);
        ctx.globalAlpha = 1;
        continue;
      }
    }

    // A layer that is only a picture does not have to be drawn into a
    // scratch canvas and copied from there: the picture can go onto the
    // canvas as it is. On a big canvas that saves two passes over every
    // pixel, and a document that is opened rather than drawn is mostly
    // layers like this.
    const base = drawingImageElement(resolved.drawing);
    // The stroke that is in the hand is drawn on the sheet on top of the
    // stage, so it is left out here: it would otherwise be painted twice.
    // An eraser is the exception: a sheet on top of the stage cannot take
    // ink away from the document below it, so the eraser is drawn here and
    // the paper is erased while the eraser moves.
    const inHand = state.drawing;
    const strokes =
      inHand && !inHand.eraser
        ? resolved.drawing.strokes.filter((stroke) => stroke !== inHand)
        : resolved.drawing.strokes;
    if (base && !strokes.length) {
      ctx.globalAlpha = opacity;
      withCellTransform(ctx, [layerTransform, transform], docWidth, docHeight, () => {
        ctx.drawImage(base, ...cellBaseOrigin(resolved.drawing), ...cellBaseSize(project, resolved.drawing));
      });
      ctx.globalAlpha = 1;
      continue;
    }

    // The same goes for a layer with strokes on it, as long as it is drawn
    // at full strength: the picture and the strokes can go onto the canvas
    // as they are, without the round trip through a scratch canvas. The
    // strokes are then drawn in the pixels of the screen, so a line that is
    // magnified stays sharp; through a scratch canvas they would be drawn
    // in the pixels of the document and then made bigger, and a magnified
    // line would be soft. An eraser is the exception: it has to take ink
    // away from its own layer only, and that is the work of the scratch
    // canvas.
    if (opacity === 1 && !strokes.some((stroke) => stroke.eraser)) {
      withCellTransform(ctx, [layerTransform, transform], docWidth, docHeight, () => {
        // The finished picture of the cell is put on the buffer as it is,
        // while the zoom is small enough for the picture's own pixels to
        // hold the line. Deep in the zoom the strokes are drawn in the
        // pixels of the screen, so a magnified line stays sharp.
        const painted = viewZoom <= 2 ? cellPaintOf(resolved.drawing, project) : null;
        if (painted) {
          ctx.drawImage(painted.canvas, 0, 0, project.width, project.height);
        } else {
          if (base) ctx.drawImage(base, 0, 0, ...cellBaseSize(project, resolved.drawing));
          drawStrokesInto(ctx, strokes, resolved.drawing.brush);
        }
      });
      continue;
    }

    // The layer is drawn through the scratch canvas, in the pixels of the
    // screen, so that a magnified line is sharp there as well.
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    fitScratch(layerCanvas, layerCtx, canvas.width, canvas.height);
    useDocumentSpace(docWidth, docHeight, layerCtx);
    drawDrawingToPaint(project, resolved.drawing, 1, layerCtx, layerCanvas);
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.globalAlpha = opacity;
    withCellTransform(ctx, [layerTransform, transform], docWidth, docHeight, () => {
      ctx.drawImage(layerCanvas, 0, 0);
    });
    ctx.globalAlpha = 1;
  }

  drawOverlay();

  // Back into the pixels of the document, so the marks drawn after this (the
  // camera frame) land on the canvas.
  useDocumentSpace(docWidth, docHeight);
  if (view) ctx.restore();

  // With the camera view off, mark the shot on the canvas.
  if (camera && !view) drawCameraOverlay(camera, frame);
}

/**
 * Draw the camera over the canvas: the frame with its corner marks, the
 * path it travels along and a dot for every keyframe.
 */
function drawCameraOverlay(camera, frame) {
  const project = state.project;
  const keys = project.camera?.keys ?? [];
  const live = state.cameraLive ?? camera;

  ctx.save();

  // Everything outside the frame is dimmed, so the shot stands out.
  ctx.fillStyle = "rgba(6, 10, 16, 0.55)";
  ctx.beginPath();
  ctx.rect(0, 0, project.width, project.height);
  ctx.rect(live.x, live.y, live.width, live.height);
  ctx.fill("evenodd");

  // The path between the keys.
  if (keys.length > 1) {
    ctx.strokeStyle = "rgba(63, 163, 236, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    keys.forEach((key, index) => {
      const centreX = key.x + key.width / 2;
      const centreY = key.y + key.height / 2;
      if (index === 0) ctx.moveTo(centreX, centreY);
      else ctx.lineTo(centreX, centreY);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // A dot on every key.
    for (const key of keys) {
      const centreX = key.x + key.width / 2;
      const centreY = key.y + key.height / 2;
      const onFrame = key.frame === frame;
      ctx.beginPath();
      ctx.arc(centreX, centreY, onFrame ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = onFrame ? "#3fa3ec" : "rgba(63, 163, 236, 0.7)";
      ctx.fill();
    }
  }

  // The frame itself, with the rotation it has.
  const angle = ((Number(live.rotation) || 0) * Math.PI) / 180;
  ctx.translate(live.x + live.width / 2, live.y + live.height / 2);
  ctx.rotate(angle);
  ctx.translate(-(live.x + live.width / 2), -(live.y + live.height / 2));

  ctx.strokeStyle = "#3fa3ec";
  ctx.lineWidth = 2;
  ctx.strokeRect(live.x, live.y, live.width, live.height);

  // Corner marks and a centre dot.
  const mark = Math.min(18, live.width / 4, live.height / 4);
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [cornerX, cornerY, dx, dy] of [
    [live.x, live.y, 1, 1],
    [live.x + live.width, live.y, -1, 1],
    [live.x + live.width, live.y + live.height, -1, -1],
    [live.x, live.y + live.height, 1, -1],
  ]) {
    ctx.moveTo(cornerX + dx * mark, cornerY);
    ctx.lineTo(cornerX, cornerY);
    ctx.lineTo(cornerX, cornerY + dy * mark);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(live.x + live.width / 2, live.y + live.height / 2, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#3fa3ec";
  ctx.fill();

  // The handle that turns the frame.
  const handle = cameraRotateHandle(live);
  ctx.beginPath();
  ctx.arc(handle.x, handle.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#3fa3ec";
  ctx.fill();

  ctx.restore();
}

/* ---------------------------------------------------------------- timeline */

/**
 * How many columns of frames the timeline shows.
 *
 * The strip is a long one — three hundred frames — and the columns are a
 * fixed width, so the timeline scrolls across rather than stretching the
 * frames apart. The cap keeps the number of cells the browser has to draw
 * within reach.
 */
function timelineColumnCount() {
  // The floor is the empty room a fresh document shows; a long document gets
  // its own length plus a little, not three hundred columns of buttons for
  // every row of a imported document with hundreds of layers.
  return Math.max(64, Math.min(MAX_COLUMNS, timelineColumns(state.project, 64)));
}

/* ------------------------------------------------------------------ camera */

/** The camera key that sits on the current frame, if any. */
function currentCameraKey() {
  return cameraKeyAt(state.project.camera, state.project.currentFrame);
}

/** The camera window as it is shown: the drag in progress, or the one at this frame. */
function currentCameraWindow(frame = state.project.currentFrame) {
  if (state.cameraLive) return state.cameraLive;
  return cameraAt(state.project.camera, frame);
}

/** A canvas point in the frame's own space (the frame is not rotated). */
function cameraToLocal(point, window) {
  const angle = -((Number(window.rotation) || 0) * Math.PI) / 180;
  const centreX = window.x + window.width / 2;
  const centreY = window.y + window.height / 2;
  const dx = point.x - centreX;
  const dy = point.y - centreY;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}

/** A point of the frame's own space back in canvas coordinates. */
function cameraFromLocal(local, window) {
  const angle = ((Number(window.rotation) || 0) * Math.PI) / 180;
  const centreX = window.x + window.width / 2;
  const centreY = window.y + window.height / 2;
  return {
    x: centreX + local.x * Math.cos(angle) - local.y * Math.sin(angle),
    y: centreY + local.x * Math.sin(angle) + local.y * Math.cos(angle),
  };
}

/**
 * Draw something that belongs to a cell where the cell's transform says.
 *
 * The transform is a part of the cell, so the picture of the cell goes on
 * the stage with it: moved, made bigger or smaller, and turned around the
 * middle of the canvas. A layer may have a transform of its own as well -
 * a cell that is a folder of layers is moved as a whole - and the two are
 * put on the stage one after the other.
 */
function withCellTransform(context, transforms, width, height, draw) {
  const list = (Array.isArray(transforms) ? transforms : [transforms]).filter(
    (transform) => transform && !isPlain(transform),
  );
  if (!list.length) {
    draw();
    return;
  }
  context.save();
  for (const transform of list) {
    const matrix = transformMatrix(transform, width, height);
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  }
  try {
    draw();
  } finally {
    context.restore();
  }
}

/** How many canvas units one screen pixel is worth. */
function cameraTolerance() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return 10;
  return (10 * documentSize(state.project).width) / rect.width;
}

/** The handle inside the top edge that turns the frame. */
function cameraRotateHandle(window) {
  const halfHeight = window.height / 2;
  return cameraFromLocal({ x: 0, y: -halfHeight + cameraTolerance() * 2.4 }, window);
}

/** What is under the pointer: a corner, the turn handle, the frame or nothing. */
function cameraHitTest(point) {
  const window = currentCameraWindow();
  if (!window) return null;
  const tolerance = cameraTolerance();
  const corners = cameraCorners(window);

  for (let index = 0; index < corners.length; index += 1) {
    if (Math.hypot(point.x - corners[index].x, point.y - corners[index].y) <= tolerance) {
      return { kind: "resize", corner: index };
    }
  }

  const rotate = cameraRotateHandle(window);
  if (Math.hypot(point.x - rotate.x, point.y - rotate.y) <= tolerance) {
    return { kind: "rotate" };
  }

  const local = cameraToLocal(point, window);
  if (
    Math.abs(local.x) <= window.width / 2 &&
    Math.abs(local.y) <= window.height / 2
  ) {
    return { kind: "move" };
  }

  return null;
}

/** Start a drag of the camera frame. */
function startCameraDrag(point, options = {}) {
  const hit = options.forceRotate ? { kind: "rotate" } : cameraHitTest(point);
  if (!hit) {
    setStatus("The camera frame is not under the pointer", true);
    return;
  }

  const window = currentCameraWindow();
  state.cameraDrag = {
    kind: hit.kind,
    corner: hit.corner,
    start: { ...window },
    startPoint: point,
    startCentre: cameraFromLocal({ x: 0, y: 0 }, window),
    startAngle: Math.atan2(point.y - (window.y + window.height / 2), point.x - (window.x + window.width / 2)),
  };
  state.cameraLive = { ...window };
}

/** Move the frame while the pointer is down. */
function updateCameraDrag(point) {
  const drag = state.cameraDrag;
  if (!drag) return;
  const start = drag.start;

  if (drag.kind === "move") {
    state.cameraLive = {
      ...start,
      x: start.x + (point.x - drag.startPoint.x),
      y: start.y + (point.y - drag.startPoint.y),
    };
    return;
  }

  if (drag.kind === "rotate") {
    const angle = Math.atan2(
      point.y - drag.startCentre.y,
      point.x - drag.startCentre.x,
    );
    const degrees = (angle - drag.startAngle) * (180 / Math.PI);
    state.cameraLive = { ...start, rotation: (Number(start.rotation) || 0) + degrees };
    return;
  }

  // A corner scales the frame and keeps its shape.
  const corners = cameraCorners(start);
  const corner = corners[drag.corner];
  const opposite = corners[(drag.corner + 2) % 4];
  const signX = corner.x >= opposite.x ? 1 : -1;
  const signY = corner.y >= opposite.y ? 1 : -1;
  const local = cameraToLocal(point, start);
  const localOpposite = cameraToLocal(opposite, start);
  const aspect = start.width / Math.max(1, start.height);
  const minimum = 16;

  let halfWidth = Math.abs(local.x - localOpposite.x);
  let halfHeight = Math.abs(local.y - localOpposite.y);
  if (drag.corner === 0 || drag.corner === 2) halfHeight = halfWidth / aspect;
  else halfWidth = halfHeight * aspect;

  halfWidth = Math.max(minimum / 2, halfWidth);
  halfHeight = Math.max(minimum / 2, halfHeight);

  // The opposite corner stays where it was.
  const centreLocal = {
    x: localOpposite.x + signX * halfWidth,
    y: localOpposite.y + signY * halfHeight,
  };
  const centre = cameraFromLocal(centreLocal, start);
  const rotated = cameraFromLocal({ x: 0, y: 0 }, start);

  state.cameraLive = {
    ...start,
    x: centre.x - halfWidth,
    y: centre.y - halfHeight,
    width: halfWidth * 2,
    height: halfHeight * 2,
    rotation: start.rotation,
  };
  void rotated;
}

/** Write the dragged frame into the key on the current frame. */
function commitCameraDrag() {
  const drag = state.cameraDrag;
  const live = state.cameraLive;
  state.cameraDrag = null;
  state.cameraLive = null;
  if (!drag || !live) return;

  const project = state.project;
  const before = snapshot();
  const key = currentCameraKey();
  const window = {
    frame: project.currentFrame,
    x: Math.round(live.x),
    y: Math.round(live.y),
    width: Math.round(live.width),
    height: Math.round(live.height),
    rotation: Number(((live.rotation || 0) % 360).toFixed(2)),
    interp: key?.interp ?? "linear",
  };

  project.camera = setCameraKey(project.camera, window);
  recordHistory(before);
  markDirty();
  renderTimeline();
  renderCanvas();
  syncCameraControls();
  setStatus(
    `Camera key on frame ${project.currentFrame} — ${window.width}×${window.height}` +
      (window.rotation ? ` at ${window.rotation}°` : ""),
  );
}

/** Show a panel that the Window menu can hide. */
function showPane(pane) {
  const item = document.querySelector(`#windowMenu [data-pane-toggle="${pane}"]`);
  if (item && item.getAttribute("aria-checked") === "false") item.click();
}

/** Add a camera key on the current frame, keeping the current framing. */
function addCameraKey() {
  const project = state.project;
  const before = snapshot();
  const existing = currentCameraKey();
  const shown = cameraAt(project.camera, project.currentFrame);

  project.camera = setCameraKey(project.camera, {
    frame: project.currentFrame,
    x: existing?.x ?? shown?.x ?? 0,
    y: existing?.y ?? shown?.y ?? 0,
    width: existing?.width ?? shown?.width ?? project.width,
    height: existing?.height ?? shown?.height ?? project.height,
    rotation: existing?.rotation ?? shown?.rotation ?? 0,
    interp: existing?.interp ?? "linear",
  });

  recordHistory(before);
  markDirty();
  renderTimeline();
  renderCanvas();
  syncCameraControls();
  // The framing is edited in the Inspector, so show it if it is hidden.
  showPane("inspector");
  setStatus(`Camera key on frame ${project.currentFrame}`);
}

/** Add or remove the camera key on the current frame. */
function toggleCameraKey() {
  if (currentCameraKey()) {
    removeCameraKey();
    return;
  }
  addCameraKey();
}

/** Remove the camera key on the current frame. */
function removeCameraKey() {
  const project = state.project;
  if (!currentCameraKey()) {
    setStatus("There is no camera key on this frame", true);
    return;
  }
  const before = snapshot();
  project.camera = deleteCameraKey(project.camera, project.currentFrame);
  recordHistory(before);
  markDirty();
  renderTimeline();
  renderCanvas();
  syncCameraControls();
  setStatus(`Camera key removed from frame ${project.currentFrame}`);
}

function toggleCameraView() {
  state.cameraView = !state.cameraView;
  renderTimeline();
  renderCanvas();
  setStatus(state.cameraView ? "Camera view on" : "Camera view off — the whole canvas is shown");
}

/** Show the camera key of the current frame in the Inspector. */
function syncCameraControls() {
  const project = state.project;
  const key = currentCameraKey();
  const shown = cameraAt(project.camera, project.currentFrame);

  cameraXInput.value = String(Math.round(shown?.x ?? 0));
  cameraYInput.value = String(Math.round(shown?.y ?? 0));
  cameraWidthInput.value = String(Math.round(shown?.width ?? project.width));
  cameraHeightInput.value = String(Math.round(shown?.height ?? project.height));
  applyView();
  cameraRotationInput.value = String(Math.round(shown?.rotation ?? 0));
  cameraInterpSelect.value = key?.interp ?? "linear";

  const hasKey = Boolean(key);
  cameraRemoveButton.disabled = !hasKey;
  for (const input of [
    cameraXInput,
    cameraYInput,
    cameraWidthInput,
    cameraHeightInput,
    cameraRotationInput,
  ]) {
    input.disabled = !hasKey;
  }
  cameraInterpSelect.disabled = !hasKey;
  cameraHint.textContent = hasKey
    ? `Camera key on frame ${project.currentFrame}. The camera holds this framing until the next key.`
    : "No camera key on this frame. The camera holds its last key until the next one, so one key frames the whole animation.";
}

cameraAddButton.addEventListener("click", addCameraKey);
cameraRemoveButton.addEventListener("click", removeCameraKey);

cameraFitButton.addEventListener("click", () => {
  const project = state.project;
  if (!currentCameraKey()) {
    addCameraKey();
    return;
  }
  updateCameraKey({ x: 0, y: 0, width: project.width, height: project.height });
  setStatus("Camera frames the whole canvas");
});

cameraZoomButton.addEventListener("click", () => {
  const project = state.project;
  if (!currentCameraKey()) {
    addCameraKey();
    return;
  }
  const width = Math.max(16, Math.round(project.width / 2));
  const height = Math.max(16, Math.round(project.height / 2));
  updateCameraKey({
    x: Math.round((project.width - width) / 2),
    y: Math.round((project.height - height) / 2),
    width,
    height,
  });
  setStatus("Camera zoomed to the centre");
});

cameraZoomInButton?.addEventListener("click", () => {
  zoomStageAtCentre(1 + ZOOM_STEP);
  setStatus("Zoomed in");
});

cameraZoomOutButton?.addEventListener("click", () => {
  zoomStageAtCentre(1 / (1 + ZOOM_STEP));
  setStatus("Zoomed out");
});

/* ------------------------------------------------------- the brush panel */

const brushImageName = document.getElementById("brushImageName");
const brushLibrarySelect = document.getElementById("brushLibrary");
const brushSaveButton = document.getElementById("brushSave");
const brushPanelButton = document.getElementById("brushPanelButton");
const brushDialog = document.getElementById("brushDialog");
const brushDrop = document.getElementById("brushDrop");
const brushDropInput = document.getElementById("brushDropInput");
const brushBuiltinsList = document.getElementById("brushBuiltins");
const brushImportedList = document.getElementById("brushImported");
const brushImportedEmpty = document.getElementById("brushImportedEmpty");

/**
 * The picture of a soft round tip.
 *
 * It is made in the page, so the program does not have to carry a picture
 * file around. This is the shape of an air brush: soft at the edge.
 */
function softTipData() {
  const size = 64;
  const surface = document.createElement("canvas");
  surface.width = size;
  surface.height = size;
  const context = surface.getContext("2d");
  const middle = size / 2;
  const fade = context.createRadialGradient(middle, middle, 0, middle, middle, middle);
  fade.addColorStop(0, "rgba(16, 20, 24, 1)");
  fade.addColorStop(0.55, "rgba(16, 20, 24, 0.6)");
  fade.addColorStop(1, "rgba(16, 20, 24, 0)");
  context.fillStyle = fade;
  context.fillRect(0, 0, size, size);
  // The picture of the tip is kept as base64, the way a drawing keeps it.
  return surface.toDataURL("image/png").split(",")[1] ?? "";
}

/**
 * The brushes that are always there.
 *
 * The round tip paints with the plain round stroke. The soft one paints with
 * a picture of a soft blob.
 */
const BUILT_IN_BRUSHES = [
  { name: "the round tip", size: 6, data: null },
  { name: "the soft round", size: 40, data: null },
];

/** The picture of the soft round tip, made when it is first needed. */
let softTip = null;

function builtInBrushes() {
  if (!softTip) softTip = softTipData();
  return BUILT_IN_BRUSHES.map((brush) => (brush.name === "the soft round" ? { ...brush, data: softTip } : brush));
}

/* ------------------------------------------------------------ the library */

/** Where the saved brushes are kept. */
const BRUSH_STORE = "tvmini.brushes";

/** The saved brushes. */
function readBrushLibrary() {
  try {
    const raw = localStorage.getItem(BRUSH_STORE);
    const list = raw ? JSON.parse(raw) : [];
    // A brush may have no picture: a round brush that came from Clip Studio
    // Paint is a brush too, and its settings are worth keeping.
    return Array.isArray(list)
      ? list.filter((b) => b && (typeof b.data === "string" || b.data === null))
      : [];
  } catch {
    return [];
  }
}

/**
 * Where the file a brush came from is kept.
 *
 * A `.sut` file is laid out over many pages and can be a few hundred
 * kilobytes, more than a browser store will hold for every brush, so the
 * original file is kept in the database of the page instead. Exporting the
 * brush opens that file and changes only the settings that were asked for,
 * which is how every property this program does not understand survives.
 */
const BRUSH_SOURCE_DB = "tvmini.brushSources";
const BRUSH_SOURCE_STORE = "sources";

function brushSourceDatabase() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(BRUSH_SOURCE_DB, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BRUSH_SOURCE_STORE)) {
        database.createObjectStore(BRUSH_SOURCE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Keep the file a brush came from, under the name of the brush. */
async function saveBrushSource(name, source) {
  if (!name || typeof source !== "string" || !source) return false;
  const database = await brushSourceDatabase();
  if (!database) return false;
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(BRUSH_SOURCE_STORE, "readwrite");
      transaction.objectStore(BRUSH_SOURCE_STORE).put(source, name);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    });
    return true;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

/** The file a brush came from, or null when there is none. */
async function readBrushSource(name) {
  if (!name) return null;
  const database = await brushSourceDatabase();
  if (!database) return null;
  try {
    const source = await new Promise((resolve, reject) => {
      const request = database
        .transaction(BRUSH_SOURCE_STORE, "readonly")
        .objectStore(BRUSH_SOURCE_STORE)
        .get(name);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    return typeof source === "string" ? source : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/** Forget the file of a brush that is no longer in the library. */
async function forgetBrushSource(name) {
  if (!name) return;
  const database = await brushSourceDatabase();
  if (!database) return;
  try {
    await new Promise((resolve) => {
      const transaction = database.transaction(BRUSH_SOURCE_STORE, "readwrite");
      transaction.objectStore(BRUSH_SOURCE_STORE).delete(name);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  } finally {
    database.close();
  }
}

function writeBrushLibrary(list) {
  try {
    localStorage.setItem(BRUSH_STORE, JSON.stringify(list));
  } catch {
    setStatus("The brushes could not be saved", true);
  }
}

/**
 * Put a brush into the library, under its own name.
 *
 * The settings of the brush are kept with it, so that a brush that comes
 * from Clip Studio Paint keeps its size and the rest of it.
 */
function saveBrushToLibrary(brush) {
  const list = readBrushLibrary().filter((item) => item.name !== brush.name);
  // The file the brush came from is not put in the browser store with it: it
  // is kept in the database of the page (see `saveBrushSource`).
  const { source, ...rest } = brush;
  list.push({ ...rest, name: brush.name, data: brush.data ?? null });
  writeBrushLibrary(list);
}

/** Fill the list of saved brushes. */
function refreshBrushLibrary() {
  const list = readBrushLibrary();
  const wanted = brushLibrarySelect.value;
  brushLibrarySelect.textContent = "";

  const round = document.createElement("option");
  round.value = "";
  round.textContent = "the round tip";
  brushLibrarySelect.append(round);

  for (const brush of list) {
    const option = document.createElement("option");
    option.value = brush.name;
    option.textContent = brush.name;
    brushLibrarySelect.append(option);
  }
  if (list.some((brush) => brush.name === wanted)) brushLibrarySelect.value = wanted;
}

/** The brush of the drawing that is being drawn on. */
function currentBrush() {
  const layer = currentLayer();
  if (!layer) return null;
  // The drawing that is being drawn on, without making a new one: the tip
  // under the pointer must not leave a drawing behind.
  const drawing = drawingAt(layer, state.project.currentFrame);
  return drawing?.brush ?? null;
}

/**
 * Is the brush one that came from Clip Studio Paint?
 *
 * A brush that was read out of a `.sut` carries the curves that follow the
 * hand (`dyn`) and the bytes of its file (`source`); the brushes of this
 * program carry neither.
 */
function brushFromSut(brush) {
  return Boolean(brush?.source) || Boolean(brush?.dyn);
}



/**
 * Put a brush on the drawing that is being drawn on.
 *
 * A brush that comes with a size brings it with it: the width of the brush
 * is set to the size the brush was made with, the same way Clip Studio Paint
 * picks up the settings of a brush when it is chosen.
 */
function useBrush(brush, name) {
  const layer = currentLayer();
  if (!layer) return false;
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return false;
  }
  // The brush is carried with the drawing that is on the paper. A cel that
  // shows on the frame keeps it; an empty frame of a track carries the
  // brush with the next stroke instead, so picking a brush leaves nothing
  // behind on the timeline.
  let target = layer;
  let targetFrame = state.project.currentFrame;
  if (isGroup(layer) && isAnimationFolder(layer)) {
    const entry = folderCells(state.project, state.project.currentLayer).get(targetFrame);
    if (!entry) {
      if (brush) applyBrushSettings(brush);
      brushImageName.textContent = name;
      drawBrushShape();
      return true;
    }
    target = state.project.layers[entry.layer];
  }
  const drawing = ensureDrawing(target, targetFrame);
  const before = snapshot();
  if (brush) {
    // Everything that shapes the paint is kept with the drawing, so the
    // brush is the same brush when it is taken in the hand again: a soft,
    // thin, grainy tip is not turned into a plain round one.
    drawing.brush = carriedBrush(brush);
  } else {
    delete drawing.brush;
  }
  recordHistory(before);
  markDirty();
  afterChange();
  brushImageName.textContent = name;
  if (brush) applyBrushSettings(brush);
  // The shape of the brush in the panel is drawn again.
  drawBrushShape();
  return true;
}

/**
 * Put the settings of a brush into the tool panel.
 *
 * A brush that comes from Clip Studio Paint brings the size of its tip and
 * how strong it paints. Both are put into the tool in the hand, so that the
 * brush that was chosen is the brush that is drawn with.
 */
function applyBrushSettings(brush) {
  const settings = toolSettings();
  const size = Number(brush.size);
  if (Number.isFinite(size) && size > 0) {
    const value = Math.min(Number(widthInput.max) || 800, Math.round(size));
    widthInput.value = String(value);
    widthValue.textContent = String(value);
    if (brushShapeSize) brushShapeSize.textContent = `${value}px`;
    settings.width = value;
    syncQuickBar();
    syncBrushSizeGrid();
    syncGauges();
  }
  const opacity = Number(brush.opacity);
  if (Number.isFinite(opacity) && opacity > 0) {
    const value = Math.min(100, Math.round(opacity));
    strokeOpacityInput.value = String(value);
    strokeOpacityValue.textContent = `${value}%`;
    settings.opacity = value;
  }

  // The way the paint of the brush goes down. A brush that says nothing about
  // one of these settings leaves the tool as it is, so picking up a plain
  // brush does not reset the panel.
  const take = (key, low, high) => {
    const value = Number(brush[key]);
    if (!Number.isFinite(value)) return;
    settings[key] = Math.max(low, Math.min(high, Math.round(value)));
  };
  take("flow", 0, 100);
  take("hardness", 0, 100);
  take("thickness", 1, 200);
  take("spacing", 1, 200);
  if (brush.binarize === true) settings.binarize = true;
  else settings.binarize = false;
  // The paper of the brush: the grain it carries is the paper it is drawn on.
  settings.paper = Boolean(brush.grain?.data);

  if (flowInput) {
    flowInput.value = String(settings.flow ?? 100);
    flowValue.textContent = `${settings.flow ?? 100}%`;
  }
  if (hardnessInput) {
    hardnessInput.value = String(settings.hardness ?? 100);
    hardnessValue.textContent = `${settings.hardness ?? 100}%`;
  }
  if (thicknessInput) {
    thicknessInput.value = String(settings.thickness ?? 100);
    thicknessValue.textContent = `${settings.thickness ?? 100}%`;
  }
  if (spacingInput) {
    spacingInput.value = String(settings.spacing ?? 25);
    spacingValue.textContent = `${settings.spacing ?? 25}%`;
  }
  if (paperInput) paperInput.checked = settings.paper === true;
  binarizeInput.checked = settings.binarize === true;
  syncGauges();
}

/**
 * The brush a stroke is made with.
 *
 * It is the picture of the brush in the hand and the way the tool in the hand
 * paints: whether the edge of the tip is hard. Keeping it with the stroke
 * means a stroke is drawn the same way after the brush has been changed.
 */
function strokeBrushFor(settings) {
  const brush = currentBrush();
  const strokeBrush = carriedBrush(brush);
  strokeBrush.spacing = settings.spacing ?? strokeBrush.spacing ?? 25;
  // The panel is the last word on the settings it shows: what was set there
  // is what the stroke was drawn with.
  if (Number.isFinite(Number(settings.flow))) strokeBrush.flow = settings.flow;
  if (Number.isFinite(Number(settings.hardness))) strokeBrush.hardness = settings.hardness;
  if (Number.isFinite(Number(settings.thickness))) strokeBrush.thickness = settings.thickness;
  // A hard edge is a way of painting, so it is kept with the stroke: a stroke
  // that was drawn binarized stays binarized when the export draws it again.
  if (settings.binarize === true) strokeBrush.binarize = true;
  else delete strokeBrush.binarize;
  // The paper of the brush can be turned off while the brush keeps its grain.
  if (settings.paper === false) delete strokeBrush.grain;
  return strokeBrush;
}

brushLibrarySelect.addEventListener("change", () => {
  const name = brushLibrarySelect.value;
  if (!name) {
    useBrush(null, "the round tip");
    setStatus("The brush is the round tip again");
    return;
  }
  const brush = readBrushLibrary().find((item) => item.name === name);
  if (!brush) return;
  if (useBrush(brush, brush.name)) setStatus(`The brush is now ${brush.name}`);
});

brushSaveButton.addEventListener("click", () => {
  const layer = currentLayer();
  if (!layer) return;
  const brush = ensureDrawing(layer, state.project.currentFrame).brush;
  if (!brush) {
    setStatus("Pick a brush image first", true);
    return;
  }
  const name = prompt("The name of this brush", "my brush");
  if (!name) return;
  const settings = toolSettings();
  saveBrushToLibrary({
    ...brush,
    name,
    data: brush.data ?? null,
    size: Number(widthInput.value) || brush.size || null,
    opacity: settings.opacity,
    flow: settings.flow,
    hardness: settings.hardness,
    thickness: settings.thickness,
    spacing: settings.spacing,
    binarize: settings.binarize === true,
    grain: settings.paper === false ? null : brush.grain ?? null,
  });
  refreshBrushLibrary();
  refreshBrushPanel();
  brushLibrarySelect.value = name;
  setStatus(`Saved the brush ${name}`);
});

/* ------------------------------------------------------------ the panel */

brushPanelButton.addEventListener("click", () => {
  refreshBrushPanel();
  brushDialog.hidden = false;
});

/**
 * One card of the brush panel.
 *
 * The card shows a stroke made with the brush, the name of the brush, how
 * wide it is, and what can be done with it.
 */
function brushCard(brush, options = {}) {
  const card = document.createElement("div");
  card.className = "brush-card-item";

  const preview = document.createElement("canvas");
  preview.className = "brush-preview";
  preview.width = 150;
  preview.height = 44;
  card.append(preview);
  drawBrushPreview(preview, brush);

  const name = document.createElement("span");
  name.className = "brush-card-name";
  name.textContent = brush.name;
  card.append(name);

  const size = document.createElement("span");
  size.className = "brush-card-size";
  size.textContent = `${brush.size ?? Number(widthInput.value) ?? 6}px`;
  card.append(size);

  const use = document.createElement("button");
  use.type = "button";
  use.textContent = "Use";
  use.addEventListener("click", () => {
    if (useBrush(brush, brush.name)) setStatus(`The brush is now ${brush.name}`);
  });
  card.append(use);

  const write = document.createElement("button");
  write.type = "button";
  write.textContent = "Export .sut";
  write.title = "Write this brush out as a Clip Studio Paint brush";
  write.addEventListener("click", () => exportBrushAsSut(brush));
  card.append(write);

  if (options.remove) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      writeBrushLibrary(readBrushLibrary().filter((item) => item.name !== brush.name));
      forgetBrushSource(brush.name);
      refreshBrushLibrary();
      refreshBrushPanel();
      setStatus(`Removed the brush ${brush.name}`);
    });
    card.append(remove);
  }

  return card;
}

/** Draw a stroke with the brush, so the card shows what the brush does. */
function drawBrushPreview(surface, brush) {
  const context = surface.getContext("2d");
  const width = surface.width;
  const height = surface.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#292c2f";
  context.fillRect(0, 0, width, height);

  const size = Math.max(2, Math.min(30, Number(brush.size) || 6));
  // The line of the preview is a stroke, and it is painted by the same code
  // that paints the stage, so a brush that has a picture of its own looks
  // here the way it looks on the paper.
  const points = [];
  for (let step = 0; step <= 48; step += 1) {
    const at = step / 48;
    points.push([8 + (width - 16) * at, height - 8 - Math.sin(at * Math.PI) * (height - 20)]);
  }
  drawStrokeDirect(context, { color: colorInput.value, width: size, points }, width, height, brush);

  // The picture of the tip comes in from the page, so the preview is drawn
  // again when it arrives.
  const again = () => drawBrushPreview(surface, brush);
  const tip = brush.data ? tipImage(brush) : null;
  if (tip && !tip.complete) tip.addEventListener("load", again, { once: true });
}

/** Fill the panel with the brushes that are there. */
function refreshBrushPanel() {
  brushBuiltinsList.textContent = "";
  for (const brush of builtInBrushes()) {
    brushBuiltinsList.append(brushCard(brush));
  }

  const list = readBrushLibrary();
  brushImportedList.textContent = "";
  for (const brush of list) {
    brushImportedList.append(brushCard(brush, { remove: true }));
  }
  brushImportedEmpty.hidden = list.length > 0;
}

/**
 * Bring a brush in.
 *
 * A PNG works, and so does a Clip Studio Paint brush, because the picture is
 * looked for inside the file. The picture becomes the tip of the brush of
 * the drawing that is being drawn on, and the brush is kept in the library.
 */
async function importBrushFiles(files) {
  let brought = 0;
  let last = null;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let picture = null;
    let name = file.name.replace(/\.[^.]+$/, "");
    let settings = {};
    let source = null;

    // A Clip Studio Paint brush is a database with the picture of the tip in
    // it, so it is read as one; anything else is taken as a picture.
    if (/\.sut$/i.test(file.name)) {
      const read = await readSutBrush(bytes);
      if (!read) {
        setStatus(`That brush holds no settings the brush can use: ${file.name}`, true);
        continue;
      }
      picture = read.texture;
      name = read.name || name;
      // Every setting the file has, so that the brush that was brought in is
      // the brush that is drawn with: its size, its flow, the hardness and
      // the thickness of its tip, the spacing of its dabs, the turn of the
      // tip, the curves that follow the hand and the grain of its paper.
      const carried = {
        size: read.size,
        opacity: read.opacity,
        flow: read.flow,
        hardness: read.hardness,
        thickness: read.thickness,
        spacing: read.spacing,
        autoInterval: read.autoInterval,
        rotation: read.rotation,
        rotationFollow: read.rotationFollow,
        rotationJitter: read.rotationJitter,
        rotationEffector: read.rotationEffector,
        binarize: read.binarize,
        dyn: read.dyn,
        grain: read.grain,
      };
      for (const [key, value] of Object.entries(carried)) {
        if (value === undefined || value === null || value === false) continue;
        settings[key] = value;
      }
      // The settings this program does not paint with are still in the file,
      // and the brush keeps them.
      if (read.keeps?.length) settings.keeps = read.keeps;
      source = read.source;
    } else {
      picture = brushImageFromBytes(bytes);
      if (!picture) {
        setStatus(`That file holds no picture the brush can use: ${file.name}`, true);
        continue;
      }
    }

    const brush = {
      name,
      data: picture?.data ?? null,
      ...settings,
    };
    // The file itself is kept apart from the library, so that writing the
    // brush out again changes only what was changed here and keeps every
    // other property of the original.
    if (source) await saveBrushSource(name, source);
    saveBrushToLibrary(brush);
    last = brush;
    brought += 1;
  }

  refreshBrushLibrary();
  refreshBrushPanel();
  if (!brought) return;
  // The brush that was brought in is the one in the hand.
  if (last) useBrush(last, last.name);
  setStatus(`Brought in ${brought} brush${brought === 1 ? "" : "es"}`);
}

brushDrop.addEventListener("click", () => brushDropInput.click());
brushDrop.addEventListener("dragover", (event) => {
  event.preventDefault();
  brushDrop.classList.add("over");
});
brushDrop.addEventListener("dragleave", () => brushDrop.classList.remove("over"));
brushDrop.addEventListener("drop", async (event) => {
  event.preventDefault();
  brushDrop.classList.remove("over");
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) await importBrushFiles(files);
});
brushDropInput.addEventListener("change", async () => {
  const files = [...(brushDropInput.files ?? [])];
  brushDropInput.value = "";
  if (files.length) await importBrushFiles(files);
});

// A file that is dropped outside the panel must not replace the page.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

/**
 * Write a brush out as a Clip Studio Paint brush.
 *
 * The file is a `.sut` file: the same thing Clip Studio Paint writes when a
 * brush is exported, so it can be brought into Clip Studio Paint and into
 * other programs that read those brushes.
 */
async function exportBrushAsSut(brush) {
  const size = Number(brush.size) || Number(widthInput.value) || 6;
  try {
    // The file the brush came from, kept in the page: opening it and changing
    // only what was changed here is what keeps every property this program
    // does not paint with - the dual brush, the colour mixing, the spray, and
    // every column Clip Studio Paint keeps for its own sliders.
    const source = await readBrushSource(brush.name);
    const changes = {
      name: brush.name,
      size,
      opacity: Number(brush.opacity) || Number(strokeOpacityInput.value) || 100,
      flow: brush.flow,
      hardness: brush.hardness,
      thickness: brush.thickness,
      spacing: brush.spacing,
      rotation: brush.rotation,
      rotationFollow: brush.rotationFollow,
      rotationJitter: brush.rotationJitter,
      rotationEffector: brush.rotationEffector,
      binarize: brush.binarize,
      dyn: brush.dyn,
      grain: brush.grain,
      texture: brush.data ? { data: brush.data } : null,
    };
    if (source) changes.source = source;
    const result = await backend.exportBrush(changes, `${brush.name}.sut`);
    if (!result) return;
    setStatus(`The brush was written to ${result.path}`);
  } catch (error) {
    setStatus(`The brush could not be written: ${error.message}`, true);
  }
}

/* ---------------------------------------------------------- the brush tip */

/** Where the pointer is, in canvas coordinates, or null when it is away. */
let tipPoint = null;

/** The pictures of the brushes, so they are only loaded once. */
const tipImages = new Map();

/**
 * The picture of a brush, ready to be drawn.
 *
 * The picture is loaded in the background and the canvas is drawn again when
 * it has arrived, so the tip appears as soon as it is ready.
 */
function tipImage(brush) {
  const key = brush.data;
  if (tipImages.has(key)) return tipImages.get(key);
  const image = new Image();
  image.onload = () => renderCanvas();
  image.src = `data:image/png;base64,${key}`;
  tipImages.set(key, image);
  return image;
}

/**
 * Draw the shape of the brush under the pointer.
 *
 * Clip Studio Paint shows the tip of the brush where the pointer is, and the
 * preview is the size of the stroke that will be left. A picture brush is
 * shown as its own picture, so what is painted can be seen before it is
 * painted.
 *
 * The tip goes on the sheet on top of the stage, so that moving the pointer
 * does not draw the whole document again.
 */
function drawBrushTip(target = overlayCtx) {
  if (!tipPoint || state.playing) return;
  if (state.tool !== "brush" && state.tool !== "pencil" && state.tool !== "eraser") return;

  const base = Math.max(0.5, (Number(widthInput.value) || 1) / 2);
  // A pen that is pressed harder draws a wider line, and the shape under
  // the pointer grows with it, so the tip shows the line that will be left.
  const pressure = tipPoint.pressure;
  const radius =
    pressure === null || pressure === undefined
      ? base
      : Math.max(
          0.5,
          base * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * pressure),
        );
  const brush = currentBrush();
  const { x, y } = tipPoint;

  target.save();
  if (brush?.data) {
    const image = tipImage(brush);
    if (image.complete && image.naturalWidth > 0) {
      // The shape of the tip is shown in the colour the brush paints with.
      const shape = tintedTip(brush, colorInput.value) ?? image;
      // The picture of the brush keeps its own shape: it is as tall as the
      // brush is wide, and its width follows from that.
      const height = radius * 2;
      const width = height * (shape.width / Math.max(1, shape.height));
      target.globalAlpha = 0.55;
      target.drawImage(shape, x - width / 2, y - height / 2, width, height);
    }
  } else {
    // A light ring under a dark one, so the shape of the brush is seen on
    // a light paper and on a dark one as well.
    target.globalAlpha = 0.9;
    target.strokeStyle = "#ffffff";
    target.lineWidth = 2.5;
    target.beginPath();
    target.arc(x, y, radius, 0, Math.PI * 2);
    target.stroke();

    target.globalAlpha = 0.85;
    target.strokeStyle = "#101418";
    target.lineWidth = 1;
    target.beginPath();
    target.arc(x, y, radius, 0, Math.PI * 2);
    target.stroke();
  }
  target.restore();
}

/**
 * Draw the sheet on top of the stage again.
 *
 * The sheet holds the shape of the brush and the stroke that is being drawn.
 * The stroke is drawn with the same code the document uses, so the preview
 * looks like the stroke that will be left behind. The sheet is put in the
 * same place as the stage, so the shape of the brush sits under the pointer.
 */
function drawOverlay() {
  const width = canvas.width;
  const height = canvas.height;
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, width, height);
  // The sheet is the size of the screen, so the stroke on it is drawn in the
  // pixels of the document - the same space the stage is drawn in, including
  // the pasteboard outside the project canvas.
  const doc = state.project ? documentSize(state.project) : { width, height };
  const docWidth = doc.width;
  const docHeight = doc.height;
  const { scale, view } = useStageSpace(docWidth, docHeight, overlayCtx);
  if (!view) {
    // The edge of the stage: a hairline around the canvas, the way Flash shows
    // where the paper ends and the pasteboard begins.
    const project = state.project;
    overlayCtx.strokeStyle = STAGE_EDGE;
    overlayCtx.lineWidth = 1 / scale;
    overlayCtx.strokeRect(0, 0, project.width, project.height);
  }
  if (state.drawing && !state.drawing.kind && !state.drawing.eraser) {
    // The stroke in the hand: the document underneath is not drawn again while
    // the pointer moves, so the stroke is shown here instead. An eraser is
    // not shown here: a sheet on top of the stage cannot take ink away, so
    // the eraser works on the document itself.
    //
    // A brush with a picture stamps itself onto the layers of the living
    // ink as it goes, so only its tip is drawn here.
    if (!liveStrokeState.active) {
      drawStrokesInto(overlayCtx, [state.drawing], brushOfStroke(state.drawing, currentBrush()));
    }
  }
  drawSelectionSheet(overlayCtx);
  drawBrushTip();
  if (view) overlayCtx.restore();
}

canvas.addEventListener("pointermove", (event) => {
  const [x, y] = canvasPoint(event);
  // The pressure is kept with the place of the pointer, so the shape of the
  // brush is as wide as the line that will be drawn.
  tipPoint = { x, y, pressure: pressureFor(event) };
  // Only the sheet on top of the stage is drawn again; the document stays as
  // it is, which is what keeps the stage smooth. A stroke in the hand draws
  // the sheet itself further down, so it is not drawn twice here.
  if (!state.drawing) drawOverlay();
});

canvas.addEventListener("pointerleave", () => {
  if (!tipPoint) return;
  tipPoint = null;
  drawOverlay();
});

refreshBrushLibrary();

/**
 * Show how much of the canvas the stage shows.
 *
 * Clip Studio Paint puts the zoom of the stage in the corner of the canvas,
 * so the same goes here. Clicking it fits the whole canvas again.
 */
function showZoom() {
  // The zoom of the stage, where 100% is the view as it fits.
  const zoom = viewZoom * 100;
  zoomLabel.textContent = `${zoom >= 10 ? zoom.toFixed(0) : zoom.toFixed(1)}%`;
}

/**
 * The zoom of the stage.
 *
 * The stage is what the canvas looks like on the screen. Clip Studio Paint
 * magnifies that, and the camera is a separate thing that decides what gets
 * exported, so the two are kept apart here as well: the zoom is a transform
 * on the canvas element and the camera is untouched by it.
 */
let viewZoom = 1;

/**
 * Where the document sits inside the stage, when the pane cannot be
 * scrolled far enough to put it there.
 *
 * The pane is scrolled to move the document, and the scroll stops at its
 * ends. When the document is smaller than the pane there is nothing to
 * scroll at all, so what is left over is kept here as a shift of the sheet.
 * The shift is only ever used when the scroll has no room, and it is put
 * back to nothing as soon as the pane is moved by hand.
 */
let viewShiftX = 0;
let viewShiftY = 0;
let expectedScrollLeft = null;
let expectedScrollTop = null;

/**
 * Put the zoom on the canvas element.
 *
 * The element is the size the document is shown at, and the buffer behind it
 * holds the dots of the screen, so the picture is drawn one to one. The pane
 * scrolls when the document is larger than the pane, the way Clip Studio
 * Paint does, and the bars of the pane show where the document is.
 */
function applyView() {
  const project = state.project;
  const zoom = viewZoom || 1;
  // The sheet shows the whole document, the pasteboard included, the way the
  // buffer and the world around it do.
  const doc = documentSize(project);
  const paperW = Math.round(doc.width * zoom);
  const paperH = Math.round(doc.height * zoom);
  canvas.style.width = `${paperW}px`;
  canvas.style.height = `${paperH}px`;
  if (canvasStack) {
    canvasStack.style.transform = viewShiftX || viewShiftY
      ? `translate(${viewShiftX}px, ${viewShiftY}px)`
      : "";
  }
  sizeWorld(paperW, paperH);
  // The buffer holds the dots of the screen, so it follows the zoom.
  const buffer = stageBuffer();
  if (canvas.width !== buffer.width || canvas.height !== buffer.height) {
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    // A new buffer is empty, so the picture is drawn again.
    renderCanvas();
  }
  showZoom();
}

/**
 * The size of the world the document sits in.
 *
 * The world is always a little larger than the pane and a little larger
 * than the document, so the bars of the pane keep something to show at any
 * zoom: a document zoomed right out does not swallow them.
 */
function sizeWorld(paperW, paperH) {
  if (!canvasWorld) return;
  const pane = canvasScroll.getBoundingClientRect();
  const worldW = Math.max(pane.width, paperW) + WORLD_PAD * 2;
  const worldH = Math.max(pane.height, paperH) + WORLD_PAD * 2;
  canvasWorld.style.width = `${Math.round(worldW)}px`;
  canvasWorld.style.height = `${Math.round(worldH)}px`;
}

/**
 * Put the canvas in the middle of the pane.
 *
 * The world is bigger than the pane, so the middle of the world is the
 * middle of the pane. The sheet — the canvas plus the pasteboard around it —
 * is in the middle of the world, and the sheet grows the same amount on both
 * sides of the canvas, so the middle of the sheet is the middle of the
 * canvas: the drawing ends up in the middle of the pane.
 */
function centreStage() {
  const maxX = Math.max(0, canvasScroll.scrollWidth - canvasScroll.clientWidth);
  const maxY = Math.max(0, canvasScroll.scrollHeight - canvasScroll.clientHeight);
  canvasScroll.scrollLeft = maxX / 2;
  canvasScroll.scrollTop = maxY / 2;
  expectedScrollLeft = canvasScroll.scrollLeft;
  expectedScrollTop = canvasScroll.scrollTop;
}

/** Go back to 100% and put the document in the middle of the pane. */
function resetStage() {
  viewZoom = 1;
  viewShiftX = 0;
  viewShiftY = 0;
  expectedScrollLeft = null;
  applyView();
  centreStage();
}

/**
 * Zoom the stage by a factor, keeping the point under the pointer in place.
 *
 * The point of the document under the pointer is worked out before the
 * zoom, and the document is placed afterwards so that the same point of the
 * document lands under the pointer again. Each axis is worked out on its
 * own: the horizontal point and the vertical one are different points of
 * the document, and mixing them up slides the picture away from the
 * pointer.
 */
function zoomStage(factor, clientX, clientY) {
  const project = state.project;
  const rect = canvas.getBoundingClientRect();
  const doc = documentSize(project);
  // The scale the document is really shown at. It can differ from the zoom
  // by a fraction of a pixel, because the size of the canvas is rounded.
  const scale = rect.width / doc.width;
  const pad = stagePadding(doc.width, doc.height);
  const localX = (clientX - rect.left) / scale - pad.x;
  const localY = (clientY - rect.top) / scale - pad.y;

  const next = Math.max(0.1, Math.min(16, viewZoom * factor));
  if (next === viewZoom) return;
  viewZoom = next;
  applyView();

  // The scale after the zoom, and the place the document has to sit at for
  // the point under the pointer to stay under the pointer. The point sits
  // that much inside the sheet, not at its edge.
  const after = canvas.getBoundingClientRect();
  const afterScale = after.width / documentSize(project).width;
  const wantX = clientX - (localX + pad.x) * afterScale;
  const wantY = clientY - (localY + pad.y) * afterScale;

  // The pane is scrolled to move the document there. The scroll stops at its
  // ends, and what it cannot take is left to the shift.
  const maxX = Math.max(0, canvasScroll.scrollWidth - canvasScroll.clientWidth);
  const maxY = Math.max(0, canvasScroll.scrollHeight - canvasScroll.clientHeight);
  canvasScroll.scrollLeft = Math.max(0, Math.min(maxX, canvasScroll.scrollLeft + (after.left - wantX)));
  canvasScroll.scrollTop = Math.max(0, Math.min(maxY, canvasScroll.scrollTop + (after.top - wantY)));
  expectedScrollLeft = canvasScroll.scrollLeft;
  expectedScrollTop = canvasScroll.scrollTop;

  // Where the document ended up, and the shift that puts it where it has
  // to be. The old shift is taken out first, because the place the document
  // was measured at already carries it.
  const settled = canvas.getBoundingClientRect();
  viewShiftX = wantX - (settled.x - viewShiftX);
  viewShiftY = wantY - (settled.y - viewShiftY);
  applyView();
}

// A pane that was moved by hand takes the shift with it: the shift only
// ever stands in for a scroll that could not be made.
canvasScroll?.addEventListener("scroll", () => {
  if (expectedScrollLeft === null) return;
  if (canvasScroll.scrollLeft === expectedScrollLeft && canvasScroll.scrollTop === expectedScrollTop) return;
  expectedScrollLeft = null;
  if (!viewShiftX && !viewShiftY) return;
  viewShiftX = 0;
  viewShiftY = 0;
  applyView();
});

/** Zoom the stage about the middle of the document. */
function zoomStageAtCentre(factor) {
  const box = canvas.getBoundingClientRect();
  zoomStage(factor, box.left + box.width / 2, box.top + box.height / 2);
}

/** The zoom that shows the whole canvas in the pane. */
function fitStage() {
  const project = state.project;
  // The room the pane really has: the bars of the pane are not part of it,
  // so the canvas is not left a bar's width too wide to fit.
  const width = canvasScroll.clientWidth;
  const height = canvasScroll.clientHeight;
  if (!width || !height) return;
  // The canvas is what is fitted, not the pasteboard around it: the drawing
  // fills the pane, and any stroke off the canvas is a scroll away.
  const zoom = Math.min(width / project.width, height / project.height);
  viewZoom = Math.max(0.1, Math.min(16, zoom));
  // The document goes back to the middle of the pane, so the shift the zoom
  // may have left behind is put away.
  viewShiftX = 0;
  viewShiftY = 0;
  expectedScrollLeft = null;
  applyView();
  // The document is in the middle of the pane again.
  centreStage();
}

/** Drag the stage with the middle mouse button: the pane is scrolled. */
function panStage(event) {
  const startX = event.clientX;
  const startY = event.clientY;
  const scrollX = canvasScroll.scrollLeft;
  const scrollY = canvasScroll.scrollTop;

  const move = (moveEvent) => {
    canvasScroll.scrollLeft = scrollX - (moveEvent.clientX - startX);
    canvasScroll.scrollTop = scrollY - (moveEvent.clientY - startY);
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

zoomLabel.addEventListener("click", () => {
  resetStage();
  setStatus("Back to 100%");
});
zoomInButton.addEventListener("click", () => {
  zoomStageAtCentre(1 + ZOOM_STEP);
  setStatus("Zoomed in");
});
zoomOutButton.addEventListener("click", () => {
  zoomStageAtCentre(1 / (1 + ZOOM_STEP));
  setStatus("Zoomed out");
});
zoomFitButton.addEventListener("click", () => {
  fitStage();
  setStatus("The whole canvas is shown");
});

for (const [input, field] of [
  [cameraXInput, "x"],
  [cameraYInput, "y"],
  [cameraWidthInput, "width"],
  [cameraHeightInput, "height"],
  [cameraRotationInput, "rotation"],
]) {
  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
      syncCameraControls();
      return;
    }
    const patch = { [field]: Math.round(value) };
    if (field === "width") patch.width = Math.max(16, patch.width);
    if (field === "height") patch.height = Math.max(16, patch.height);
    if (field === "rotation") patch.rotation = patch.rotation % 360;
    updateCameraKey(patch);
  });
}

cameraInterpSelect.addEventListener("change", () => {
  updateCameraKey({ interp: cameraInterpSelect.value });
});

/** Change the framing of the camera key on the current frame. */
function updateCameraKey(patch) {
  const project = state.project;
  const key = currentCameraKey();
  if (!key) {
    setStatus("Add a camera key on this frame first", true);
    return;
  }
  const before = snapshot();
  project.camera = setCameraKey(project.camera, { ...key, ...patch });
  recordHistory(before);
  markDirty();
  renderTimeline();
  renderCanvas();
  syncCameraControls();
}

/** The camera row: one diamond per key, plus the add / remove / view buttons. */
function renderCameraRow(columns, start) {
  const project = state.project;
  const row = element("div", "tl-row camera-row");

  const head = element("div", "tl-head");

  const name = element("button", "tl-name");
  name.append(iconGlyph("i-camera"));
  name.append(element("span", "tl-name-text", "Camera"));
  name.title = "The camera frames the shot; the stage shows what it sees";
  name.addEventListener("click", () => {
    if (currentCameraKey()) {
      setStatus(`Camera key on frame ${project.currentFrame}`);
    } else {
      addCameraKey();
    }
  });
  head.append(name);

  const add = iconButton("tl-icon", "i-diamond", "Add or remove the camera key on the current frame");
  add.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCameraKey();
  });

  const remove = iconButton("tl-icon", "i-cross", "Remove the camera key on the current frame");
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    removeCameraKey();
  });

  const view = iconButton(
    "tl-icon",
    state.cameraView ? "i-camera" : "i-frame",
    "Show the camera's shot in the stage",
  );
  view.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCameraView();
  });

  head.append(add, remove, view);

  const cells = element("div", "tl-cells");
  cells.style.setProperty("--frames", String(columns));
  for (let i = 0; i < columns; i += 1) {
    const frame = start + i;
    const key = cameraKeyAt(project.camera, frame);
    const cell = element("button", `tl-cell camera${key ? " key" : ""}`);
    cell.dataset.frame = String(frame);
    cell.type = "button";
    cell.style.gridColumn = `${i + 1} / span 1`;
      cell.style.gridRow = "1";
    cell.textContent = key ? "◆" : "";
    cell.title = key
      ? `Camera key — ${Math.round(key.width)}×${Math.round(key.height)} at ${Math.round(key.x)}, ${Math.round(key.y)}`
      : `Frame ${frame}`;
    cell.addEventListener("click", () => selectFrame(frame));
    cells.append(cell);
  }

  appendPlayhead(cells, project, columns, start);
  row.append(head, cells);
  return row;
}

/**
 * The layers that are on screen.
 *
 * The list is depth first, so a folder is followed by the layers it holds,
 * and a folder that is closed hides the layers inside it.
 *
 * The cels of an animation folder keep out of the timeline, the way Clip
 * Studio Paint shows a track: the folder is the row and its cels are the
 * cells on it, so the layers inside it get no rows of their own - the layer
 * palette holds them. A nested animation folder is a track of its own.
 */
function visibleLayers(project) {
  const out = [];
  const walk = (parent, hidden) => {
    for (const child of childrenOf(project, parent)) {
      if (hidden) {
        walk(child, true);
        continue;
      }
      const layer = project.layers[child];
      if (!isAnimationFolder(layer) && insideAnimationFolder(project, child)) {
        walk(child, true);
        continue;
      }
      out.push(child);
      walk(child, state.collapsed.has(project.layers[child].name));
    }
  };
  walk(-1, false);
  return out;
}

/**
 * The cells a folder shows.
 *
 * A folder has no cells of its own: its row shows the cells of the layers
 * inside it, the way an animation folder shows the cells of an animation.
 * The map is keyed by the frame a cell sits on.
 */
function folderCells(project, groupIndex) {
  const cells = new Map();
  for (const child of childrenOf(project, groupIndex)) {
    const layer = project.layers[child];
    for (const drawing of layer.drawings ?? []) {
      for (let offset = 0; offset < drawing.hold; offset += 1) {
        const frame = drawing.at + offset;
        if (cells.has(frame)) continue;
        cells.set(frame, {
          layer: child,
          name: offset === 0 ? drawing.name : null,
          count: drawing.hold,
          remaining: drawing.at + drawing.hold - frame,
        });
      }
    }
  }
  return cells;
}

/** Open or close a folder. */
function toggleFolder(name) {
  if (state.collapsed.has(name)) {
    state.collapsed.delete(name);
  } else {
    state.collapsed.add(name);
  }
  renderTimeline();
  renderLayerPanel();
}

/**
 * Draw the column of the playhead over a row.
 *
 * The column the current frame is in is tinted, the way Clip Studio Paint
 * draws it, and the column of the first frame is marked with a line.
 */
function appendPlayhead(cells, project, columns, start) {
  const current = project.currentFrame - start + 1;
  if (current >= 1 && current <= columns) {
    const playhead = element("div", "tl-playhead");
    playhead.style.gridColumn = `${current} / span 1`;
    cells.append(playhead);
  }
  if (start !== project.startFrame) return;
  const line = element("div", "tl-start-line");
  line.style.gridColumn = "1 / span 1";
  cells.append(line);
}

/**
 * Add a layer next to another one.
 *
 * A folder takes the new layer inside it, and an ordinary layer gets the
 * new one above it, the way the button on every row of the Clip Studio
 * Paint layer palette works.
 */
function addLayerBeside(index) {
  const project = state.project;
  if (project.layers.length >= MAX_LAYERS) {
    setStatus(`At most ${MAX_LAYERS} layers are allowed`, true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const layer = project.layers[index];
  const inside = isGroup(layer);
  const parent = inside ? index : (layer.parent ?? -1);
  const at = inside ? index + 1 : index;
  const created = createLayer(`Layer ${project.layers.length + 1}`);
  insertLayer(project, at, created, parent);
  syncTrackCel(project, at);
  project.currentLayer = at;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Added ${currentLayer().name}`);
}

/**
 * The cel of an animation folder that the ink at a frame goes on.
 *
 * The cels of a track are its child layers. A frame that one of them shows
 * already draws into that cel; an empty frame gets a cel of its own as the
 * first stroke lands - a layer named after the frame, showing on that one
 * frame, the way Clip Studio Paint makes a cel when a frame of an empty
 * animation folder is specified. The selection follows the cel, so the
 * stroke lands where the person drawing sees it.
 *
 * The caller carries the history: the stroke that starts right after this
 * snapshots the document before it, so cel and ink come back out together.
 */
function celForDrawing(trackIndex, frame) {
  const project = state.project;
  const track = project.layers[trackIndex];

  const entry = folderCells(project, trackIndex).get(frame);
  if (entry) {
    project.currentLayer = entry.layer;
    syncLayerControls();
    return project.layers[entry.layer];
  }

  if (project.layers.length >= MAX_LAYERS) {
    setStatus(`At most ${MAX_LAYERS} layers are allowed`, true);
    return null;
  }

  stopPlayback();
  const created = createLayer(`Layer ${project.layers.length + 1}`);
  created.drawings = [
    { at: frame, hold: 1, strokes: [], name: cellName(created, frame) },
  ];
  insertLayer(project, trackIndex + 1, created, trackIndex);
  syncTrackCel(project, trackIndex + 1);
  project.currentLayer = trackIndex + 1;
  renderTimeline();
  renderLayerPanel();
  syncLayerControls();
  setStatus(`Added cel ${created.drawings[0].name} to ${track.name}`);
  return created;
}

/**
 * Add an animation folder: a track of the timeline.
 *
 * The folder is put above the current layer and the current layer goes
 * inside it as its first cel, the way a new animation folder of Clip Studio
 * Paint takes the layer it is made from. The cells of the track are the
 * cels; drawing on one of them puts a cell on the row of the folder.
 */
function addAnimationFolder() {
  const project = state.project;
  if (project.layers.length >= MAX_LAYERS) {
    setStatus(`At most ${MAX_LAYERS} layers are allowed`, true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const current = project.currentLayer;
  const layer = project.layers[current];
  const parent = layer.parent ?? -1;
  const group = createGroup(`Animation folder ${project.layers.length + 1}`);
  group.animationFolder = true;
  insertLayer(project, current, group, parent);
  // The layer that was selected now sits inside the new folder as its cel.
  project.layers[current + 1].parent = current;
  syncTrackCel(project, current + 1);
  project.currentLayer = current;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Added ${currentLayer().name}`);
}

/**
 * The cel a folder shows on the track it sits in.
 *
 * A folder inside an animation folder is a cel of that track: it shows as
 * one cell on the row of the track, the way a folder dropped on the timeline
 * of Clip Studio Paint lands there. The cell carries no picture - the layers
 * inside the folder make the picture - so the folder records where the cel
 * sits, and forgets it when it leaves the track. A drawing layer that
 * becomes a cel plays the way a cel plays: it holds until the next cel and
 * shows nothing after the last one.
 */
function syncTrackCel(project, index) {
  const layer = project.layers[index];
  if (!layer) return;
  if (insideAnimationFolder(project, index)) {
    if (!isGroup(layer)) {
      layer.postBehavior = "none";
      return;
    }
    layer.preBehavior = "none";
    layer.postBehavior = "none";
    if (!(layer.drawings ?? []).length) {
      layer.drawings = [
        { at: project.currentFrame, hold: 1, strokes: [], name: layer.name },
      ];
    }
  } else if (isGroup(layer) && layer.animationFolder !== true) {
    layer.drawings = (layer.drawings ?? []).filter(
      (drawing) => (drawing.strokes?.length ?? 0) > 0 || drawing.image,
    );
  }
}

/**
 * How wide one column of frames is, in pixels.
 *
 * Every frame gets a column of the same fixed width, the way MoArt gives
 * every frame a fixed width, so the numbers of the ruler stand in a row
 * above the frames they belong to. The width is set on the timeline and
 * read back here.
 */
function timelineCellWidth() {
  const min = parseFloat(getComputedStyle(timelineEl).getPropertyValue("--tl-cell-min")) || 18;
  return min;
}

/**
 * The width a column needs to hold the number of a frame.
 *
 * The numbers of the ruler are monospace, so every digit is the same width
 * and the widest number decides how wide the column has to be.
 */
function frameNumberWidth(digits) {
  return 2 + digits * 5.6 + 1;
}

/**
 * The rows whose cells wait for the viewport.
 *
 * Building on the scroll of the pane, not on an observer: the scroll of the
 * timeline is the only thing that changes which rows are on screen, and a
 * builder driven by it works the same on every machine. The scan runs at
 * most a few times a second, and only over the rows that still wait.
 */
let pendingTimelineRows = [];
let timelineBuildTimer = 0;

function watchTimelineRow(row, build) {
  pendingTimelineRows.push({ row, build });
}

/** Build the cells of every waiting row that is on screen or close to it. */
function buildNearbyTimelineRows() {
  if (!pendingTimelineRows.length) return;
  const scroll = timelineEl.closest(".timeline-scroll");
  if (!scroll) return;
  const bounds = scroll.getBoundingClientRect();
  const top = bounds.top - 480;
  const bottom = bounds.bottom + 480;
  const stillWaiting = [];
  for (const item of pendingTimelineRows) {
    const rect = item.row.getBoundingClientRect();
    if (rect.bottom >= top && rect.top <= bottom) item.build();
    else stillWaiting.push(item);
  }
  pendingTimelineRows = stillWaiting;
}

/** Ask for a build soon; the calls of one scroll land in one build. */
function scheduleTimelineBuild() {
  if (timelineBuildTimer) return;
  timelineBuildTimer = setTimeout(() => {
    timelineBuildTimer = 0;
    buildNearbyTimelineRows();
  }, 120);
}

timelineEl.closest(".timeline-scroll")?.addEventListener("scroll", scheduleTimelineBuild, {
  passive: true,
});
// A pointer over the pane is about to become an interaction with a row, and
// the rows near it are built for it - this also covers the cases where the
// pane moved its rows without a scroll of its own.
timelineEl.closest(".timeline-scroll")?.addEventListener("pointerdown", scheduleTimelineBuild, {
  passive: true,
});
timelineEl.closest(".timeline-scroll")?.addEventListener("pointermove", scheduleTimelineBuild, {
  passive: true,
});
// A pane that is made taller shows rows it did not before.
new ResizeObserver(scheduleTimelineBuild).observe(
  timelineEl.closest(".timeline-scroll") ?? timelineEl,
);

/** The buttons of one row of the timeline, from the first frame to the last. */
function buildLayerRowCells(cells, project, layer, index, columns, start) {
  // A folder shows the cells of the layers inside it, the way an animation
  // folder shows the cells of an animation.
  const folder = isGroup(layer) ? folderCells(project, index) : null;

  for (let i = 0; i < columns; i += 1) {
    const frame = start + i;
    const info = exposureInfo(layer, frame);
    const cell = element("button", `tl-cell ${info.kind}`);
    cell.dataset.frame = String(frame);
    cell.type = "button";
    // Every cell is placed by hand, so the column of the playhead can sit
    // over the row.
    cell.style.gridColumn = `${i + 1} / span 1`;
    cell.style.gridRow = "1";
    if (frame === project.currentFrame) cell.classList.add("current");
    if (i === 0) cell.classList.add("first");

    let owner = index;
    if (folder) {
      const entry = folder.get(frame);
      if (!entry) {
        cell.textContent = "";
        cell.title = `Empty frame ${frame}`;
        // Clicking an empty frame of a track only selects it. The cel is
        // made when ink goes down on the frame, so that walking the
        // timeline does not leave cells behind on every frame it passes.
        cell.addEventListener("click", () => selectFrame(frame, index));
        cells.append(cell);
        continue;
      }
      owner = entry.layer;
      cell.classList.remove(info.kind);
      cell.classList.add(entry.name ? "head" : "hold");
      cell.textContent = (state.showCellNames && entry.name) || "●";
      cell.title = entry.name
        ? `Cell "${entry.name}" on frame ${frame} — ${entry.count} frame${entry.count === 1 ? "" : "s"}`
        : `Held frame — ${entry.remaining} of ${entry.count} remaining`;
      cell.addEventListener("click", () => selectFrame(frame, owner));
      // The head of a cell is the frame where nothing of it is left, so it
      // is the frame where the whole cell is still to come.
      addCellHandles(
        cell,
        entry.layer,
        frame,
        entry.remaining === 1,
        entry.remaining === entry.count,
      );
      cells.append(cell);
      continue;
    }

    if (info.kind === "head") {
      const drawing = info.drawing;
      const label = state.showCellNames ? drawing?.name : null;
      cell.textContent = label || "●";
      cell.title = label
        ? `Cell "${label}" — ${info.count} frame${info.count === 1 ? "" : "s"}`
        : `Drawing starts here — ${info.count} frame${info.count === 1 ? "" : "s"}`;
    } else if (info.kind === "hold") {
      cell.textContent = "·";
      cell.title = `Held frame — ${info.remaining} of ${info.count} remaining`;
    } else if (info.kind === "virtual") {
      cell.textContent = "◌";
      cell.title = `Pre/post behaviour shows frame ${info.sourceFrame}`;
    } else {
      cell.textContent = "";
      cell.title = `Empty frame ${frame}`;
    }

    cell.addEventListener("click", () => selectFrame(frame, index));
    cell.addEventListener("dblclick", (event) => {
      event.preventDefault();
      renameCell(index, frame);
    });
    addCellHandles(cell, index, frame, info.remaining === 1, info.kind === "head");
    cells.append(cell);
  }

  appendPlayhead(cells, project, columns, start);
}

function renderTimeline() {
  const project = state.project;
  const columns = timelineColumnCount();
  const start = project.startFrame;

  // The rows of the last build are gone; the waiting list starts over.
  pendingTimelineRows = [];

  timelineEl.replaceChildren();

  const header = element("div", "tl-header");
  const corner = element("div", "tl-corner");
  const cornerName = element("span", "tl-corner-name", "Timeline 1");
  corner.title = "The frames of the timeline";
  corner.append(cornerName, element("span", "tl-corner-caret", "▾"));
  header.append(corner);

  const ruler = element("div", "tl-ruler");
  ruler.style.setProperty("--frames", String(columns));

  // The keys of the timeline sit above the frame numbers, the way Clip
  // Studio Paint draws them.
  const keys = element("div", "tl-keys");
  keys.style.setProperty("--frames", String(columns));
  if (state.showKeyMarkers) {
    for (const key of keyframes(project)) {
      const column = key - start + 1;
      if (column < 1 || column > columns) continue;
      // The frame the playhead is on is marked by the red triangle below, so
      // its key carries no number of its own.
      const current = key === project.currentFrame;
      const marker = element("div", `tl-key${current ? " current" : ""}`, current ? "" : String(key));
      marker.style.gridColumn = `${column} / span 1`;
      marker.title = `Key on frame ${key}`;
      marker.addEventListener("click", () => selectFrame(key));
      keys.append(marker);
    }
  }

  // The red triangle that says where the playhead is. It sits over the frame
  // the playhead is on and is shown whether the keys are shown or not.
  const markColumn = project.currentFrame - start + 1;
  if (markColumn >= 1 && markColumn <= columns) {
    const mark = element("div", "tl-playhead-mark");
    mark.style.gridColumn = `${markColumn} / span 1`;
    keys.append(mark);
  }
  ruler.append(keys);

  const numbers = element("div", "tl-numbers");
  numbers.style.setProperty("--frames", String(columns));
  // The number of every frame is written, the way MoArt writes them, so the
  // ruler reads as one scale. A column that is too narrow to hold the number
  // leaves it out, and only every few frames are written then.
  const last = start + columns - 1;
  const digits = String(Math.max(1, last)).length;
  const needed = frameNumberWidth(digits);
  // A column is never narrower than the number it has to hold.
  const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tl-cell-base")) || 18;
  timelineEl.style.setProperty("--tl-cell-min", `${Math.max(base, Math.ceil(needed))}px`);
  const roomy = timelineCellWidth() >= needed;
  for (let i = 0; i < columns; i += 1) {
    const frame = start + i;
    const current = frame === project.currentFrame;
    const major = frame % 5 === 0 || frame === last;
    const showNumber = roomy || major || current;
    const cell = element("div", `tl-number${current ? " current" : ""}`, showNumber ? String(frame) : "");
    cell.title = `Frame ${frame}`;
    numbers.append(cell);
  }
  ruler.append(numbers);
  header.append(ruler);
  timelineEl.append(header);

  timelineEl.append(renderCameraRow(columns, start));

  for (const index of visibleLayers(project)) {
    const layer = project.layers[index];
    const depth = layerDepth(project, index);
    const row = element("div", "tl-row");
    row.dataset.layer = String(index);
    row.style.setProperty("--depth", String(depth));
    if (index === project.currentLayer) row.classList.add("selected");

    const head = element("div", "tl-head");

    if (isGroup(layer) && !isAnimationFolder(layer)) {
      const toggle = iconButton(
        "tl-icon tl-fold",
        state.collapsed.has(layer.name) ? "i-fold-closed" : "i-fold-open",
        state.collapsed.has(layer.name) ? "Open this folder" : "Close this folder",
      );
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFolder(layer.name);
      });
      head.append(toggle);
    }

    const visibility = iconButton(
      "tl-icon",
      layer.visible ? "i-eye" : "i-eye-off",
      layer.visible ? "Hide layer" : "Show layer",
    );
    visibility.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleVisibility(index);
    });

    // A folder, a drawing layer or the picture that was imported.
    const kind = element("span", `tl-kind${isGroup(layer) ? " folder" : ""}`, isGroup(layer) ? "▤" : "▦");
    kind.title = isGroup(layer) ? "A folder that holds other layers" : "A drawing layer";

    const name = element("button", "tl-name", layer.name);
    if (isAnimationFolder(layer)) {
      const count = childrenOf(project, index).length;
      name.textContent = `${layer.name} : ${count} : cel`;
      name.title = `Animation folder with ${count} cel${count === 1 ? "" : "s"} (double-click to rename)`;
    } else if (isGroup(layer)) {
      const count = childrenOf(project, index).length;
      name.textContent = `${layer.name} : ${count}`;
      name.title = `Folder with ${count} layer${count === 1 ? "" : "s"} (double-click to rename)`;
    } else {
      name.title = "Select this layer (double-click to rename)";
    }
    name.addEventListener("click", () => selectLayer(index));
    name.addEventListener("dblclick", (event) => {
      event.preventDefault();
      renameLayer(index);
    });

    const lock = iconButton(
      "tl-icon",
      layer.locked ? "i-lock" : "i-unlock",
      layer.locked ? "Unlock layer" : "Lock layer",
    );
    lock.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleLock(index);
    });

    head.append(visibility, kind, name, lock);

    if (layer.clip) {
      const clip = element("span", "tl-clip", "✂");
      clip.title = "This layer is cut by the layer below it";
      head.append(clip);
    }

    // The button that adds a layer next to this one, the way Clip Studio
    // Paint has one on every row of its layer palette.
    const add = element("button", "tl-add", "+");
    add.title = isGroup(layer)
      ? "Add a layer inside this folder"
      : "Add a layer above this one";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      addLayerBeside(index);
    });
    head.append(add);

    // Clicking the row selects the layer; the eye, the fold button and the
    // add button stop their own clicks, so a press on one is never taken for
    // a click on the row.
    head.addEventListener("click", (event) => {
      if (event.target.closest(".tl-icon, .tl-add")) return;
      selectLayer(index);
    });
    // The row can be dragged to another place in the list.
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".tl-icon, .tl-add")) return;
      startLayerDrag(event, index);
    });

    const cells = element("div", "tl-cells");
    cells.style.setProperty("--frames", String(columns));
    if (!state.showCellNames) cells.classList.add("no-names");
    // The cells of a row are built when the row comes near the screen. A
    // document from Clip Studio carries hundreds of layers, and building a
    // button for every frame of every one of them held the page for seconds
    // on every change. The head is built at once, so the row keeps its
    // height while its cells wait.
    cells.classList.add("pending");
    watchTimelineRow(row, () => {
      buildLayerRowCells(cells, project, layer, index, columns, start);
      cells.classList.remove("pending");
    });

    row.append(head, cells);
    timelineEl.append(row);
  }

  if (project.image) {
    const row = element("div", "tl-row");
    const head = element("div", "tl-head");
    head.append(element("div", "tl-image-head", "📷 Imported image"));
    const cells = element("div", "tl-cells");
    cells.style.setProperty("--frames", String(columns));
    for (let i = 0; i < columns; i += 1) {
      const cell = element("button", "tl-cell image");
      cell.disabled = true;
      cell.style.gridColumn = `${i + 1} / span 1`;
      cell.style.gridRow = "1";
      cell.title = "Read-only .clip preview (behind every layer)";
      cells.append(cell);
    }
    appendPlayhead(cells, project, columns, start);
    row.append(head, cells);
    timelineEl.append(row);
  }

  const audioRow = renderAudioRow(columns, start);
  if (audioRow) timelineEl.append(audioRow);

  // The empty area under the rows, with the columns of the frames in it.
  const grid = element("div", "tl-grid-bg");
  grid.append(element("div", "tl-grid-head"));
  const lines = element("div", "tl-grid-lines");
  lines.style.setProperty("--frames", String(columns));
  for (let i = 0; i < columns; i += 1) {
    const line = element("div", "tl-grid-line");
    line.style.gridColumn = `${i + 1} / span 1`;
    line.style.gridRow = "1";
    lines.append(line);
  }
  grid.append(lines);
  timelineEl.append(grid);

  // The rows near the screen are built now; the rest wait for a scroll.
  buildNearbyTimelineRows();
  // The build carries the playhead of this very frame; the next move of the
  // playhead only has to change the column it steps onto.
  state.playheadFrame = project.currentFrame;
  updatePlayhead();
  updateFrameReadout();
}

/* ------------------------------------------------------- the layers panel */

/**
 * A small picture of what a layer holds.
 *
 * A layer that came from a `.clip` has a picture, and that is shown as it
 * is. A layer that was drawn here has strokes, and they are drawn small.
 */
function layerThumbnail(project, index) {
  const layer = project.layers[index];
  const size = 22;
  const canvas = element("canvas", "layer-thumb");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // The transparency of the layer is shown as a checkerboard, the way
  // Clip Studio Paint shows it.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#d8d8d8";
  for (let y = 0; y < size; y += 5) {
    for (let x = 0; x < size; x += 5) {
      if (((x / 5) + (y / 5)) % 2 === 0) ctx.fillRect(x, y, 5, 5);
    }
  }

  const drawing = drawingAt(layer, project.currentFrame) ?? layer.drawings?.[0] ?? null;
  if (!drawing) return canvas;

  const base = drawingImageElement(drawing);
  if (base) {
    // A trimmed picture sits in its box on the canvas, so it is placed
    // where that box falls in the tile, not stretched over the whole of it.
    const scaleX = size / project.width;
    const scaleY = size / project.height;
    const [originX, originY] = cellBaseOrigin(drawing);
    const [baseWidth, baseHeight] = cellBaseSize(project, drawing);
    ctx.drawImage(base, originX * scaleX, originY * scaleY, baseWidth * scaleX, baseHeight * scaleY);
    return canvas;
  }

  // The strokes of the layer, drawn small enough to fit.
  const points = [];
  for (const stroke of drawing.strokes ?? []) {
    for (const point of stroke.points ?? []) points.push(point);
    for (const path of stroke.paths ?? []) for (const point of path) points.push(point);
  }
  if (!points.length) return canvas;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = (size - 2) / span;
  const offsetX = (size - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = (size - (maxY - minY) * scale) / 2 - minY * scale;

  ctx.strokeStyle = layer.color ?? "#1f2937";
  ctx.lineWidth = Math.max(1, scale * 2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of drawing.strokes ?? []) {
    if (stroke.kind === "paths") {
      // A filled region of several contours: fill it the way the canvas does.
      ctx.beginPath();
      for (const path of stroke.paths ?? []) {
        if (!path || path.length < 2) continue;
        ctx.moveTo(path[0][0] * scale + offsetX, path[0][1] * scale + offsetY);
        for (let i = 1; i < path.length; i += 1) {
          ctx.lineTo(path[i][0] * scale + offsetX, path[i][1] * scale + offsetY);
        }
        ctx.closePath();
      }
      ctx.fillStyle = stroke.color ?? layer.color ?? "#1f2937";
      ctx.fill();
      continue;
    }
    if (!stroke.points?.length) continue;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0] * scale + offsetX, stroke.points[0][1] * scale + offsetY);
    for (let i = 1; i < stroke.points.length; i += 1) {
      ctx.lineTo(stroke.points[i][0] * scale + offsetX, stroke.points[i][1] * scale + offsetY);
    }
    // A closed contour is a region, not a line.
    if (stroke.kind === "path") {
      ctx.closePath();
      ctx.fillStyle = stroke.color ?? layer.color ?? "#1f2937";
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
  return canvas;
}

/**
 * The layers panel: the layers and the folders that hold them.
 *
 * The tree is drawn the way Clip Studio Paint draws it - a folder can be
 * opened and closed, a layer is shown or hidden, and the layer that is
 * being worked on is marked.
 */
function renderLayerPanel() {
  const project = state.project;
  layerTreeEl.replaceChildren();

  for (const index of layerTree(project)) {
    // A folder that is closed hides the layers inside it, the way the
    // timeline hides the rows of a closed folder.
    const hidden = ancestorsOf(project, index).some((at) =>
      state.collapsed.has(project.layers[at].name),
    );
    if (hidden) continue;

    const layer = project.layers[index];
    const folder = isGroup(layer);
    const depth = layerDepth(project, index);
    const collapsed = folder && state.collapsed.has(layer.name);

    const row = element("div", "layer-row");
    row.dataset.layer = String(index);
    row.style.setProperty("--depth", String(depth));
    if (index === project.currentLayer) row.classList.add("selected");

    // A folder can be opened and closed. A layer has nothing there, but
    // the space is kept so the names of the layers line up.
    const fold = iconButton(
      "layer-fold",
      collapsed ? "i-fold-closed" : "i-fold-open",
      collapsed ? "Open this folder" : "Close this folder",
    );
    if (folder) {
      fold.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFolder(layer.name);
      });
    } else {
      fold.classList.add("layer-fold-blank");
      fold.disabled = true;
      fold.tabIndex = -1;
    }
    row.append(fold);

    const eye = iconButton(
      "layer-eye",
      layer.visible ? "i-eye" : "i-eye-off",
      layer.visible ? "Hide this layer" : "Show this layer",
    );
    eye.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleVisibility(index);
    });
    row.append(eye);

    row.append(layerThumbnail(project, index));

    // The name of the layer, and under it what is set on it, the way
    // Clip Studio Paint shows a row: the opacity and the way it is blended.
    const percent = Math.round((layer.opacity ?? 1) * 100);
    const count = childrenOf(project, index).length;
    const text = element("div", "layer-text");

    const name = element("button", "layer-name", folder ? `${layer.name} : ${count}` : layer.name);
    name.title = folder
      ? `Folder with ${count} layer(s) (double-click to rename)`
      : "Select this layer (double-click to rename)";
    name.addEventListener("click", (event) => {
      event.stopPropagation();
      selectLayer(index);
    });
    name.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      renameLayer(index);
    });

    const detail = element("div", "layer-detail");
    detail.textContent = folder
      ? `${percent}%`
      : `${percent}% · ${layer.blend === "normal" ? "Normal" : layer.blend}`;

    text.append(name, detail);
    row.append(text);

    if (index === project.currentLayer) {
      row.append(element("span", "layer-current", "✎"));
    }

    // Clicking anywhere on the row selects the layer - the thumbnail, the
    // name and the space beside them - the way a row of Clip Studio Paint
    // works. The eye and the fold button stop their own clicks.
    row.addEventListener("click", () => selectLayer(index));
    // A layer can be dragged to another place, and onto a folder, which
    // puts it inside. A press on a control belongs to the control, not to
    // the drag.
    row.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".layer-eye, .layer-fold, input")) return;
      startLayerDrag(event, index, [...layerTreeEl.querySelectorAll(".layer-row")]);
    });

    layerTreeEl.append(row);
  }

  syncLayerPanelControls();
}

/** The row of controls shows the layer that is being worked on. */
function syncLayerPanelControls() {
  const project = state.project;
  const layer = project.layers[project.currentLayer];
  if (!layer) return;

  const folder = isGroup(layer);
  const parent = layer.parent ?? -1;

  layerKindSelect.value = folder ? "group" : "anim";
  const percent = Math.round((layer.opacity ?? 1) * 100);
  layerOpacityInput.value = String(percent);
  layerOpacityOut.textContent = String(percent);
  layerLockButton.setAttribute("aria-pressed", layer.locked ? "true" : "false");
  layerLockButton.textContent = layer.locked ? "🔒" : "🔓";
  layerLockButton.title = layer.locked ? "Unlock this layer" : "Lock this layer";
  layerKindSelect.title = folder ? "This layer is a folder" : "This layer holds drawings";

  // The buttons say what they will do to the layer that is selected.
  const siblings = childrenOf(project, parent);
  const position = siblings.indexOf(project.currentLayer);
  const up = position > 0;
  const down = position >= 0 && position < siblings.length - 1;

  panelLayerUpButton.disabled = !up;
  panelLayerDownButton.disabled = !down;
  panelLayerUpButton.title = up
    ? `Move ${layer.name} up among the ${siblings.length} layer(s) beside it`
    : "There is no layer above this one";
  panelLayerDownButton.title = down
    ? `Move ${layer.name} down among the ${siblings.length} layer(s) beside it`
    : "There is no layer below this one";

  panelUnfoldButton.disabled = parent < 0;
  panelUnfoldButton.title = parent < 0
    ? "This layer is not in a folder"
    : `Take ${layer.name} out of the folder it is in`;

  panelAddLayerButton.title = folder
    ? `Add a layer inside ${layer.name}`
    : "Add a drawing layer";
  // A new folder is put around the layer that is selected, so the layer
  // goes inside it. For a folder that makes a folder inside a folder.
  panelAddFolderButton.title = `Add a folder around ${layer.name}`;
  panelDeleteLayerButton.disabled = project.layers.length <= 1;
  panelDeleteLayerButton.title = folder
    ? `Delete ${layer.name} and the layers inside it`
    : `Delete ${layer.name}`;

  panelAddAnimationFolderButton.title = `Start an animation folder at ${layer.name}`;
  panelDuplicateLayerButton.disabled = project.layers.length >= MAX_LAYERS;
  panelDuplicateLayerButton.title = folder
    ? `Duplicate ${layer.name} and the layers inside it`
    : `Duplicate ${layer.name}`;
}

/** The sound row: the name, a remove button and the waveform. */
function renderAudioRow(columns, start) {
  const project = state.project;
  if (!project.audio) return null;

  const row = element("div", "tl-row audio-row");

  const head = element("div", "tl-head");
  const name = element("button", "tl-name", `🔊 ${project.audio.name}`);
  name.title = "The sound that plays with the animation";
  name.addEventListener("click", () => {
    setStatus(
      `Sound "${project.audio.name}" — ${project.audio.duration.toFixed(1)} seconds ` +
        `from frame ${Math.round(project.startFrame + project.audio.offset * project.fps)}`,
    );
  });

  const remove = element("button", "tl-icon", "✕");
  remove.title = "Remove the sound";
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    removeAudio();
  });
  head.append(name, remove);

  const cells = element("div", "tl-cells");
  cells.style.setProperty("--frames", String(columns));
  const cell = element("div", "tl-cell audio-wave-cell");
  cell.style.gridColumn = "1 / -1";

  // The waveform is a picture, so it scales with the timeline without
  // needing a layout pass.
  const picture = audioWaveformPicture(columns, start);
  if (picture) cell.style.backgroundImage = `url(${picture})`;

  cells.append(cell);
  appendPlayhead(cells, project, columns, start);
  row.append(head, cells);
  return row;
}

/** Draw the sound's peaks as a picture, one column per timeline frame. */
function audioWaveformPicture(columns, start) {
  const project = state.project;
  const peaks = state.audioPeaks;
  if (!project.audio || !peaks || peaks.length === 0) return null;

  const width = Math.max(1, Math.min(4000, columns * 8));
  const height = 26;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  context.fillStyle = "rgba(63, 163, 236, 0.65)";

  const soundStart = project.startFrame + project.audio.offset * project.fps;
  const middle = height / 2;
  const columnWidth = width / columns;
  for (let index = 0; index < peaks.length; index += 1) {
    const seconds = (index / peaks.length) * project.audio.duration;
    const column = soundStart + seconds * project.fps - start;
    if (column < 0 || column > columns) continue;
    const bar = Math.max(1, peaks[index] * (height - 6));
    context.fillRect(column * columnWidth, middle - bar / 2, Math.max(1, columnWidth - 1), bar);
  }
  return canvas.toDataURL("image/png");
}

function updatePlayhead() {
  const project = state.project;
  const previous = state.playheadFrame ?? null;
  const current = project.currentFrame;
  for (const row of timelineEl.querySelectorAll(".tl-row[data-layer]")) {
    row.classList.toggle("selected", Number(row.dataset.layer) === project.currentLayer);
  }
  // Only the columns the playhead moved between change: walking every cell
  // of every row on every step of the playhead cost more than the frame
  // itself on a document with hundreds of rows.
  const selector =
    previous === null || previous === current
      ? `.tl-cell[data-frame="${current}"]`
      : `.tl-cell[data-frame="${previous}"], .tl-cell[data-frame="${current}"]`;
  for (const cell of timelineEl.querySelectorAll(selector)) {
    cell.classList.toggle("current", Number(cell.dataset.frame) === current);
  }
  state.playheadFrame = current;
}

/**
 * The numbers in the corner of the timeline: the frame that is shown, the
 * first frame and the last one, the way Clip Studio Paint writes them.
 */
function updateFrameReadout() {
  const project = state.project;
  if (!frameReadout) return;
  const last = Math.max(project.startFrame, contentEnd(project));
  frameReadout.textContent = `${project.currentFrame} / ${project.startFrame} / ${last}`;
  frameReadout.title =
    `Frame ${project.currentFrame} of ${project.startFrame} to ${last} at ${project.fps} fps`;
}

function syncLayerControls() {
  const project = state.project;
  const layer = currentLayer();
  if (!layer) return;

  layerNameInput.value = layer.name;
  opacityInput.value = String(Math.round(layer.opacity * 100));
  opacityValue.textContent = `${Math.round(layer.opacity * 100)}%`;
  preBehaviorInput.value = layer.preBehavior;
  postBehaviorInput.value = layer.postBehavior;
  fpsInput.value = String(project.fps);
  startFrameInput.value = String(project.startFrame);
  // The length of the document is the frame its last drawing reaches.
  frameCountInput.value = String(Math.max(project.startFrame, contentEnd(project)));
  loopInput.checked = project.loop;

  const folder = isGroup(layer);
  clipLayerInput.checked = Boolean(layer.clip);
  clipLayerInput.disabled = folder;
  removeGroupButton.disabled = !folder;

  const info = folder ? { kind: "empty", count: 0 } : exposureInfo(layer, project.currentFrame);
  const editable = info.kind === "head" || info.kind === "hold";
  exposureInput.value = String(info.count || 1);
  exposureInput.disabled = !editable;
  clearButton.disabled = !editable;
  duplicateFrameButton.disabled = !editable;
  holdButton.disabled = !editable;
  deleteFrameButton.disabled = !editable;
  addFrameButton.disabled = folder;

  // The transform of the cell that is on the frame: where its picture sits,
  // how big it is and how far it is turned.
  const cell = folder ? null : resolveDrawing(layer, project.currentFrame)?.drawing ?? null;
  const transform = transformOf(cell);
  transformXInput.value = String(Math.round(transform.x));
  transformYInput.value = String(Math.round(transform.y));
  transformScaleInput.value = String(Math.round(transform.scale * 100));
  transformScaleValue.textContent = `${Math.round(transform.scale * 100)}%`;
  transformRotationInput.value = String(Math.round(transform.rotation));
  const canTransform = Boolean(cell);
  transformXInput.disabled = !canTransform;
  transformYInput.disabled = !canTransform;
  transformScaleInput.disabled = !canTransform;
  transformRotationInput.disabled = !canTransform;
  transformResetButton.disabled = !canTransform;

  deleteLayerButton.disabled = project.layers.length <= 1;
  const siblings = childrenOf(project, layer.parent ?? -1);
  const position = siblings.indexOf(project.currentLayer);
  layerUpButton.disabled = position <= 0;
  layerDownButton.disabled = position < 0 || position >= siblings.length - 1;

  syncCameraControls();
}

/**
 * The frame of the cel the track of a layer shows.
 *
 * Clicking a layer in the palette selects its track, and the playhead goes
 * to a cel of that track, the way Clip Studio Paint puts the playhead on
 * the cel of the track that was chosen. A frame the track already shows a
 * picture on is kept, so the artist stays where they are; a frame in a gap
 * goes to the cel nearest to it - the earlier one when two are equally
 * near. A layer with no cel leaves the playhead alone.
 */
function nearestCelFrame(project, index, frame) {
  const layer = project.layers[index];
  if (!layer) return frame;

  let covered;
  let starts;
  if (isGroup(layer)) {
    const cells = folderCells(project, index);
    if (!cells.size) return frame;
    covered = (at) => cells.has(at);
    starts = [...cells.keys()];
  } else {
    const drawings = layer.drawings ?? [];
    if (!drawings.length) return frame;
    covered = (at) =>
      drawings.some(
        (drawing) => at >= drawing.at && at < drawing.at + Math.max(1, drawing.hold ?? 1),
      );
    starts = drawings.map((drawing) => drawing.at);
  }
  if (covered(frame)) return frame;

  let best = null;
  for (const at of starts) {
    if (best === null) {
      best = at;
      continue;
    }
    const near = Math.abs(at - frame) < Math.abs(best - frame);
    const tie = Math.abs(at - frame) === Math.abs(best - frame) && at < best;
    if (near || tie) best = at;
  }
  return best;
}

/**
 * Keep the column of the playhead inside the pane.
 *
 * A frame that was reached by choosing a layer can sit past the edge of the
 * timeline, where the artist would not see where the playhead went.
 */
function revealPlayhead() {
  const scroll = timelineEl.closest(".timeline-scroll");
  if (!scroll) return;
  const project = state.project;
  const column = project.currentFrame - project.startFrame;
  const cell = timelineCellWidth();
  const head =
    parseFloat(getComputedStyle(timelineEl).getPropertyValue("--tl-head-w")) || 0;
  const left = head + column * cell;
  const right = left + cell;
  if (left < scroll.scrollLeft + head) {
    scroll.scrollLeft = Math.max(0, left - head);
  } else if (right > scroll.scrollLeft + scroll.clientWidth) {
    scroll.scrollLeft = right - scroll.clientWidth;
  }
}

function selectLayer(index) {
  stopPlayback();
  const project = state.project;
  project.currentLayer = index;
  // The frame follows the cel of the layer that was chosen, the way Clip
  // Studio Paint moves the playhead onto the track that was selected.
  const frame = Math.min(
    MAX_FRAME,
    Math.max(project.startFrame, nearestCelFrame(project, index, project.currentFrame)),
  );
  const moved = frame !== project.currentFrame;
  if (moved) project.currentFrame = frame;
  updatePlayhead();
  syncLayerControls();
  renderLayerPanel();
  if (moved) {
    updateFrameLabel();
    renderCanvas();
    revealPlayhead();
    setStatus(`Layer ${index + 1}: ${currentLayer().name} — frame ${frame}`);
  } else {
    setStatus(`Layer ${index + 1}: ${currentLayer().name}`);
  }
}

function selectFrame(frame, layerIndex) {
  stopPlayback();
  const project = state.project;
  project.currentFrame = Math.min(MAX_FRAME, Math.max(project.startFrame, frame));
  if (layerIndex !== undefined) project.currentLayer = layerIndex;
  updateFrameLabel();
  updatePlayhead();
  syncLayerControls();
  renderCanvas();
  setStatus(`Frame ${project.currentFrame} — ${currentLayer().name}`);
}

/**
 * Go to the first frame of the animation.
 *
 * The timeline has the buttons a timeline needs: the first frame, the frame
 * before the next key, the frame after the last key and the last frame.
 */
function gotoFirstFrame() {
  selectFrame(state.project.startFrame);
}

function gotoLastFrame() {
  const project = state.project;
  const keys = keyframes(project);
  const last = keys.length ? keys[keys.length - 1] : contentEnd(project);
  selectFrame(Math.max(project.startFrame, last));
}

function gotoPreviousKey() {
  const project = state.project;
  const key = previousKeyframe(project, project.currentFrame);
  if (key === null) {
    setStatus("There is no key before this frame");
    return;
  }
  selectFrame(key);
}

function gotoNextKey() {
  const project = state.project;
  const key = nextKeyframe(project, project.currentFrame);
  if (key === null) {
    setStatus("There is no key after this frame");
    return;
  }
  selectFrame(key);
}

function afterChange({ timeline = true, skipRender = false } = {}) {
  clampSelection();
  refreshTitle();
  syncLayerControls();
  renderLayerPanel();
  if (timeline) renderTimeline();
  else updatePlayhead();
  updateFrameLabel();
  if (!skipRender) renderCanvas();
  updateHistoryButtons();
}

/* ------------------------------------------------------------ edit actions */

function toggleVisibility(index) {
  stopPlayback();
  const layer = state.project.layers[index];
  const before = snapshot();
  layer.visible = !layer.visible;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`${layer.name} ${layer.visible ? "shown" : "hidden"}`);
}

function toggleLock(index) {
  stopPlayback();
  const layer = state.project.layers[index];
  const before = snapshot();
  layer.locked = !layer.locked;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`${layer.name} ${layer.locked ? "locked" : "unlocked"}`);
}

function renameLayer(index) {
  const layer = state.project.layers[index];
  const value = prompt("Layer name", layer.name);
  if (value === null) return;

  const name = value.trim();
  if (!name) {
    setStatus("Layer name cannot be empty", true);
    return;
  }
  if (name === layer.name) return;

  const before = snapshot();
  layer.name = name.slice(0, 80);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Renamed layer to ${layer.name}`);
}

/**
 * Add a layer.
 *
 * The new layer goes above the current one, or inside it when the current
 * layer is a folder.
 */
function addLayer() {
  const project = state.project;
  if (project.layers.length >= MAX_LAYERS) {
    setStatus(`At most ${MAX_LAYERS} layers are allowed`, true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const current = project.currentLayer;
  const layer = project.layers[current];
  const inside = isGroup(layer);
  const parent = inside ? current : (layer.parent ?? -1);
  const index = inside ? current + 1 : current;
  const created = createLayer(`Layer ${project.layers.length + 1}`);
  insertLayer(project, index, created, parent);
  syncTrackCel(project, index);
  project.currentLayer = index;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Added ${currentLayer().name}`);
}

/**
 * Add a folder.
 *
 * The folder is put above the current layer and the current layer goes
 * inside it, the way a folder is made in Clip Studio Paint.
 */
function addGroup() {
  const project = state.project;
  if (project.layers.length >= MAX_LAYERS) {
    setStatus(`At most ${MAX_LAYERS} layers are allowed`, true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const current = project.currentLayer;
  const layer = project.layers[current];
  const parent = layer.parent ?? -1;
  const group = createGroup(`Folder ${project.layers.length + 1}`);
  insertLayer(project, current, group, parent);
  // The layer that was selected now sits inside the new folder.
  project.layers[current + 1].parent = current;
  // A folder that landed inside an animation folder is a cel of its track,
  // and so is the layer that went inside it.
  syncTrackCel(project, current);
  syncTrackCel(project, current + 1);
  project.currentLayer = current;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Added ${currentLayer().name}`);
}

/**
 * Duplicate the layer that is selected.
 *
 * A folder is copied together with everything inside it, exactly as it is,
 * and the copy is put straight after the original, the way the duplicate
 * button of the Clip Studio Paint layer palette works. The copy is selected
 * so the artist can move it or draw on it at once.
 */
function duplicateLayer() {
  const project = state.project;
  const index = project.currentLayer;
  const layer = project.layers[index];
  if (!layer) return;

  const count = blockSize(project, index);
  if (project.layers.length + count > MAX_LAYERS) {
    setStatus(`At most ${MAX_LAYERS} layers are allowed`, true);
    return;
  }

  stopPlayback();
  const before = snapshot();

  // Take the copies before the list changes, so every source still sits at
  // the index it had.
  const copies = [];
  for (let offset = 0; offset < count; offset += 1) {
    const source = project.layers[index + offset];
    const copy = structuredClone(source);
    copy.name = `${source.name} copy`;
    copies.push({ source: index + offset, layer: copy });
  }

  // Put the copies in from the bottom of the block up, all at the same
  // place after the block. Each insert pushes the copies already there to
  // the right, which leaves the copies in their original order.
  const at = index + count;
  for (let offset = copies.length - 1; offset >= 0; offset -= 1) {
    const { source, layer: copy } = copies[offset];
    insertLayer(project, at, copy, project.layers[source].parent ?? -1);
  }

  // The parent numbers of the copies pointed at the originals. A parent
  // that is part of the copied block now points at its copy instead.
  for (let offset = 0; offset < copies.length; offset += 1) {
    const { source, layer: copy } = copies[offset];
    const parent = project.layers[source].parent ?? -1;
    copy.parent =
      parent >= index && parent < index + count
        ? at + (parent - index)
        : parent;
    syncTrackCel(project, at + offset);
  }

  project.currentLayer = at;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Duplicated ${layer.name}`);
}

/**
 * Take a folder apart.
 *
 * The layers inside it move up to the place the folder had.
 */
function removeGroup() {
  const project = state.project;
  const index = project.currentLayer;
  const layer = project.layers[index];
  if (!isGroup(layer)) {
    setStatus("Select a folder to take apart", true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const children = childrenOf(project, index);
  const parent = layer.parent ?? -1;

  const removed = removeLayers(project, [index]);
  // The children are one row higher now, and they take the place of the
  // folder they were in.
  const newParent = parent === -1 ? -1 : (removed.get(parent) ?? -1);
  const firstChild = children.length ? (removed.get(children[0]) ?? 0) : 0;
  for (const child of children) {
    const at = removed.get(child);
    if (at !== undefined) {
      project.layers[at].parent = newParent;
      syncTrackCel(project, at);
    }
  }
  project.currentLayer = Math.min(firstChild, project.layers.length - 1);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Took ${layer.name} apart — ${children.length} layer(s) moved up`);
}

/**
 * Take a layer out of the folder it is in.
 *
 * The layer moves up to where the folder sits, so it becomes a layer of the
 * same level as the folder. A folder that is taken out carries the layers
 * it holds with it.
 */
function takeOutOfFolder() {
  const project = state.project;
  const index = project.currentLayer;
  const layer = project.layers[index];
  const parent = layer?.parent ?? -1;
  if (!layer || parent < 0) {
    setStatus("This layer is not in a folder", true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const folder = project.layers[parent];
  const grandParent = folder.parent ?? -1;
  const size = blockSize(project, index);

  // The layer is moved to the place the folder has, so it ends up above
  // the folder instead of inside it.
  const indexOf = moveBlock(project, index, size, parent);
  if (!indexOf) return;
  const moved = indexOf.get(layer);
  project.layers[moved].parent = grandParent;
  syncTrackCel(project, moved);
  project.currentLayer = moved;

  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`${layer.name} is out of ${folder.name}`);
}

/** Cut a layer by the picture of the layer below it. */
function toggleClip() {
  const project = state.project;
  const index = project.currentLayer;
  const layer = project.layers[index];
  if (isGroup(layer)) {
    setStatus("A folder cannot be clipped", true);
    return;
  }
  if (layer.clip) {
    const before = snapshot();
    layer.clip = false;
    recordHistory(before);
    markDirty();
    afterChange();
    setStatus(`${layer.name} is no longer clipped`);
    return;
  }
  const source = clipSourceOf(project, index);
  if (source < 0) {
    setStatus("There is no layer below to clip this one to", true);
    return;
  }
  const before = snapshot();
  layer.clip = true;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`${layer.name} is clipped to ${project.layers[source].name}`);
}

function deleteLayer() {
  const project = state.project;
  const index = project.currentLayer;
  const layer = project.layers[index];
  const size = blockSize(project, index);
  if (project.layers.length - size < 1) {
    setStatus("At least one layer is required", true);
    return;
  }
  const message =
    size > 1
      ? `Delete folder "${layer.name}" and the ${size - 1} layer(s) inside it?`
      : `Delete layer "${layer.name}" and all of its drawings?`;
  if (!confirm(message)) return;

  stopPlayback();
  const before = snapshot();
  const block = [];
  for (let offset = 0; offset < size; offset += 1) block.push(index + offset);
  const mapping = removeLayers(project, block);
  project.currentLayer = Math.min(index, project.layers.length - 1);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Deleted ${layer.name}`);
}

/**
 * Move the current layer up or down.
 *
 * A layer moves among its siblings, and a folder moves with the layers
 * inside it.
 */
function moveLayer(delta) {
  const project = state.project;
  const index = project.currentLayer;
  const layer = project.layers[index];
  const parent = layer.parent ?? -1;
  const siblings = childrenOf(project, parent);
  const position = siblings.indexOf(index);
  const target = siblings[position + delta];
  if (target === undefined) return;

  stopPlayback();
  const before = snapshot();
  const size = blockSize(project, index);
  const targetSize = blockSize(project, target);
  // Moving down puts the layer below the target one, moving up above it.
  const to = delta < 0 ? target : target - size + targetSize;
  const indexOf = moveBlock(project, index, size, to);
  project.currentLayer = indexOf?.get(layer) ?? index;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Moved ${layer.name} ${delta < 0 ? "up" : "down"}`);
}

/* --------------------------------------------------- dragging layers to reorder */

/** The layer drag that is going on, if any. */
let layerDrag = null;

/**
 * A press that may become a drag.
 *
 * A click on a row selects the layer, so a press is not a drag yet: the
 * pointer has to travel a few pixels before the row is picked up. Without
 * that, the tiny movement of an ordinary click was enough to drop the layer
 * on the row beside it, and the layer the artist clicked jumped away.
 */
let pendingLayerDrag = null;
const LAYER_DRAG_THRESHOLD = 4;

/**
 * Move a layer to a new place in the list.
 *
 * The list is drawn top first, so a smaller index is a higher layer. A
 * folder and the layers inside it are one block, so they move together, and
 * a layer dropped on a folder goes inside it.
 */
function reorderLayer(from, to) {
  const project = state.project;
  if (from === to) return;
  const layer = project.layers[from];
  const target = project.layers[to];
  if (!layer || !target) return;

  stopPlayback();
  const before = snapshot();
  const size = blockSize(project, from);
  const intoFolder = isGroup(target);

  // The block lands above the row it was dropped on, or inside it when
  // that row is a folder.
  const landing = intoFolder
    ? (from < to ? to - size + 1 : to + 1)
    : (from < to ? to - size : to);

  const indexOf = moveBlock(project, from, size, landing);
  if (!indexOf) return;

  const moved = indexOf.get(layer);
  project.layers[moved].parent = intoFolder
    ? (indexOf.get(target) ?? -1)
    : (target.parent ?? -1);
  // A folder that moved into or out of an animation folder gains or drops
  // the cel it shows on the track.
  syncTrackCel(project, moved);

  project.currentLayer = moved;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Moved ${layer.name} to position ${moved + 1} of ${project.layers.length}`);
}

/**
 * Start a drag of a layer row.
 *
 * The list is not rearranged while the pointer is down, because the rows are
 * drawn again after every change and a row that is drawn again cannot keep
 * the pointer. The row under the pointer is marked instead, and the move
 * happens when the button is let go.
 */
function startLayerDrag(event, index, rows = null) {
  // The rows that can be dropped on. The list of layers in the timeline and
  // the one in the layers panel are two views of the same thing, and a
  // drag belongs to the one it started in.
  const list = rows ?? [...timelineEl.querySelectorAll(".tl-row[data-layer]")];
  if (list.length < 2) return;

  pendingLayerDrag = {
    index,
    rows: list,
    startX: event.clientX,
    startY: event.clientY,
  };
  event.preventDefault();
  window.addEventListener("pointermove", onLayerDragMove);
  window.addEventListener("pointerup", onLayerDragEnd, { once: true });
  window.addEventListener("pointercancel", onLayerDragEnd, { once: true });
}

/**
 * Work out which row the pointer is over and mark it.
 *
 * The press only becomes a drag once the pointer has travelled far enough
 * that it cannot be a click, so selecting a layer never moves it.
 */
function onLayerDragMove(event) {
  if (pendingLayerDrag && !layerDrag) {
    const dx = event.clientX - pendingLayerDrag.startX;
    const dy = event.clientY - pendingLayerDrag.startY;
    if (Math.hypot(dx, dy) < LAYER_DRAG_THRESHOLD) return;
    layerDrag = { ...pendingLayerDrag, target: pendingLayerDrag.index };
    for (const row of layerDrag.rows) {
      if (Number(row.dataset.layer) === layerDrag.index) {
        row.classList.add("dragging");
      }
    }
  }
  if (!layerDrag) return;
  const y = event.clientY;
  let target = layerDrag.index;
  for (const row of layerDrag.rows) {
    const box = row.getBoundingClientRect();
    if (y < box.top) {
      target = Number(row.dataset.layer);
      break;
    }
    if (y < box.bottom) {
      target = Number(row.dataset.layer);
      break;
    }
    target = Number(row.dataset.layer);
  }
  if (target === layerDrag.target) return;
  layerDrag.target = target;
  for (const row of layerDrag.rows) {
    row.classList.toggle("drop-target", Number(row.dataset.layer) === target);
  }
}

/** Finish the drag and move the layer if it went somewhere else. */
function onLayerDragEnd() {
  window.removeEventListener("pointermove", onLayerDragMove);
  const drag = layerDrag;
  const press = pendingLayerDrag;
  layerDrag = null;
  pendingLayerDrag = null;
  // A press that never became a drag is a click: the row's click handler
  // selects the layer, and nothing is moved.
  if (!drag) {
    for (const row of press?.rows ?? []) row.classList.remove("dragging");
    return;
  }
  for (const row of drag.rows) row.classList.remove("drop-target", "dragging");
  reorderLayer(drag.index, drag.target);
}

function addDrawing() {
  const layer = currentLayer();
  if (isGroup(layer)) {
    // An animation folder is a track: the button makes a cel on it at the
    // frame being looked at, on purpose - clicking the track only selects.
    if (isAnimationFolder(layer)) {
      const project = state.project;
      const entry = folderCells(project, project.currentLayer).get(project.currentFrame);
      if (entry) {
        const cel = project.layers[entry.layer];
        const celDrawing = cel.drawings.find((d) => d.at === project.currentFrame);
        setStatus(
          `Frame ${project.currentFrame} already has cel ${celDrawing?.name ?? `on ${cel.name}`}`,
        );
        return;
      }
      const before = snapshot();
      if (!celForDrawing(project.currentLayer, project.currentFrame)) return;
      recordHistory(before);
      markDirty();
      afterChange();
      return;
    }
    setStatus("A folder holds other layers - add a layer inside it instead", true);
    return;
  }
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }

  const info = exposureInfo(layer, state.project.currentFrame);
  const added = info.kind === "hold" ? 2 : 1;
  if (!canAddDrawings(state.project, layer, added)) return;

  stopPlayback();
  const before = snapshot();
  // The name is worked out before the cell is added, because the cells that
  // are already on the frame decide the letter.
  const name = cellName(layer, state.project.currentFrame);
  const drawing = insertDrawing(layer, state.project.currentFrame);
  // A new cell is named after the frame it sits on, the way Clip Studio
  // Paint names the cells of an animation folder.
  if (drawing && !drawing.name) drawing.name = name;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Inserted a blank drawing at frame ${state.project.currentFrame}`);
}

/* the cells of the timeline can be moved and made longer ----------------- */

let cellDrag = null;

/**
 * Put the handles of a cell on it.
 *
 * The last frame of a cell carries the handle that makes the cell longer or
 * shorter, the way the edge of a cell is pulled in Clip Studio Paint, and the
 * first frame of a cell is the handle that moves it.
 *
 * @param {Element} cell The cell in the timeline.
 * @param {number} layerIndex The layer the cell belongs to.
 * @param {number} frame The frame the cell is on.
 * @param {boolean} last Whether this is the last frame of the cell.
 * @param {boolean} first Whether this is the first frame of the cell.
 */
function addCellHandles(cell, layerIndex, frame, last, first) {
  if (last) {
    const handle = element("span", "tl-cell-handle");
    handle.title = "Drag to make the cell longer or shorter";
    handle.setAttribute("aria-label", "Make the cell longer or shorter");
    handle.addEventListener("pointerdown", (event) => {
      startCellDrag(event, layerIndex, frame, "resize");
    });
    cell.append(handle);
  }
  if (first) {
    cell.classList.add("movable");
    cell.addEventListener("pointerdown", (event) => {
      startCellDrag(event, layerIndex, frame, "move");
    });
  }
}

/**
 * The frame the pointer is over in a row of the timeline.
 *
 * Every frame has a column of the same width, so the frame is found by
 * counting the columns from the left of the row.
 */
function frameUnderPointer(event, cells) {
  const rect = cells.getBoundingClientRect();
  const width = timelineCellWidth();
  const index = Math.floor((event.clientX - rect.left) / width);
  return state.project.startFrame + index;
}

/** The cells of the row of a layer, as they are drawn now. */
function cellsOfRow(layerIndex) {
  return timelineEl.querySelector(`.tl-row[data-layer="${layerIndex}"] .tl-cells`);
}

/**
 * Start a drag of a cell: moving it to another frame, or making it longer.
 *
 * The timeline is drawn again after every change, so the drag is watched on
 * the window and the cell is found by the frame the pointer is over.
 */
function startCellDrag(event, layerIndex, frame, mode) {
  if (event.button !== 0) return;
  const layer = state.project.layers[layerIndex];
  if (!layer || layer.locked) return;
  const info = exposureInfo(layer, frame);
  if (!info.drawing) return;

  cellDrag = {
    mode,
    layerIndex,
    layer,
    drawing: info.drawing,
    at: info.drawing.at,
    hold: info.drawing.hold,
    startX: event.clientX,
    // The state before the drag, so that the undo puts the cell back.
    before: snapshot(),
  };
  event.preventDefault();
  event.stopPropagation();
  document.body.classList.add("cell-dragging");
  window.addEventListener("pointermove", onCellDragMove);
  window.addEventListener("pointerup", onCellDragEnd, { once: true });
  window.addEventListener("pointercancel", onCellDragEnd, { once: true });
}

/** Move the cell, or make it longer, as the pointer goes. */
function onCellDragMove(event) {
  if (!cellDrag) return;
  const width = timelineCellWidth();
  const delta = Math.round((event.clientX - cellDrag.startX) / width);
  const drawing = cellDrag.drawing;

  if (cellDrag.mode === "move") {
    const target = cellDrag.at + delta;
    if (target < 0 || target === drawing.at) return;
    moveDrawing(cellDrag.layer, drawing.at, target);
  } else {
    const cells = cellsOfRow(cellDrag.layerIndex);
    if (!cells) return;
    const frame = frameUnderPointer(event, cells);
    const hold = Math.max(1, frame - drawing.at + 1);
    if (hold === drawing.hold) return;
    setExposure(cellDrag.layer, drawing.at, hold);
  }
  renderTimeline();
  updatePlayhead();
}

/** Finish the drag and keep the change. */
function onCellDragEnd() {
  window.removeEventListener("pointermove", onCellDragMove);
  if (!cellDrag) return;
  const { mode, drawing, before } = cellDrag;
  cellDrag = null;
  document.body.classList.remove("cell-dragging");
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(
    mode === "move"
      ? `Moved the cell to frame ${drawing.at}`
      : `The cell is now ${drawing.hold} frame${drawing.hold === 1 ? "" : "s"} long`,
  );
}

/**
 * Give a cell a new name.
 *
 * The name is what the timeline shows in the cell, and it is how a cell of
 * an animation folder is recognised, the way Clip Studio Paint names its
 * cells after the frame they sit on.
 */
function renameCell(index, frame) {
  const layer = state.project.layers[index];
  if (!layer || isGroup(layer)) return;
  const info = exposureInfo(layer, frame);
  if (info.kind !== "head" && info.kind !== "hold") {
    setStatus("There is no cell at this frame", true);
    return;
  }

  const value = prompt("Cell name", info.drawing?.name ?? String(frame));
  if (value === null) return;
  const name = value.trim();
  if (name.length > 80) {
    setStatus("A cell name must be 80 characters or fewer", true);
    return;
  }

  const before = snapshot();
  if (name.length === 0) {
    delete info.drawing.name;
  } else {
    info.drawing.name = name;
  }
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(name ? `Renamed the cell to ${name}` : "Removed the cell name");
}

function duplicateFrame() {
  const layer = currentLayer();
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }

  const info = exposureInfo(layer, state.project.currentFrame);
  if (info.kind !== "head" && info.kind !== "hold") {
    setStatus("There is no drawing at this frame", true);
    return;
  }
  if (!canAddDrawings(state.project, layer, 1)) return;

  stopPlayback();
  const before = snapshot();
  const copy = duplicateDrawing(layer, state.project.currentFrame);
  if (!copy) return;
  state.project.currentFrame = copy.at;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Duplicated the drawing to frame ${copy.at}`);
}

function holdFrame() {
  const layer = currentLayer();
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }

  const info = exposureInfo(layer, state.project.currentFrame);
  if (info.kind !== "head" && info.kind !== "hold") {
    setStatus("There is no drawing at this frame", true);
    return;
  }
  if (info.count >= MAX_HOLD) {
    setStatus(`Exposure cannot be longer than ${MAX_HOLD} frames`, true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const drawing = holdDrawing(layer, state.project.currentFrame);
  if (!drawing) return;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Exposure is now ${drawing.hold} frame${drawing.hold === 1 ? "" : "s"}`);
}

function deleteFrame() {
  const layer = currentLayer();
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const removed = deleteDrawing(layer, state.project.currentFrame);
  if (!removed) {
    setStatus("There is no drawing at this frame", true);
    return;
  }
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Deleted the drawing at frame ${removed.at}`);
}

function changeExposure() {
  const layer = currentLayer();
  const info = exposureInfo(layer, state.project.currentFrame);
  if (info.kind !== "head" && info.kind !== "hold") {
    exposureInput.value = "1";
    return;
  }
  if (layer.locked) {
    exposureInput.value = String(info.count);
    setStatus("This layer is locked — unlock it first", true);
    return;
  }

  const value = Number(exposureInput.value);
  if (!Number.isInteger(value) || value < 1 || value > MAX_HOLD) {
    exposureInput.value = String(info.count);
    setStatus(`Exposure must be a whole number from 1 to ${MAX_HOLD}`, true);
    return;
  }
  if (value === info.count) return;

  stopPlayback();
  const before = snapshot();
  setExposure(layer, state.project.currentFrame, value);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Exposure set to ${value} frame${value === 1 ? "" : "s"}`);
}

function changeLayerName() {
  const layer = currentLayer();
  const name = layerNameInput.value.trim();
  if (!name) {
    layerNameInput.value = layer.name;
    setStatus("Layer name cannot be empty", true);
    return;
  }
  if (name === layer.name) return;

  const before = snapshot();
  layer.name = name.slice(0, 80);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Renamed layer to ${layer.name}`);
}

function changeBehavior(which) {
  const layer = currentLayer();
  const input = which === "pre" ? preBehaviorInput : postBehaviorInput;
  const key = which === "pre" ? "preBehavior" : "postBehavior";
  if (input.value === layer[key]) return;

  const before = snapshot();
  layer[key] = input.value;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`${key === "preBehavior" ? "Before-first" : "After-last"} behaviour: ${input.value}`);
}

function changeStartFrame() {
  const project = state.project;
  const value = Number(startFrameInput.value);
  if (!Number.isInteger(value) || value < 1 || value > MAX_START_FRAME) {
    startFrameInput.value = String(project.startFrame);
    setStatus(`Start frame must be a whole number from 1 to ${MAX_START_FRAME}`, true);
    return;
  }
  if (value === project.startFrame) return;

  const delta = value - project.startFrame;
  let lastDrawing = 0;
  for (const layer of project.layers) {
    for (const drawing of layer.drawings) lastDrawing = Math.max(lastDrawing, drawing.at);
  }
  if (lastDrawing + delta > MAX_FRAME) {
    startFrameInput.value = String(project.startFrame);
    setStatus("That start frame would move a drawing past the maximum frame", true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  shiftStartFrame(project, value);
  if (project.currentFrame > MAX_FRAME) project.currentFrame = MAX_FRAME;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Timeline starts at frame ${project.startFrame}`);
}

function changeFps() {
  const project = state.project;
  const value = Number(fpsInput.value);
  if (!Number.isFinite(value) || value < 1 || value > 120) {
    fpsInput.value = String(project.fps);
    setStatus("FPS must be between 1 and 120", true);
    return;
  }
  if (value === project.fps) return;

  const wasPlaying = state.playing;
  if (wasPlaying) stopPlayback();
  const before = snapshot();
  project.fps = value;
  recordHistory(before);
  markDirty();
  if (wasPlaying) startPlayback();
  setStatus(`Playback speed: ${value} fps`);
}

/**
 * Make the document shorter or longer.
 *
 * The length of a document is the frame its last drawing reaches, so a
 * shorter document means the drawings at the end are cut short there. The
 * drawings that start after the last frame are taken away, because nothing
 * can show them any more.
 */
function changeFrameCount() {
  const project = state.project;
  const last = Math.max(project.startFrame, contentEnd(project));
  const value = Number(frameCountInput.value);
  if (!Number.isInteger(value) || value < project.startFrame || value > MAX_FRAME) {
    frameCountInput.value = String(last);
    setStatus(`The document has ${last} frames`, true);
    return;
  }
  if (value === last) {
    frameCountInput.value = String(last);
    return;
  }

  const longer = value > last;
  if (longer) {
    // The length of a document is the frame its last drawing reaches, so a
    // document cannot be made longer on its own: it grows when there is
    // something to show on a later frame.
    frameCountInput.value = String(last);
    setStatus(`The document has ${last} frames — it grows when you draw on a later frame`);
    return;
  }
  if (
    !confirm(
      `Shorten the document to ${value} frames?\n\n` +
        `${countDrawingsAfter(project, value)} drawing(s) after frame ${value} will be taken away, ` +
        "and the drawings that reach past it will be cut short there.",
    )
  ) {
    frameCountInput.value = String(last);
    return;
  }

  stopPlayback();
  const before = snapshot();
  const removed = trimToFrame(project, value);
  if (project.currentFrame > value) project.currentFrame = value;
  recordHistory(before);
  markDirty();
  afterChange();
  frameCountInput.value = String(Math.max(project.startFrame, contentEnd(project)));
  setStatus(
    `The document now has ${value} frames` +
      (removed ? ` (${removed} drawing(s) taken away)` : ""),
  );
}

/** How many drawings start after `frame`. */
function countDrawingsAfter(project, frame) {
  let count = 0;
  for (const layer of project.layers) {
    for (const drawing of layer.drawings ?? []) {
      if (drawing.at > frame) count += 1;
    }
  }
  return count;
}

function toggleLoop() {
  const project = state.project;
  if (loopInput.checked === project.loop) return;
  const before = snapshot();
  project.loop = loopInput.checked;
  recordHistory(before);
  markDirty();
  setStatus(project.loop ? "Loop on" : "Loop off");
}

function clearDrawing() {
  const layer = currentLayer();
  const info = exposureInfo(layer, state.project.currentFrame);
  if (info.kind !== "head" && info.kind !== "hold") return;
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }
  if (!confirm("Clear every stroke in the current drawing?")) return;

  stopPlayback();
  const before = snapshot();
  info.drawing.strokes = [];
  // A drawing that has nothing left in it is taken out of the layer, so that
  // the document gets shorter with it. A drawing that still holds a picture
  // keeps its place, because the picture is still there to be seen.
  if (!info.drawing.image) {
    const drawings = layer.drawings ?? [];
    const index = drawings.indexOf(info.drawing);
    if (index !== -1) drawings.splice(index, 1);
  }
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus("Drawing cleared");
}

/* --------------------------------------------------------------- playback */

function playbackEnd() {
  return Math.max(state.project.startFrame, contentEnd(state.project));
}

function startPlayback() {
  if (state.playing) return;
  stopFlipPreview();
  const project = state.project;
  if (contentEnd(project) < project.startFrame) {
    setStatus("There are no drawings to play", true);
    return;
  }
  if (project.currentFrame > playbackEnd()) project.currentFrame = project.startFrame;

  state.playing = true;
  setPlayIcon(true);
  renderCanvas(); // hides the onion skins
  startAudio();

  // Clock-driven playback: the frame is derived from elapsed time, so a slow
  // render skips frames instead of slowing the animation down, and changing
  // the fps or speed takes effect immediately.
  let last = performance.now();
  let carry = 0;

  const step = (now) => {
    if (!state.playing) return;
    state.playTimer = requestAnimationFrame(step);

    const elapsed = now - last;
    last = now;
    // After a long stall (a hidden tab, a debugger) the animation resumes
    // gently instead of jumping. The time is shortened rather than thrown
    // away, so a frame that takes a long time to draw - a big document on a
    // slow machine - still moves the animation along instead of freezing it.
    carry += (Math.min(elapsed, 500) / 1000) * project.fps * state.playSpeed;
    const advance = Math.floor(carry);
    if (advance < 1) return;
    carry -= advance;

    const end = playbackEnd();
    const span = end - project.startFrame + 1;
    let next = project.currentFrame + advance;
    if (next > end) {
      if (project.loop) {
        next = project.startFrame + ((next - project.startFrame) % span);
      } else {
        project.currentFrame = end;
        updateFrameLabel();
        updatePlayhead();
        renderCanvas();
        stopPlayback();
        setStatus("Playback finished");
        return;
      }
    }
    project.currentFrame = next;
    updateFrameLabel();
    updatePlayhead();
    renderCanvas();
  };

  state.playTimer = requestAnimationFrame(step);
  setStatus(`Playing at ${project.fps} fps${state.playSpeed === 1 ? "" : ` × ${state.playSpeed}`}`);
}

function stopPlayback() {
  const wasPlaying = state.playing;
  if (state.playTimer) cancelAnimationFrame(state.playTimer);
  state.playTimer = null;
  state.playing = false;
  setPlayIcon(false);
  stopAudio();
  if (state.project?.layers?.length) {
    syncLayerControls();
    if (wasPlaying) renderCanvas(); // bring the onion skins back
  }
}

function togglePlayback() {
  if (state.playing) {
    stopPlayback();
    setStatus("Paused");
  } else {
    startPlayback();
  }
}

function stepFrame(delta) {
  stopPlayback();
  selectFrame(state.project.currentFrame + delta);
}

/* ---------------------------------------------------------------- drawing */

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  // The sheet holds the whole document, the pasteboard included, so the
  // pointer is measured in the pixels of the document, not of the project.
  const doc = documentSize(state.project);
  const pad = stagePadding(doc.width, doc.height);
  const canvasX = ((event.clientX - rect.left) * doc.width) / rect.width - pad.x;
  const canvasY = ((event.clientY - rect.top) * doc.height) / rect.height - pad.y;

  // In the camera view the stage shows a crop, so the pointer has to be
  // mapped back through the camera to find the canvas position. The camera
  // tool works on the whole canvas, so it is never mapped.
  const view = state.cameraView && state.tool !== "camera"
    ? cameraView(state.project.camera, state.project.currentFrame, state.project.width, state.project.height)
    : null;
  if (!view) return [canvasX, canvasY];

  return [
    view.camera.x + (canvasX - view.offsetX) / view.scale,
    view.camera.y + (canvasY - view.offsetY) / view.scale,
  ];
}

/* ------------------------------------------------- zoom with the middle button */

/** How much one notch of the middle button changes the zoom. */
const ZOOM_STEP = 0.15;

/** The smallest camera window that can be zoomed to. */
const ZOOM_MIN = 16;

/**
 * Zoom the camera window by a factor.
 *
 * The stage shows what the camera takes, so zooming means making the camera
 * window smaller or bigger. A point in the canvas stays where it is, which
 * is what makes the zoom feel right; without a point the centre is kept.
 */
function zoomCamera(factor, px, py) {
  const project = state.project;
  if (!currentCameraKey()) {
    addCameraKey();
    return false;
  }
  const key = currentCameraKey();
  if (!key) return false;

  const width = Math.max(ZOOM_MIN, Math.min(project.width, Math.round(key.width * factor)));
  const height = Math.max(ZOOM_MIN, Math.min(project.height, Math.round(key.height * factor)));
  if (width === key.width && height === key.height) return false;

  const shareX = px === undefined ? 0.5 : (px - key.x) / key.width;
  const shareY = py === undefined ? 0.5 : (py - key.y) / key.height;
  updateCameraKey({
    x: Math.round(px === undefined ? (project.width - width) / 2 : px - shareX * width),
    y: Math.round(py === undefined ? (project.height - height) / 2 : py - shareY * height),
    width,
    height,
  });
  return true;
}

/**
 * Zoom with the wheel over the stage.
 *
 * Every wheel over the stage zooms: a plain wheel, the middle button held
 * down and scrolled, and the control key that a trackpad sends for a pinch.
 * The button of a wheel event is not used to tell them apart, because a
 * browser reports every wheel as the primary button.
 *
 * The wheel works over the whole stage, not only over the document, and
 * the zoom keeps the point of the document that is under the pointer. When
 * the pointer is over the empty stage beside the document, the nearest
 * edge of the document is the point that is kept.
 */
canvasScroll.addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP);
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(rect.right, Math.max(rect.left, event.clientX));
  const y = Math.min(rect.bottom, Math.max(rect.top, event.clientY));
  zoomStage(factor, x, y);
}, { passive: false });

// The middle mouse button drags the stage, the way Clip Studio Paint does it.
canvasScroll.addEventListener("pointerdown", (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  panStage(event);
});

/**
 * The readings of the pen, the last few of them.
 *
 * The pen tells how hard it is pressed many times a second, and the
 * readings jump about by a little every time. The width of the line would
 * jump with them, so the last few readings are averaged, the way the line
 * itself is smoothed.
 */
const pressureReadings = [];

/** How many readings are averaged. */
const PRESSURE_WINDOW = 4;

function pressureFor(event) {
  if (!state.pressureEnabled) return null;
  if (event.pointerType !== "pen") return null;

  const value = Number(event.pressure);
  if (!Number.isFinite(value)) return null;
  // A pen touching the tablet can briefly report 0; keep a visible hairline.
  // The remembered gain scales the recorded pressure; 100% is neutral.
  const scaled = Math.min(1, Math.max(0.05, value * state.pressureGain));

  pressureReadings.push(scaled);
  if (pressureReadings.length > PRESSURE_WINDOW) pressureReadings.shift();
  let sum = 0;
  for (const reading of pressureReadings) sum += reading;
  return sum / pressureReadings.length;
}

/** The readings of the pen are forgotten when a stroke ends. */
function forgetPressure() {
  pressureReadings.length = 0;
}

function drawPoint(event) {
  const [x, y] = canvasPoint(event);
  const pressure = pressureFor(event);
  if (pressure === null) {
    // Without a stylus the line keeps the width of the brush.
    return [x, y];
  }
  pressureValue.textContent = pressure.toFixed(2);
  return [x, y, pressure];
}

/**
 * Where the pointer is, in the space of the picture of the cell.
 *
 * A cell may sit somewhere else than it was drawn, so a point under the
 * pointer has to be put back into the picture before the ink is put down.
 * The brush then works in the space of the picture, and the picture is put
 * where the transform says when it is shown.
 */
function drawPointIn(event, drawing) {
  const point = drawPoint(event);
  // A cell that tweens is somewhere other than its start while the playhead
  // is on the span, so the pointer goes into the space of the picture the
  // walk makes of it on this frame.
  const transform = transformAt(drawing, state.project.currentFrame);
  if (isPlain(transform)) return point;
  const picture = pointToPicture(
    { x: point[0], y: point[1] },
    transform,
    state.project.width,
    state.project.height,
  );
  return [picture.x, picture.y, ...point.slice(2)];
}

/**
 * Turn the opacity of a layer, or of a folder above it, back up.
 *
 * A layer painted with no opacity takes the ink but shows none of it, so the
 * drawing vanishes in front of the person who made it. The layer itself is
 * the first thing to look at; when it is fine, the folders above it are
 * walked until the one with no opacity is found.
 */
function restoreOpacityToSee(project, index) {
  const layers = project?.layers ?? [];
  if ((layers[index]?.opacity ?? 1) <= 0) {
    layers[index].opacity = 1;
    return true;
  }
  for (const parent of ancestorsOf(project, index)) {
    if ((layers[parent]?.opacity ?? 1) <= 0) {
      layers[parent].opacity = 1;
      return true;
    }
  }
  return false;
}

function layerForDrawing() {
  let index = state.project.currentLayer;
  let layer = currentLayer();
  if (!layer) return null;
  if (isGroup(layer)) {
    // An animation folder is a track: the ink goes on the cel of the frame
    // being drawn, and an empty frame picks up a cel of its own now. An
    // ordinary folder holds other layers - select a layer inside it.
    if (!isAnimationFolder(layer)) {
      setStatus("A folder holds other layers - select a layer inside it to draw", true);
      return null;
    }
    const cel = celForDrawing(index, state.project.currentFrame);
    if (!cel) return null;
    // The cel is selected now (the layers panel and the track follow it), so
    // the checks below read the cel's own visibility and lock.
    index = state.project.currentLayer;
    layer = cel;
  }
  // A layer that is hidden, or that sits in a folder that is hidden, cannot
  // be seen. Ink on such a layer would vanish in front of the person who
  // made it, so the layer is turned on and the drawing is made where it can
  // be seen.
  if (!layerIsVisible(state.project, state.project.currentLayer)) {
    showLayer(state.project, state.project.currentLayer);
    markDirty();
    setStatus(`${layer.name} is now shown — it was hidden`);
  }
  // A layer painted with no opacity, or one inside a folder with no opacity,
  // takes the ink but shows none of it, so the person drawing sees nothing
  // go down. The opacity is turned back up so the drawing can be seen, the
  // same way a hidden layer is turned back on above.
  if (effectiveOpacity(state.project, state.project.currentLayer) <= 0) {
    restoreOpacityToSee(state.project, state.project.currentLayer);
    markDirty();
    setStatus(`${layer.name} had no opacity — it is visible again`);
  }
  if (layer.locked) {
    setStatus("This layer is locked — unlock it before drawing", true);
    return null;
  }
  return layer;
}

function ensureDrawing(layer, frame) {
  const existing = drawingAt(layer, frame);
  if (existing) return existing;

  // The frame is empty (a gap or outside the exposed range), so a new
  // one-frame drawing can be added without moving existing drawings.
  const drawing = { at: frame, hold: 1, strokes: [] };
  // A new cell is named after the frame it sits on, the way Clip Studio
  // Paint names the cells of an animation folder.
  drawing.name = cellName(layer, frame);
  layer.drawings.push(drawing);
  layer.drawings.sort((a, b) => a.at - b.at);
  // The cell before this one keeps the screen until this one starts, so
  // that the frames in between show the last picture and not nothing.
  closeCellGaps(layer, frame);
  return drawing;
}

/* --------------------------------------------------------------- selection */

/**
 * The selection of the document that is open.
 *
 * A selection is a mask the size of the canvas it was made on. A document
 * whose canvas has changed size has no selection any more, because the mask
 * would be a mask of another picture.
 */
function currentSelection() {
  const selection = state.selection;
  if (!selection) return null;
  const project = state.project;
  if (selection.width !== project.width || selection.height !== project.height) {
    state.selection = null;
    return null;
  }
  return selectionIsEmpty(selection) ? null : selection;
}

/** How much of the canvas is selected, in the words of the status bar. */
function describeSelection() {
  const selection = currentSelection();
  if (!selection) return "No selection";
  const bounds = selectionBounds(selection);
  return `${selectionArea(selection).toLocaleString()} px selected — ${bounds.width}×${bounds.height}`;
}

function setSelection(selection) {
  state.selection = selectionIsEmpty(selection) ? null : selection;
  drawOverlay();
  renderCanvas();
  setStatus(describeSelection());
}

/** Take the selection away. */
function clearSelection(say = true) {
  if (!state.selection) return;
  state.selection = null;
  drawOverlay();
  if (say) setStatus("Selection cleared");
}

/** Select the whole canvas, the way Ctrl+A does in Flash. */
function selectWholeCanvas() {
  const { width, height } = state.project;
  setSelection(selectAll(width, height));
}

/**
 * Start a selection drag.
 *
 * A drag that starts inside the selection moves the ink that is in it: that
 * is what a marquee does in Flash, and it is the only way to move a drawing
 * without moving the whole cell. A drag anywhere else draws a new selection
 * out; Shift adds to the one that is there and Alt takes away from it.
 */
function startSelectionDrag(event, point, mode) {
  const selection = currentSelection();
  const inside = selection && selectionContains(selection, point[0], point[1]);
  if (inside && mode === "new" && state.tool === "marquee") {
    state.selectionDrag = {
      kind: "move",
      from: point,
      to: point,
      selection,
      before: snapshot(),
      drawing: drawingAt(currentLayer(), state.project.currentFrame),
    };
    setStatus("Drag the selection to move what is in it");
    return;
  }
  state.selectionDrag = {
    kind: state.tool === "lasso" ? "lasso" : "marquee",
    shape: state.marqueeShape,
    mode,
    from: point,
    to: point,
    path: state.tool === "lasso" ? [point] : null,
  };
}

/** Follow the pointer while a selection is being dragged. */
function updateSelectionDrag(point) {
  const drag = state.selectionDrag;
  if (!drag) return;
  drag.to = point;
  if (drag.kind === "lasso") {
    const last = drag.path[drag.path.length - 1];
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 1.5) return;
    drag.path.push(point);
  }
}

/** Finish the drag: make the selection, or move the ink in it. */
function commitSelectionDrag() {
  const drag = state.selectionDrag;
  state.selectionDrag = null;
  if (!drag) return;

  if (drag.kind === "move") {
    moveSelectionContents(drag);
    return;
  }

  const { width, height } = state.project;
  let made = null;
  if (drag.kind === "lasso") {
    if (drag.path.length < 3) {
      setStatus("A lasso needs a path — draw round the part of the canvas you want");
      drawOverlay();
      return;
    }
    made = selectionFromPolygon(width, height, drag.path);
  } else if (drag.shape === "oval") {
    made = selectionFromEllipse(width, height, drag.from[0], drag.from[1], drag.to[0], drag.to[1]);
  } else {
    made = selectionFromRect(width, height, drag.from[0], drag.from[1], drag.to[0], drag.to[1]);
  }
  setSelection(combineSelections(currentSelection(), made, drag.mode));
}

/**
 * Move the ink that is in the selection, and the selection with it.
 *
 * Every stroke of the cell is cut at the edge of the selection: the part
 * inside travels, the part outside stays where it was. That is how a
 * selection moves a drawing in Flash - the ink is not stretched, a hole is
 * left behind, and the drawing that was under the pointer is the drawing
 * that moves.
 */
function moveSelectionContents(drag) {
  const drawing = drag.drawing;
  const dx = Math.round(drag.to[0] - drag.from[0]);
  const dy = Math.round(drag.to[1] - drag.from[1]);
  if (!drawing) {
    setStatus("There is nothing on this frame to move", true);
    drawOverlay();
    return;
  }
  if (dx === 0 && dy === 0) {
    drawOverlay();
    return;
  }

  const outside = invertSelection(drag.selection);
  const kept = [];
  const moving = [];
  for (const stroke of drawing.strokes) {
    // A fill is a click that floods a region at paint time, not a line: it
    // stays where it was, with the part of the cell it filled.
    if (stroke.kind === "fill") {
      kept.push(stroke);
      continue;
    }
    kept.push(...clipStroke(outside, stroke));
    for (const piece of clipStroke(drag.selection, stroke)) {
      moving.push(translateStroke(piece, dx, dy));
    }
  }

  if (moving.length === 0) {
    setStatus("Nothing to move — there is no ink inside the selection");
    drawOverlay();
    return;
  }

  drawing.strokes = [...kept, ...moving];
  state.selection = shiftSelection(drag.selection, dx, dy);
  recordHistory(drag.before);
  markDirty();
  afterChange({ timeline: false });
  drawOverlay();
  setStatus(`Moved the selection by ${dx}, ${dy}`);
}

/**
 * Cut the stroke that was just drawn to the selection.
 *
 * A stroke that leaves the selection is cut at its edge, the way Flash cuts
 * it: the ink outside the selection is never put down. The cell is left with
 * the pieces that were inside, and nothing at all when the stroke was drawn
 * outside the selection.
 */
function fitStrokeToSelection(drawing) {
  const selection = currentSelection();
  const stroke = state.drawing;
  if (!selection || !stroke || !drawing) return true;

  if (stroke.kind === "fill") {
    // A fill is not a line and cannot be cut at the edge: the click has to be
    // inside the selection for it to happen at all. The fill then holds on to
    // the runs of the selection it was made in, so the paint is kept to the
    // part of the canvas that was allowed.
    if (!selectionContains(selection, stroke.points[0][0], stroke.points[0][1])) {
      return false;
    }
    stroke.clip = selectionSpans(selection);
    return true;
  }

  const pieces = clipStroke(selection, stroke);
  if (pieces.length === 1 && pieces[0] === stroke) return true;
  const index = drawing.strokes.indexOf(stroke);
  if (index < 0) return true;
  drawing.strokes.splice(index, 1, ...pieces);
  return pieces.length > 0;
}

/** The outline of a selection as a path that can be stroked. */
function selectionPath(selection, dx = 0, dy = 0) {
  const path = new Path2D();
  for (const [x0, y0, x1, y1] of selectionOutline(selection)) {
    path.moveTo(x0 + dx, y0 + dy);
    path.lineTo(x1 + dx, y1 + dy);
  }
  return path;
}

/**
 * Draw the marching ants of the selection, and the drag that is in the hand.
 *
 * The ants are a white line with a black dashed one on top of it, so they can
 * be seen on paper and on ink alike. The selection is not part of the
 * picture: it goes on the sheet over the stage, so it is never exported.
 */
function drawSelectionSheet(target) {
  const selection = currentSelection();
  const drag = state.selectionDrag;
  if (!selection && !drag) return;

  target.save();
  target.lineWidth = 1;
  target.setLineDash([]);
  target.strokeStyle = "rgba(255, 255, 255, 0.9)";

  const strokeAnts = (path) => {
    target.setLineDash([]);
    target.lineWidth = 2;
    target.stroke(path);
    target.setLineDash([4, 4]);
    target.lineWidth = 1;
    target.strokeStyle = "rgba(0, 0, 0, 0.85)";
    target.stroke(path);
  };

  if (selection) {
    if (drag?.kind === "move") {
      // The selection travels with the ink, so the ants are drawn where the
      // ink will be, and the place it came from is left faint.
      target.globalAlpha = 0.35;
      strokeAnts(selectionPath(selection));
      target.globalAlpha = 1;
      strokeAnts(
        selectionPath(selection, drag.to[0] - drag.from[0], drag.to[1] - drag.from[1]),
      );
    } else {
      strokeAnts(selectionPath(selection));
    }
  }

  if (drag && drag.kind !== "move") {
    const path = new Path2D();
    if (drag.kind === "lasso") {
      const [first, ...rest] = drag.path;
      path.moveTo(first[0], first[1]);
      for (const point of rest) path.lineTo(point[0], point[1]);
      path.closePath();
    } else if (drag.shape === "oval") {
      const left = Math.min(drag.from[0], drag.to[0]);
      const top = Math.min(drag.from[1], drag.to[1]);
      const width = Math.abs(drag.to[0] - drag.from[0]);
      const height = Math.abs(drag.to[1] - drag.from[1]);
      path.ellipse(
        left + width / 2,
        top + height / 2,
        Math.max(0.5, width / 2),
        Math.max(0.5, height / 2),
        0,
        0,
        Math.PI * 2,
      );
    } else {
      path.rect(
        Math.min(drag.from[0], drag.to[0]),
        Math.min(drag.from[1], drag.to[1]),
        Math.abs(drag.to[0] - drag.from[0]),
        Math.abs(drag.to[1] - drag.from[1]),
      );
    }
    strokeAnts(path);
  }

  target.restore();
  target.lineWidth = 1;
  target.setLineDash([]);
}

canvas.addEventListener("pointerdown", (event) => {
  if (state.playing) return;
  if (event.button !== 0) return;
  if (state.tool === "marquee" || state.tool === "lasso") {
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointers have nothing to capture.
    }
    const [x, y] = canvasPoint(event);
    const mode = event.shiftKey ? "add" : event.altKey ? "subtract" : "new";
    startSelectionDrag(event, [x, y], mode);
    drawOverlay();
    return;
  }
  if (state.tool === "pick") {
    pickColourAt(event);
    return;
  }
  if (state.tool === "camera") {
    // The camera tool aims the shot instead of painting.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointers have nothing to capture.
    }
    const [x, y] = canvasPoint(event);
    // Holding Shift turns the frame instead of moving it.
    startCameraDrag({ x, y }, { forceRotate: event.shiftKey });
    return;
  }
  if (event.pointerType === "touch" && !state.touchDraw) {
    setStatus("Touch drawing is off — turn it on in the tool panel");
    return;
  }

  // The state of the document is taken before the layer is looked at, so
  // that turning a hidden layer on can be taken back with the stroke.
  const before = snapshot();
  const layer = layerForDrawing();
  if (!layer) return;

  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic or already-released pointers have nothing to capture.
  }

  const existing = drawingAt(layer, state.project.currentFrame);
  const drawing = existing || ensureDrawing(layer, state.project.currentFrame);
  const settings = toolSettings();
  const isShapeTool = state.tool === "line" || state.tool === "rect" || state.tool === "ellipse";
  const startPoint = drawPointIn(event, drawing);
  const stroke = {
    color: colorInput.value,
    width: settings.width,
    points: [startPoint],

  };
  if (state.tool === "eraser") stroke.eraser = true;
  if (state.tool === "pencil") {
    // The pencil of Flash draws a thin line with a hard edge: the ends are
    // cut square and the corners are sharp, and there is no round brush
    // under the pointer.
    stroke.hard = true;
  }
  if (state.tool === "line" || state.tool === "rect" || state.tool === "ellipse") {
    // Shapes are a drag from the first point to this one; the second point
    // follows the pointer until release.
    stroke.kind = state.tool;
    stroke.points.push(startPoint);
  } else if (state.tool === "fill") {
    stroke.kind = "fill";
  }
  if (state.tool === "brush" || state.tool === "pencil" || state.tool === "eraser") {
    // A stroke remembers the brush it was made with, the way Clip Studio
    // Paint does. Changing the brush or the settings afterwards therefore
    // does not change the strokes that are already on the paper.
    stroke.brush = strokeBrushFor(settings);
  }
  // The opacity and the blend belong to every tool that paints, and not to
  // the fill, which floods the region with the colour as it is.
  if (state.tool !== "fill") {
    if (settings.opacity < 100) stroke.opacity = settings.opacity / 100;
    if (settings.blend !== "normal") stroke.blend = settings.blend;
  }
  state.smoothedPoint = stroke.points[stroke.points.length - 1];
  state.rawSamples =
    state.tool === "brush" || state.tool === "eraser"
      ? [startPoint]
      : null;

  drawing.strokes.push(stroke);
  state.strokeBefore = before;
  state.strokeWasNew = !existing;
  state.drawing = stroke;
  // The cell the ink goes on. A cell may sit somewhere else than it was
  // drawn, so the brush has to know which one it is on.
  state.drawingCell = drawing;
  // The brush with a picture stamps itself onto the layers of the living
  // ink, so the stroke shows as it is drawn without being built again.
  startLiveStroke(stroke, brushOfStroke(stroke, currentBrush()));
  markDirty();
  renderCanvas();
});

canvas.addEventListener("pointermove", (event) => {
  if (state.cameraDrag) {
    const [x, y] = canvasPoint(event);
    updateCameraDrag({ x, y });
    renderCanvas();
    return;
  }
  if (state.selectionDrag) {
    const [x, y] = canvasPoint(event);
    updateSelectionDrag([x, y]);
    drawOverlay();
    return;
  }
  if (!state.drawing) return;

  // A fast stroke is reported by the pointer as one move with many samples
  // inside it. Every one of them is a place the brush passed, so every one
  // of them is kept: without this a quick line comes out as a few dots.
  const samples =
    typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : null;
  const list = samples && samples.length ? samples : [event];

  for (const rawEvent of list) {
    const point = drawPointIn(rawEvent, state.drawingCell);

    if (state.drawing.kind && state.drawing.kind !== "fill") {
      // Shapes: the second point tracks the pointer for a live preview.
      state.drawing.points[1] = point;
      continue;
    }
    if (state.drawing.kind === "fill") break; // a fill is a single click

    // The stabiliser is TVMini's own: it eases each raw sample toward the
    // running point, so shaky input lands on a calmer run. What the run
    // becomes is decided after it, by the Flash 8 fit.
    const sample = smoothPoint(state.smoothedPoint, point, toolSettings().stabilizer / 10);
    state.smoothedPoint = sample;

    if (state.tool === "pencil") {
      // The pencil records the eased line and shapes it by mode on release.
      const last = state.drawing.points[state.drawing.points.length - 1];
      if (Math.hypot(sample[0] - last[0], sample[1] - last[1]) < 1.5) continue;
      state.drawing.points.push(sample);
      continue;
    }

    // The brush and the eraser gather the whole run of the hand. The sample
    // goes in when it is far enough from the last one, so a resting hand
    // does not grow the run without moving.
    const run = state.rawSamples ?? [];
    const last = run[run.length - 1];
    if (!last || Math.hypot(sample[0] - last[0], sample[1] - last[1]) > 0.35) {
      run.push(sample);
      state.rawSamples = run;
    }
  }

  if (state.tool === "brush" || state.tool === "eraser") {
    // Flash 8 brush smoothness (`Stroke\Brush Smoothness`): the whole run of
    // samples is fitted again, so the line that is shown is the line that
    // will be left behind, and it does not trail the pointer. A brush from
    // Clip Studio Paint draws the line the hand drew - its own curves shape
    // the stroke - so the smoothing stands aside for one of those.
    if (brushFromSut(brushOfStroke(state.drawing, currentBrush()))) {
      state.drawing.points = catmullRomResample(
        state.rawSamples,
        Number(state.drawing.width) || Number(widthInput.value) || 1,
      );
    } else {
      state.drawing.points = brushSmoothPath(state.rawSamples, BRUSH_SMOOTHING);
    }
  }

  // The stroke is shown on the sheet on top of the stage; the document
  // underneath is drawn when the stroke is finished. An eraser is the
  // exception: it takes ink away from the document, and a sheet on top of
  // the stage cannot do that, so the document itself is drawn again for
  // every move of the pointer.
  if (liveStrokeState.active) {
    // The dabs that are new go onto the layers of the living ink; the sheet
    // on top only carries the tip and the edges of the stage.
    stampLiveStroke();
    drawOverlay();
  } else if (state.drawing?.eraser) renderCanvas();
  else drawOverlay();
});

/**
 * Does a layer that can be seen stand over the one in the hand?
 *
 * The ink of the living layers is stamped over the whole stack while a
 * stroke is drawn, so a stroke that belongs under a layer above can only
 * be committed with a full render of the document, which knows the order.
 */
function layerAboveCovers() {
  const project = state.project;
  for (let index = project.layers.length - 1; index > project.currentLayer; index -= 1) {
    if (layerIsVisible(project, index)) return true;
  }
  return false;
}

function endStroke(event) {
  if (state.selectionDrag) {
    commitSelectionDrag();
    return;
  }
  if (state.cameraDrag) {
    commitCameraDrag();
    return;
  }
  if (!state.drawing) return;
  // The living layers hold the ink until it is committed below: the
  // stroke that was stamped is the stroke that was drawn, and it can go
  // straight into the document instead of the document being built again.
  const wasLive = liveStrokeState.active;
  const liveSource = liveStrokeState.grained ? liveGrainCanvas : liveInkCanvas;
  let grown = false;

  if (state.tool === "brush" || state.tool === "eraser") {
    // The pointer stopped where it left the paper: that last place goes in
    // as a sample, so the fitted line ends where the hand ended. The brush
    // shows the fitted line as it goes, so nothing changes here except the
    // last few pixels.
    if (state.rawSamples && event?.pointerId != null && state.drawing.kind !== "fill") {
      try {
        const point = drawPointIn(event, state.drawingCell);
        const run = state.rawSamples;
        const lastSample = run[run.length - 1];
        if (!lastSample || Math.hypot(point[0] - lastSample[0], point[1] - lastSample[1]) > 0.05) {
          run.push(smoothPoint(state.smoothedPoint, point, toolSettings().stabilizer / 10));
          if (brushFromSut(brushOfStroke(state.drawing, currentBrush()))) {
            state.drawing.points = catmullRomResample(
              run,
              Number(state.drawing.width) || Number(widthInput.value) || 1,
            );
          } else {
            state.drawing.points = brushSmoothPath(run, BRUSH_SMOOTHING);
          }
        }
      } catch {
        // A cancelled pointer has no last position; the line stays as it was.
      }
    }
    state.rawSamples = null;
    state.smoothedPoint = null;
  }
  const committed = state.drawing;
  // The stroke is cut at the edge of the selection before it is recorded, so
  // the picture that is saved holds the ink that was actually put down.
  const cell = drawingAt(currentLayer(), state.project.currentFrame);
  const kept = fitStrokeToSelection(cell);
  const wasNew = state.strokeWasNew;
  state.drawing = null;
  forgetPressure();
  // The stroke joins the picture of its own cell, and only that picture is
  // touched: the cell is not built from the beginning for every stroke.
  if (kept && committed) {
    // The half-edge shape of a freehand stroke is built now, once the stroke
    // is out of the hand, so the contour that will be painted is the contour
    // the model holds and every later frame only reads it back.
    try {
      shapeForStroke(committed);
    } catch (error) {
      console.error("shapeForStroke at commit failed", error);
    }
    appendStrokeToCellPaint(cell, committed);
    // A stroke that ran past the sheet grows the sheet, so the room to draw
    // in follows the hand the way Flash's work area does. It rides in the
    // same change as the stroke, so undo takes them back together.
    grown = growSheetForStroke(committed);
  }

  const before = state.strokeBefore;
  state.strokeBefore = null;
  state.strokeWasNew = false;
  if (before) recordHistory(before);

  if (!kept) {
    // A click outside the selection leaves no ink. A cell that was made for
    // that ink goes away again with it.
    if (wasNew && cell && cell.strokes.length === 0) {
      const layer = currentLayer();
      const index = layer.drawings.indexOf(cell);
      if (index >= 0) layer.drawings.splice(index, 1);
    }
    endLiveStroke();
    afterChange({ timeline: wasNew });
    setStatus("Nothing was painted — the stroke was outside the selection", true);
    return;
  }

  // The ink of the living layers goes into the document as it stands:
  // the stroke that was stamped is the stroke that was drawn, so the
  // whole document is not built again for it. It is only honest when
  // nothing stands over the layer in the hand, when no selection cut the
  // ink, and when the sheet did not grow - a grown sheet is drawn anew
  // anyway, and a cut stroke is not the stroke that was stamped.
  const liveStyleTapers = liveStrokeState.style?.taperEnds === true;
  const fast =
    wasLive && !grown && !layerAboveCovers() && !currentSelection()
    && !liveStyleTapers;
  if (fast) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = committed.opacity ?? 1;
    ctx.globalCompositeOperation =
      committed.blend && committed.blend !== "normal" ? committed.blend : "source-over";
    ctx.drawImage(liveSource, 0, 0);
    ctx.restore();
  }
  endLiveStroke();
  const layer = currentLayer();
  const drawing = drawingAt(layer, state.project.currentFrame);
  const count = drawing ? drawing.strokes.length : 0;
  afterChange({ timeline: wasNew, skipRender: fast });
  if (fast) drawOverlay();
  setStatus(`${count} stroke${count === 1 ? "" : "s"} on ${layer.name}, frame ${state.project.currentFrame}`);
}

canvas.addEventListener("pointerup", (event) => endStroke(event));
canvas.addEventListener("pointercancel", (event) => endStroke(event));

/* ------------------------------------------------------------- tool panel */

widthInput.addEventListener("input", () => {
  widthValue.textContent = widthInput.value;
  // The width is written in the corner of the picture of the brush, the way
  // MoArt writes it, so the number is visible without the slider.
  if (brushShapeSize) brushShapeSize.textContent = `${widthInput.value}px`;
  // The width belongs to the tool in the hand, so the pencil keeps its own.
  toolSettings().width = Number(widthInput.value);
  syncQuickBar();
  syncBrushSizeGrid();
  // The shape of the brush under the pointer grows and shrinks with the
  // width, so it is drawn again at once.
  drawBrushShape();
  drawOverlay();
});

/* --------------------------------------------------------- brush size grid */

// The sizes TVPaint's Brush Size panel offers, from the pinprick to the
// broadest wash. A press of a cell puts the size in the hand.
const BRUSH_SIZE_PRESETS = [
  0.7, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 17, 20, 25, 30, 40, 50,
  60, 70, 80, 100, 120, 150, 170, 200, 250, 300, 400, 500, 600, 700, 800,
];

// The diameter of the dot in a cell: it grows with the size but never leaves
// the cell, so 800 reads as a full dot and 0.7 as a pinprick. The growth is
// a root, the way TVPaint's own grid reads - the small steps stay visible
// next to the large ones.
function brushSizeDotPixels(size) {
  const full = 13;
  return Math.round(Math.min(full, Math.max(3, full * Math.pow(size / 800, 0.4))));
}

function renderBrushSizeGrid() {
  const grid = document.getElementById("brushSizeGrid");
  if (!grid) return;
  for (const size of BRUSH_SIZE_PRESETS) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "brush-size-cell";
    cell.dataset.size = String(size);
    cell.title = `Brush size ${size}`;
    const pixels = brushSizeDotPixels(size);
    const dot = document.createElement("span");
    dot.className = "brush-size-dot";
    dot.style.width = `${pixels}px`;
    dot.style.height = `${pixels}px`;
    const label = document.createElement("span");
    label.className = "brush-size-label";
    label.textContent = String(size);
    cell.append(dot, label);
    cell.addEventListener("click", () => {
      widthInput.value = String(size);
      // The slider's own listener writes the number, the tool setting, the
      // quick bar and the picture of the brush, so one event does it all.
      widthInput.dispatchEvent(new Event("input"));
    });
    grid.append(cell);
  }
}

/** Light the cell of the size the brush is at now, when it is one of them. */
function syncBrushSizeGrid() {
  const grid = document.getElementById("brushSizeGrid");
  if (!grid) return;
  const width = Number(widthInput.value);
  for (const cell of grid.children) {
    cell.classList.toggle("active", Number(cell.dataset.size) === width);
  }
}

renderBrushSizeGrid();

/* ------------------------------------------------------------- gauge rows */

// The gauges of the tool panel: MoArt's bars where the fill is the value,
// the name sits inside at the left and the number at the right. The bar is
// dragged to set the value, its edges carry step buttons on hover and a
// double click types the exact number. The hidden range input of the row
// stays the one source of truth, so every listener written for the slider
// keeps working.
const gaugeRows = [];

function setupGaugeRows() {
  for (const gauge of document.querySelectorAll(".prop-row .pb-gauge")) {
    const field = gauge.closest(".field");
    const input = field?.querySelector('input[type="range"]');
    if (!input) continue;
    const fill = gauge.querySelector(".pb-gauge-fill");
    const stepSize = Number(gauge.dataset.step) || 1;
    const snap = Number(input.step) || 1;
    const decimals = (String(input.step).split(".")[1] ?? "").length;
    const row = { gauge, input, fill };
    gaugeRows.push(row);

    const clamp = (value) => Math.min(Number(input.max), Math.max(Number(input.min), value));
    const snapped = (value) => Number((Math.round(value / snap) * snap).toFixed(decimals));
    const paintGauge = () => {
      const min = Number(input.min) || 0;
      const max = Number(input.max) || 100;
      const value = Number(input.value) || 0;
      const t = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
      fill.style.width = `${t * 100}%`;
      gauge.setAttribute("aria-valuenow", String(clamp(value)));
    };
    row.paint = paintGauge;
    input.addEventListener("input", paintGauge);
    paintGauge();

    const setFromPointer = (event) => {
      const rect = gauge.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      input.value = String(snapped(Number(input.min) + t * (Number(input.max) - Number(input.min))));
      input.dispatchEvent(new Event("input"));
    };

    let dragging = false;
    gauge.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".num-step")) return;
      dragging = true;
      // A pointer that is already gone (a synthesised event, a pen lifted
      // too fast) cannot be captured; the drag still works without it.
      try {
        gauge.setPointerCapture(event.pointerId);
      } catch {
        // The press itself is answer enough.
      }
      setFromPointer(event);
    });
    gauge.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      setFromPointer(event);
    });
    gauge.addEventListener("pointerup", () => {
      dragging = false;
    });
    gauge.addEventListener("pointercancel", () => {
      dragging = false;
    });

    const nudge = (dir) => {
      input.value = String(snapped(clamp(Number(input.value) + dir * stepSize)));
      input.dispatchEvent(new Event("input"));
    };
    for (const button of gauge.querySelectorAll(".num-step")) {
      button.addEventListener("click", () => nudge(Number(button.dataset.dir)));
    }
    gauge.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        event.preventDefault();
        nudge(-stepSize);
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        event.preventDefault();
        nudge(stepSize);
      }
    });

    // A double click lays a small editor over the bar, so the exact number
    // can be typed, the way MoArt's scrub takes a typed value.
    gauge.addEventListener("dblclick", () => {
      if (gauge.querySelector(".gauge-edit")) return;
      const editor = document.createElement("input");
      editor.type = "text";
      editor.className = "gauge-edit";
      editor.value = String(Number(input.value));
      gauge.append(editor);
      editor.focus();
      editor.select();
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const typed = Number(editor.value);
        if (Number.isFinite(typed)) {
          input.value = String(clamp(typed));
          input.dispatchEvent(new Event("input"));
        }
        editor.remove();
      };
      editor.addEventListener("blur", commit);
      editor.addEventListener("keydown", (keyEvent) => {
        if (keyEvent.key === "Enter") commit();
        if (keyEvent.key === "Escape") {
          keyEvent.stopPropagation();
          done = true;
          editor.remove();
        }
      });
    });
  }
}

/** Paint every gauge from its input, for the paths that set values directly. */
function syncGauges() {
  for (const row of gaugeRows) row.paint();
}

setupGaugeRows();

strokeOpacityInput.addEventListener("input", () => {
  const value = Math.max(1, Math.min(100, Math.round(Number(strokeOpacityInput.value) || 100)));
  toolSettings().opacity = value;
  strokeOpacityValue.textContent = `${value}%`;
});

binarizeInput.addEventListener("change", () => {
  toolSettings().binarize = binarizeInput.checked;
  saveSettings();
  drawBrushShape();
  setStatus(
    binarizeInput.checked
      ? "Binarize on — the edge of the brush is hard, pixel by pixel"
      : "Binarize off — the edge of the brush is soft",
  );
});

strokeBlendSelect.addEventListener("change", () => {
  toolSettings().blend = strokeBlendSelect.value;
});

/** A slider of the brush: the number beside it, the tool and the shape. */
function watchBrushSlider(input, output, key, suffix = "") {
  if (!input) return;
  input.addEventListener("input", () => {
    const value = Number(input.value);
    toolSettings()[key] = value;
    if (output) output.textContent = `${value}${suffix}`;
    saveSettings();
    drawBrushShape();
    drawOverlay();
  });
}

watchBrushSlider(flowInput, flowValue, "flow", "%");
watchBrushSlider(hardnessInput, hardnessValue, "hardness", "%");
watchBrushSlider(thicknessInput, thicknessValue, "thickness", "%");
watchBrushSlider(spacingInput, spacingValue, "spacing", "%");

if (paperInput) {
  paperInput.addEventListener("change", () => {
    toolSettings().paper = paperInput.checked;
    saveSettings();
    drawBrushShape();
    setStatus(
      paperInput.checked
        ? "Paper on: the grain of the brush shows through the stroke"
        : "Paper off: the stroke is solid",
    );
  });
}

pressureInput.addEventListener("change", () => {
  state.pressureEnabled = pressureInput.checked;
  setStatus(
    state.pressureEnabled
      ? "Pen pressure on — width follows the stylus"
      : "Pen pressure off — constant width",
  );
});

const TOOL_BUTTONS = {
  brush: () => brushButton,
  pencil: () => pencilButton,
  eraser: () => eraserButton,
  pick: () => pickButton,
  line: () => lineToolButton,
  rect: () => rectToolButton,
  ellipse: () => ellipseToolButton,
  fill: () => fillToolButton,
  marquee: () => marqueeButton,
  lasso: () => lassoButton,
  camera: () => cameraToolButton,
};

const TOOL_STATUS = {
  brush: "Brush — paint with the selected colour",
  pencil: "Pencil — a thin line with a hard edge, the way the pencil of Flash draws it",
  eraser: "Eraser — removes paint and reveals lower layers or the canvas",
  pick: "Pick — click the canvas to sample a colour",
  line: "Line — drag from one point to another (L)",
  rect: "Rectangle — drag opposite corners (R)",
  ellipse: "Ellipse — drag the outline (E)",
  fill: "Fill — click a region to flood it with the colour (F)",
  marquee: "Marquee — drag out a selection; Shift adds to it, Alt takes away",
  lasso: "Lasso — draw round the part of the canvas you want; Shift adds, Alt takes away",
  camera: "Camera — drag the frame to aim the shot, drag a corner to resize (C)",
};

/**
 * What each tool is called in the property panel, and what it shows there.
 *
 * Every tool has a section of its own, the way MoArt has: the brush shows
 * the brush, the pencil shows the pencil, and so on. The settings of each
 * tool are kept apart, so the width of the pencil does not change the width
 * of the brush.
 */
const TOOL_PROPS = {
  brush: {
    title: "Brush",
    // The rows of the brush: a few of them are in the panel, the rest wait
    // behind "Hidden items" until they are brought out with the eye.
    rows: ["brush", "width", "opacity", "flow", "hardness", "thickness", "spacing", "paper", "stabilizer", "smoothness", "binarize", "blend"],
    note: "",
  },
  pencil: {
    title: "Pencil",
    rows: ["width", "opacity", "blend"],
    note: "A thin line with a hard edge, the way the pencil of Flash draws it.",
  },
  eraser: {
    title: "Eraser",
    rows: ["width", "opacity", "stabilizer", "binarize"],
    note: "The eraser takes the paint away and shows the layer below.",
  },
  line: {
    title: "Line",
    rows: ["width", "opacity", "blend"],
    note: "Drag from one point to another.",
  },
  rect: {
    title: "Rectangle",
    rows: ["width", "opacity", "blend"],
    note: "Drag from one corner to the opposite one.",
  },
  ellipse: {
    title: "Ellipse",
    rows: ["width", "opacity", "blend"],
    note: "Drag the outline of the ellipse.",
  },
  fill: {
    title: "Fill",
    rows: [],
    note: "Click a region to fill it with the colour.",
  },
  marquee: {
    title: "Marquee",
    rows: [],
    note: "Drag out a rectangle or an oval. Shift adds to the selection, Alt takes away from it.",
  },
  lasso: {
    title: "Lasso",
    rows: [],
    note: "Draw round the part of the canvas you want. Shift adds to the selection, Alt takes away from it.",
  },
  pick: {
    title: "Pick a colour",
    rows: [],
    note: "Click the canvas to take the colour that is there.",
  },
  camera: {
    title: "Camera",
    rows: [],
    note: "The frame of the camera is in the Inspector on the right.",
  },
};

const toolPropsTitle = document.getElementById("toolPropsTitle");
const toolNote = document.getElementById("toolNote");
const penDock = document.getElementById("dockPen");
const toolPropStrip = document.getElementById("toolPropStrip");
const toolPropGroup = document.getElementById("toolPropGroup");
const toolPropAdvBar = document.getElementById("toolPropAdvBar");
const toolPropAdvBtn = document.getElementById("toolPropAdvBtn");
const brushHeadRows = [
  document.getElementById("toolBrushRow"),
  document.getElementById("toolBrushActionsRow"),
];
const brushPreviewWrap = document.getElementById("brushPreviewWrap");
const brushShapeSize = document.getElementById("brushShapeSize");

/* --------------------------------------------------------- the docks */

// The panel is MoArt's paint window: named docks inside it, and each one
// folds under its head with the button at the right. What is folded is
// kept between visits.
const DOCKS_KEY = "tvmini.paintDocks.v1";

function setupPaintDocks() {
  let folded = {};
  try {
    const raw = JSON.parse(localStorage.getItem(DOCKS_KEY) || "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) folded = raw;
  } catch {
    // A blocked store only loses which docks were folded.
  }
  for (const dock of document.querySelectorAll(".paint-dock")) {
    const button = dock.querySelector(".paint-win-collapse");
    if (!button) continue;
    const title = dock.querySelector(".paint-dock-title")?.textContent?.trim() ?? dock.id;
    const apply = () => {
      const isFolded = folded[dock.id] === true;
      dock.classList.toggle("collapsed", isFolded);
      button.setAttribute("aria-expanded", String(!isFolded));
      button.title = isFolded ? `Expand ${title}` : `Collapse ${title}`;
      button.setAttribute("aria-label", button.title);
    };
    button.addEventListener("click", () => {
      folded[dock.id] = !(folded[dock.id] === true);
      try {
        localStorage.setItem(DOCKS_KEY, JSON.stringify(folded));
      } catch {
        // The same as above: best effort.
      }
      apply();
    });
    apply();
  }
}

setupPaintDocks();

/**
 * The rows of the property panel, in the order they are shown.
 *
 * The panel works the way the one of MoArt does: a row is either in the panel
 * or put away in the drawer, and the eye at its right says which. The order is
 * the same in both places, so a row that is brought back does not jump to the
 * end of the panel.
 */
const PROP_ROW_ORDER = [
  "width", "opacity", "flow", "hardness", "thickness", "spacing", "paper",
  "stabilizer", "binarize", "blend",
];

/** The rows a panel starts with, the way the brush panel of MoArt does:
    the three everyday gauges are in the panel, everything else lives in
    Hidden items and comes back with the eye or from the drawer. */
const PROP_PINS_DEFAULT = [
  "width", "opacity", "stabilizer",
];
/** How many rows the panel is willing to show at once. */
const PROP_PINS_MAX = 10;
// v2: the default set shrank to size, opacity and stabilizer, so the pins
// of the older, longer default do not hold the new one back.
const PROP_PINS_KEY = "tvmini.toolPanelPins.v2";
const PROP_ADV_KEY = "tvmini.toolPanelAdv.v1";

const PROP_ROW_ELEMENTS = {
  width: document.getElementById("toolWidthRow"),
  opacity: document.getElementById("toolOpacityRow"),
  flow: document.getElementById("toolFlowRow"),
  hardness: document.getElementById("toolHardnessRow"),
  thickness: document.getElementById("toolThicknessRow"),
  spacing: document.getElementById("toolSpacingRow"),
  paper: document.getElementById("toolPaperRow"),
  stabilizer: document.getElementById("toolStabilizerRow"),
  binarize: document.getElementById("toolBinarizeRow"),
  blend: document.getElementById("toolBlendRow"),
};

/** What a row is called when it is put away or brought back. */
const PROP_ROW_NAMES = {
  width: "Size",
  opacity: "Opacity",
  flow: "Flow",
  hardness: "Hardness",
  thickness: "Thickness",
  spacing: "Spacing",
  paper: "Paper",
  stabilizer: "Stabilizer",
  binarize: "Binarize",
  blend: "Blend",
};

/** The eye that puts a row away, and the same eye with a line through it. */
const EYE_SVG =
  '<svg class="eye-on" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M1.6 8S4 3.9 8 3.9 14.4 8 14.4 8 12 12.1 8 12.1 1.6 8 1.6 8Z" />' +
  '<circle cx="8" cy="8" r="1.9" /></svg>' +
  '<svg class="eye-off" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M4.1 4.6C2.6 5.8 1.6 8 1.6 8S4 12.1 8 12.1c1.1 0 2-.3 2.9-.8" />' +
  '<path d="M6.5 3.9c.5-.1 1-.1 1.5-.1 4 0 6.4 4.2 6.4 4.2s-.5.9-1.4 1.9" />' +
  '<path d="M2.6 2.6l10.8 10.8" /></svg>';

const propEyes = new Map();
for (const [id, row] of Object.entries(PROP_ROW_ELEMENTS)) {
  if (!row) continue;
  const eye = document.createElement("button");
  eye.type = "button";
  eye.className = "prop-eye";
  eye.dataset.propEye = id;
  eye.innerHTML = EYE_SVG;
  eye.addEventListener("click", () => togglePropPin(id));
  // The eye of a dock lives in its head, in front of the fold button.
  if (id === "options") {
    const head = row.querySelector(".paint-dock-head");
    head.insertBefore(eye, head.querySelector(".paint-win-collapse"));
  } else {
    row.appendChild(eye);
  }
  propEyes.set(id, eye);
}

/** The rows put away by the eye, kept between visits. */
let propPins = null;

function propPinList() {
  if (!propPins) {
    try {
      const raw = JSON.parse(localStorage.getItem(PROP_PINS_KEY) || "null");
      propPins = Array.isArray(raw)
        ? raw.filter((id) => PROP_ROW_ORDER.includes(id))
        : PROP_PINS_DEFAULT.slice();
    } catch {
      propPins = PROP_PINS_DEFAULT.slice();
    }
  }
  return propPins;
}

function propSavePins() {
  try {
    localStorage.setItem(PROP_PINS_KEY, JSON.stringify(propPinList()));
  } catch {
    // A blocked store only loses where the rows were.
  }
}

function propIsPinned(id) {
  return propPinList().includes(id);
}

/** The drawer is open or closed, kept between visits. */
let propDrawerOpen = null;

function propDrawerIsOpen() {
  if (propDrawerOpen === null) {
    try {
      propDrawerOpen = localStorage.getItem(PROP_ADV_KEY) === "1";
    } catch {
      propDrawerOpen = false;
    }
  }
  return propDrawerOpen;
}

function propSetDrawerOpen(open) {
  propDrawerOpen = !!open;
  try {
    localStorage.setItem(PROP_ADV_KEY, propDrawerOpen ? "1" : "0");
  } catch {
    // Best effort, the same as the pins.
  }
  layoutToolProps();
  // The panel is a long strip; the drawer that was just opened is brought into
  // view, so the press of the bar is not answered with nothing.
  if (propDrawerOpen) toolPropGroup.scrollIntoView({ block: "nearest" });
}

/** The rows that belong to the tool in the hand. */
function propRowsOfTool() {
  return TOOL_PROPS[state.tool]?.rows ?? [];
}

/**
 * Is any row of this tool put away?
 *
 * The bar that opens the drawer is only there while one is: a door to an
 * empty room is furniture.
 */
function propHiddenRowsExist() {
  const rows = propRowsOfTool();
  return PROP_ROW_ORDER.some((id) => rows.includes(id) && !propIsPinned(id));
}

/** Where a row is shown: in the panel, in the drawer, or not at all. */
function propRowVisibleIn(id) {
  if (!propRowsOfTool().includes(id)) return "";
  if (propIsPinned(id)) return "strip";
  return propDrawerIsOpen() ? "group" : "";
}

/** Put a row away, or bring it back, with the eye. */
function togglePropPin(id) {
  if (!PROP_ROW_ORDER.includes(id)) return;
  const list = propPinList();
  const at = list.indexOf(id);
  if (at >= 0) {
    list.splice(at, 1);
    propSavePins();
    layoutToolProps();
    setStatus(`${PROP_ROW_NAMES[id] ?? id} is in Hidden items`);
    return;
  }
  if (list.length >= PROP_PINS_MAX) {
    setStatus(`The panel holds ${PROP_PINS_MAX} rows — put one away first`, true);
    return;
  }
  list.push(id);
  propSavePins();
  layoutToolProps();
  setStatus(`${PROP_ROW_NAMES[id] ?? id} is back in the panel`);
}

/**
 * Put every row where it belongs.
 *
 * The rows are moved, never built again, so the listeners on the sliders and
 * on the eyes are the ones that were made once. A row that is not shown is
 * parked in the panel so that its place in the order is kept.
 */
function layoutToolProps() {
  let stripAt = 0;
  let groupAt = 0;
  for (const id of PROP_ROW_ORDER) {
    const row = PROP_ROW_ELEMENTS[id];
    if (!row) continue;
    const where = propRowVisibleIn(id);
    const eye = propEyes.get(id);
    if (id === "options") {
      // A whole dock is never parked among the rows of the strip: it is
      // shown in its own place or put away in the drawer as a window.
      row.hidden = where === "";
      if (where === "group") {
        toolPropGroup.insertBefore(row, toolPropGroup.children[groupAt] || null);
        groupAt += 1;
      } else if (where === "strip" && optionsDockHome && row.parentElement === toolPropGroup) {
        optionsDockHome.parent.insertBefore(row, optionsDockHome.next);
      }
      if (eye) {
        const pinned = propIsPinned(id);
        eye.setAttribute("aria-pressed", String(pinned));
        eye.title = pinned
          ? `Put ${PROP_ROW_NAMES[id] ?? id} away in Hidden items`
          : `Bring ${PROP_ROW_NAMES[id] ?? id} back into the panel`;
        eye.setAttribute("aria-label", eye.title);
      }
      continue;
    }
    row.hidden = where === "";
    const host = where === "group" ? toolPropGroup : toolPropStrip;
    const at = host.children[where === "group" ? groupAt : stripAt] || null;
    if (at !== row) host.insertBefore(row, at);
    if (where === "group") groupAt += 1;
    else stripAt += 1;
    if (eye) {
      const pinned = propIsPinned(id);
      eye.setAttribute("aria-pressed", String(pinned));
      eye.title = pinned
        ? `Put ${PROP_ROW_NAMES[id] ?? id} away in Hidden items`
        : `Bring ${PROP_ROW_NAMES[id] ?? id} back into the panel`;
      eye.setAttribute("aria-label", eye.title);
    }
  }

  const hasHidden = propHiddenRowsExist();
  toolPropAdvBar.hidden = !hasHidden;
  const open = hasHidden && propDrawerIsOpen();
  toolPropGroup.hidden = !open;
  toolPropAdvBtn.setAttribute("aria-expanded", String(open));
}

toolPropAdvBtn.addEventListener("click", () => {
  propSetDrawerOpen(!propDrawerIsOpen());
});

// Pressing the picture of the brush opens the library, the way it does in
// MoArt: the picture is the brush, and the brushes are one press behind it.
if (brushPreviewWrap) {
  brushPreviewWrap.title = "Open the brush library";
  brushPreviewWrap.addEventListener("click", () => {
    document.getElementById("brushPanelButton")?.click();
  });
}

/** The settings of the tool in the hand. */
function toolSettings() {
  return state.toolSettings[state.tool] ?? state.toolSettings.brush;
}

/**
 * Put the settings of the tool in the hand into the panel.
 *
 * The panel shows the section of the tool that is in the hand, so the brush
 * shows the brush and the pencil shows the pencil.
 */
function showToolProps() {
  const props = TOOL_PROPS[state.tool] ?? TOOL_PROPS.brush;
  const settings = toolSettings();

  toolPropsTitle.textContent = props.title;
  widthInput.value = String(settings.width);
  widthValue.textContent = String(settings.width);
  syncBrushSizeGrid();
  stabilizerInput.value = String(settings.stabilizer);
  stabilizerValue.textContent = String(settings.stabilizer);
  strokeOpacityInput.value = String(settings.opacity);
  strokeOpacityValue.textContent = `${settings.opacity}%`;
  strokeBlendSelect.value = settings.blend;
  binarizeInput.checked = settings.binarize === true;
  if (flowInput) {
    flowInput.value = String(settings.flow ?? 100);
    flowValue.textContent = `${settings.flow ?? 100}%`;
  }
  if (hardnessInput) {
    hardnessInput.value = String(settings.hardness ?? 100);
    hardnessValue.textContent = `${settings.hardness ?? 100}%`;
  }
  if (thicknessInput) {
    thicknessInput.value = String(settings.thickness ?? 100);
    thicknessValue.textContent = `${settings.thickness ?? 100}%`;
  }
  if (spacingInput) {
    spacingInput.value = String(settings.spacing ?? 25);
    spacingValue.textContent = `${settings.spacing ?? 25}%`;
  }
  if (paperInput) paperInput.checked = settings.paper === true;
  syncGauges();

  // The brush itself (its picture and its library) is above the rows, and it
  // belongs to the brush alone; the rows are laid out by the eye.
  const showsBrush = props.rows.includes("brush");
  for (const element of brushHeadRows) {
    if (element) element.hidden = !showsBrush;
  }
  // The picture of the brush is shown for every tool that draws with a size,
  // the way MoArt shows it above the rows.
  const showsPreview = props.rows.includes("width");
  brushPreviewWrap.hidden = !showsPreview;
  if (showsPreview) {
    brushShapeSize.textContent = `${settings.width}px`;
    drawBrushShape();
  }
  layoutToolProps();
  toolNote.hidden = !props.note;
  toolNote.textContent = props.note;
  // The stylus is only of use to the tools that draw a line, and then the
  // whole pen dock steps aside with them.
  const draws = state.tool !== "pick" && state.tool !== "camera" && state.tool !== "fill";
  if (penDock) penDock.hidden = !draws;
  syncQuickBar();
}

/** Take the settings from the panel into the tool in the hand. */
function saveToolProps() {
  const settings = toolSettings();
  settings.width = Math.max(0.5, Math.min(800, Number(widthInput.value) || settings.width));
  settings.stabilizer = Math.max(0, Math.min(100, Number(stabilizerInput.value) || 0));
  settings.opacity = Math.max(1, Math.min(100, Number(strokeOpacityInput.value) || 100));
  settings.blend = strokeBlendSelect.value;
  settings.binarize = binarizeInput.checked;
  if (flowInput) settings.flow = Math.max(0, Math.min(100, Number(flowInput.value)));
  if (hardnessInput) settings.hardness = Math.max(0, Math.min(100, Number(hardnessInput.value)));
  if (thicknessInput) settings.thickness = Math.max(1, Math.min(200, Number(thicknessInput.value)));
  if (spacingInput) settings.spacing = Math.max(1, Math.min(200, Number(spacingInput.value)));
  if (paperInput) settings.paper = paperInput.checked;
}

function selectTool(tool) {
  state.tool = tool;
  const picking = tool === "pick";

  for (const [name, buttonOf] of Object.entries(TOOL_BUTTONS)) {
    const active = name === tool;
    buttonOf().classList.toggle("active", active);
    buttonOf().setAttribute("aria-pressed", String(active));
  }
  colorInput.disabled =
    tool === "eraser" || tool === "fill" || tool === "camera" || tool === "marquee" || tool === "lasso";
  canvas.classList.toggle("picking", picking);
  canvas.classList.toggle("camera-tool", tool === "camera");

  setStatus(TOOL_STATUS[tool] ?? "Tool ready");
  // The tool in the hand has a section of its own in the property panel, so
  // the panel is filled with the settings of that tool.
  showToolProps();
  drawOverlay();
}

brushButton.addEventListener("click", () => selectTool("brush"));
pencilButton.addEventListener("click", () => selectTool("pencil"));
eraserButton.addEventListener("click", () => selectTool("eraser"));
pickButton.addEventListener("click", () => selectTool("pick"));
lineToolButton.addEventListener("click", () => selectTool("line"));
rectToolButton.addEventListener("click", () => selectTool("rect"));
ellipseToolButton.addEventListener("click", () => selectTool("ellipse"));
fillToolButton.addEventListener("click", () => selectTool("fill"));
marqueeButton.addEventListener("click", () => selectTool("marquee"));
lassoButton.addEventListener("click", () => selectTool("lasso"));
cameraToolButton.addEventListener("click", () => selectTool("camera"));

if (marqueeShapeSelect) {
  marqueeShapeSelect.value = state.marqueeShape;
  marqueeShapeSelect.addEventListener("change", () => {
    state.marqueeShape = marqueeShapeSelect.value === "oval" ? "oval" : "rect";
    setStatus(
      state.marqueeShape === "oval"
        ? "Marquee — drag out an oval"
        : "Marquee — drag out a rectangle",
    );
  });
}

function selectedWidth() {
  return Number(widthInput.value);
}

function changeWidth(delta) {
  const next = Math.max(0.5, Math.min(800, selectedWidth() + delta));
  if (next === selectedWidth()) return;
  widthInput.value = String(next);
  widthValue.textContent = String(next);
  syncBrushSizeGrid();
  syncGauges();
  setStatus(`Brush width ${next}`);
}

function rgbToHex(red, green, blue) {
  const hex = (value) => value.toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

/** Sample the composited canvas colour under the cursor, then draw again. */
function pickColourAt(event) {
  const [x, y] = canvasPoint(event);
  // The buffer holds the dots of the screen, so the place under the cursor is
  // found through the scale of the context.
  const matrix = ctx.getTransform();
  const px = Math.min(canvas.width - 1, Math.max(0, Math.round(x * matrix.a)));
  const py = Math.min(canvas.height - 1, Math.max(0, Math.round(y * matrix.d)));
  const [red, green, blue] = ctx.getImageData(px, py, 1, 1).data;
  colorInput.value = rgbToHex(red, green, blue);
  // The event tells the panel of the tools and the wheel that the colour
  // changed, so the wheel follows the colour that was picked up.
  colorInput.dispatchEvent(new Event("input", { bubbles: true }));
  selectTool("brush");
  setStatus(`Picked colour ${colorInput.value}`);
}

/**
 * Shorten the current drawing's exposure by one frame — the counterpart to
 * the Hold +1 button.
 */
function shrinkExposure() {
  const layer = currentLayer();
  const info = exposureInfo(layer, state.project.currentFrame);
  if (info.kind !== "head" && info.kind !== "hold") {
    setStatus("There is no drawing at this frame", true);
    return;
  }
  if (info.count <= 1) {
    setStatus("The exposure is already at its shortest");
    return;
  }
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  setExposure(layer, state.project.currentFrame, info.count - 1);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Exposure shortened to ${info.count - 1} frame${info.count - 1 === 1 ? "" : "s"}`);
}

/* ------------------------------------------------------------- settings */

const SETTINGS_KEY = "tvmini.settings.v1";

/**
 * The size of the rows of the timeline.
 *
 * The compact view is the small one: a row is one line high and the whole
 * timeline fits in a thin band of the window. The other view gives the rows
 * room for a name and a picture.
 */
function applyCompactView() {
  document.body.classList.toggle("tl-rows-tall", !state.compactTimeline);
  if (!compactViewButton) return;
  compactViewButton.classList.toggle("on", state.compactTimeline);
  compactViewButton.setAttribute("aria-pressed", state.compactTimeline ? "true" : "false");
}

function clampOnion(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.min(5, Math.max(0, number)) : fallback;
}

function loadSettings() {
  try {
    const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") || {};
    if (Number.isFinite(data.pressureGain)) {
      state.pressureGain = Math.min(3, Math.max(0.25, data.pressureGain));
    }
    state.touchDraw = data.touchDraw !== false;
    state.showStart = data.showStart !== false;
    if ([0.25, 0.5, 1, 2].includes(data.playSpeed)) state.playSpeed = data.playSpeed;
    if (data.onion && typeof data.onion === "object") {
      state.onion.enabled = data.onion.enabled === true;
      state.onion.before = clampOnion(data.onion.before, 2);
      state.onion.after = clampOnion(data.onion.after, 1);
    }
    if (Number.isFinite(data.stabilizer)) {
      // The slider used to run from 0 to 10 and now runs from 0 to 100, so
      // the number that was remembered is put ten times further along.
      const remembered =
        data.stabilizerScale === 100 ? data.stabilizer : data.stabilizer * 10;
      state.toolSettings.brush.stabilizer = Math.max(
        0,
        Math.min(100, Math.round(remembered)),
      );
    }
    // The settings of each tool are remembered, so the pencil keeps its own
    // width and the brush keeps its own.
    if (data.toolSettings && typeof data.toolSettings === "object") {
      for (const [name, settings] of Object.entries(data.toolSettings)) {
        const known = state.toolSettings[name];
        if (!known || !settings || typeof settings !== "object") continue;
        if (Number.isFinite(settings.width)) {
          known.width = Math.max(1, Math.min(300, Math.round(settings.width)));
        }
        if (Number.isFinite(settings.stabilizer)) {
          known.stabilizer = Math.max(0, Math.min(100, Math.round(settings.stabilizer)));
        }
        if (Number.isFinite(settings.opacity)) {
          known.opacity = Math.max(1, Math.min(100, Math.round(settings.opacity)));
        }
        if (typeof settings.blend === "string") known.blend = settings.blend;
        if (typeof settings.binarize === "boolean") known.binarize = settings.binarize;
      }
    }
    state.compactTimeline = data.compactTimeline !== false;
  } catch {
    // A blocked or broken store only loses the remembered preferences.
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        pressureGain: state.pressureGain,
        touchDraw: state.touchDraw,
        showStart: state.showStart,
        playSpeed: state.playSpeed,
        stabilizer: state.toolSettings.brush.stabilizer,
        stabilizerScale: 100,
        toolSettings: state.toolSettings,
        compactTimeline: state.compactTimeline,
        onion: { ...state.onion },
      }),
    );
  } catch {
    // The same as above: persisting a preference is best-effort.
  }
}

function syncSettingsUI() {
  const percent = Math.round(state.pressureGain * 100);
  pressureGainInput.value = String(percent);
  pressureGainValue.textContent = `${percent}%`;
  touchDrawInput.checked = state.touchDraw;
  showStartInput.checked = state.showStart;
  speedInput.value = String(state.playSpeed);
  const settings = toolSettings();
  stabilizerInput.value = String(settings.stabilizer);
  stabilizerValue.textContent = String(settings.stabilizer);
  onionInput.checked = state.onion.enabled;
  onionBeforeInput.value = String(state.onion.before);
  onionAfterInput.value = String(state.onion.after);
}

function setOnion(patch) {
  Object.assign(state.onion, patch);
  syncSettingsUI();
  saveSettings();
  renderCanvas();
}

pressureGainInput.addEventListener("input", () => {
  state.pressureGain = Number(pressureGainInput.value) / 100;
  pressureGainValue.textContent = `${pressureGainInput.value}%`;
  setStatus(`Pressure gain ${pressureGainInput.value}%`);
});
pressureGainInput.addEventListener("change", saveSettings);

touchDrawInput.addEventListener("change", () => {
  state.touchDraw = touchDrawInput.checked;
  saveSettings();
  setStatus(
    state.touchDraw
      ? "Touch drawing on — a finger draws as well as a stylus"
      : "Touch drawing off — only the stylus and mouse draw",
  );
});

showStartInput.addEventListener("change", () => {
  state.showStart = showStartInput.checked;
  saveSettings();
});

stabilizerInput.addEventListener("input", () => {
  const value = Math.max(0, Math.min(100, Math.round(Number(stabilizerInput.value))));
  toolSettings().stabilizer = value;
  stabilizerValue.textContent = String(value);
  setStatus(value === 0 ? "Stabiliser off" : `Stabiliser ${value} — new strokes get smoother`);
});
stabilizerInput.addEventListener("change", saveSettings);

clearButton.addEventListener("click", clearDrawing);
undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);

layerNameInput.addEventListener("change", changeLayerName);
layerNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") layerNameInput.blur();
});

opacityInput.addEventListener("pointerdown", () => {
  state.opacityBefore = snapshot();
});
opacityInput.addEventListener("focus", () => {
  if (!state.opacityBefore) state.opacityBefore = snapshot();
});
opacityInput.addEventListener("input", () => {
  const layer = currentLayer();
  layer.opacity = Number(opacityInput.value) / 100;
  opacityValue.textContent = `${Math.round(layer.opacity * 100)}%`;
  renderCanvas();
  markDirty();
});
opacityInput.addEventListener("change", () => {
  const before = state.opacityBefore;
  state.opacityBefore = null;
  if (before) recordHistory(before);
  markDirty();
  setStatus(`Opacity: ${Math.round(currentLayer().opacity * 100)}%`);
});

preBehaviorInput.addEventListener("change", () => changeBehavior("pre"));
postBehaviorInput.addEventListener("change", () => changeBehavior("post"));

/**
 * Put the transform of the cell that is on the frame.
 *
 * The transform says where the picture of the cell sits on the canvas, how
 * big it is and how far it is turned. It is a part of the cell, so it is
 * kept with it in the project file and written with it to a `.clip`.
 */
function changeTransform() {
  const layer = currentLayer();
  if (!layer || isGroup(layer)) return null;
  const resolved = resolveDrawing(layer, state.project.currentFrame);
  if (!resolved) return null;

  const scale = Number(transformScaleInput.value) / 100;
  const rotation = Number(transformRotationInput.value);
  const x = Number(transformXInput.value);
  const y = Number(transformYInput.value);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (!Number.isFinite(rotation) || !Number.isFinite(x) || !Number.isFinite(y)) return null;

  const drawing = resolved.drawing;
  const before = snapshot();
  drawing.transform = { x, y, scale, rotation };
  recordHistory(before);
  markDirty();
  renderCanvas();
  syncLayerControls();
  return drawing;
}

/**
 * Put the size of the cell that is on the frame.
 *
 * The slider is moved while the pointer is down, so the size is put on the
 * cell as it goes and the history is only written when the pointer is let
 * go.
 */
function applyTransformScale() {
  const layer = currentLayer();
  if (!layer || isGroup(layer)) return;
  const resolved = resolveDrawing(layer, state.project.currentFrame);
  if (!resolved) return;
  const scale = Number(transformScaleInput.value) / 100;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const transform = transformOf(resolved.drawing);
  resolved.drawing.transform = { ...transform, scale };
  transformScaleValue.textContent = `${Math.round(scale * 100)}%`;
  renderCanvas();
  markDirty();
}

transformXInput.addEventListener("change", changeTransform);
transformYInput.addEventListener("change", changeTransform);
transformRotationInput.addEventListener("change", changeTransform);
transformScaleInput.addEventListener("pointerdown", () => {
  state.transformBefore = snapshot();
});
transformScaleInput.addEventListener("input", applyTransformScale);
transformScaleInput.addEventListener("change", () => {
  // The slider may be moved with the keyboard, and then the value arrives
  // without a pointer going down first.
  applyTransformScale();
  const before = state.transformBefore;
  state.transformBefore = null;
  if (before) recordHistory(before);
  markDirty();
});
transformResetButton.addEventListener("click", () => {
  const layer = currentLayer();
  if (!layer || isGroup(layer)) return;
  const resolved = resolveDrawing(layer, state.project.currentFrame);
  if (!resolved) return;
  const before = snapshot();
  delete resolved.drawing.transform;
  recordHistory(before);
  markDirty();
  renderCanvas();
  syncLayerControls();
  setStatus("The cell is back where it was drawn");
});

playButton.addEventListener("click", togglePlayback);
firstFrameButton.addEventListener("click", gotoFirstFrame);
previousKeyButton.addEventListener("click", gotoPreviousKey);
nextKeyButton.addEventListener("click", gotoNextKey);
lastFrameButton.addEventListener("click", gotoLastFrame);
loopInput.addEventListener("change", toggleLoop);
fpsInput.addEventListener("change", changeFps);
startFrameInput.addEventListener("change", changeStartFrame);
frameCountInput.addEventListener("change", changeFrameCount);
addLayerButton.addEventListener("click", addLayer);
addGroupButton.addEventListener("click", addGroup);
removeGroupButton.addEventListener("click", removeGroup);
deleteLayerButton.addEventListener("click", deleteLayer);
layerUpButton.addEventListener("click", () => moveLayer(-1));
layerDownButton.addEventListener("click", () => moveLayer(1));

/* The layers panel does the same things as the toolbar of the timeline. */
panelAddLayerButton.addEventListener("click", addLayer);
panelAddFolderButton.addEventListener("click", addGroup);
panelAddAnimationFolderButton.addEventListener("click", addAnimationFolder);
panelDuplicateLayerButton.addEventListener("click", duplicateLayer);
panelDeleteLayerButton.addEventListener("click", deleteLayer);
panelLayerUpButton.addEventListener("click", () => moveLayer(-1));
panelLayerDownButton.addEventListener("click", () => moveLayer(1));
panelUnfoldButton.addEventListener("click", takeOutOfFolder);

layerOpacityInput.addEventListener("input", () => {
  const project = state.project;
  const layer = project.layers[project.currentLayer];
  if (!layer) return;
  const before = snapshot();
  layer.opacity = Math.max(0, Math.min(1, Number(layerOpacityInput.value) / 100));
  layerOpacityOut.textContent = layerOpacityInput.value;
  recordHistory(before);
  markDirty();
  renderCanvas();
});

layerOpacityInput.addEventListener("change", () => {
  afterChange();
  setStatus(`${currentLayer().name} is at ${layerOpacityInput.value}%`);
});

layerLockButton.addEventListener("click", () => {
  toggleLock(state.project.currentLayer);
  renderLayerPanel();
});

layerKindSelect.addEventListener("change", () => {
  const project = state.project;
  const index = project.currentLayer;
  const layer = project.layers[index];
  if (!layer) return;
  const want = layerKindSelect.value;
  if (want === "group" && !isGroup(layer)) {
    addGroup();
  } else if (want === "anim" && isGroup(layer)) {
    removeGroup();
  }
  renderLayerPanel();
});
clipLayerInput.addEventListener("change", toggleClip);
cellNamesButton.addEventListener("click", () => {
  state.showCellNames = !state.showCellNames;
  cellNamesButton.classList.toggle("on", state.showCellNames);
  renderTimeline();
  setStatus(state.showCellNames ? "The names of the cells are shown" : "The names of the cells are hidden");
});
keyMarkersButton.addEventListener("click", () => {
  state.showKeyMarkers = !state.showKeyMarkers;
  keyMarkersButton.classList.toggle("on", state.showKeyMarkers);
  renderTimeline();
  setStatus(state.showKeyMarkers ? "The keys are marked above the frames" : "The keys are hidden");
});
compactViewButton.addEventListener("click", () => {
  state.compactTimeline = !state.compactTimeline;
  applyCompactView();
  renderTimeline();
  saveSettings();
  setStatus(
    state.compactTimeline
      ? "The rows of the timeline are small"
      : "The rows of the timeline have room for a name",
  );
});
timelineMenuButton.addEventListener("click", () => {
  const open = timelineMenu.hidden;
  closeMenus();
  if (open) {
    menuFps.value = String(state.project.fps);
    menuStartFrame.value = String(state.project.startFrame);
    menuLoop.checked = state.project.loop;
    menuOnion.checked = state.onion.enabled;
    timelineMenu.hidden = false;
    timelineMenuButton.setAttribute("aria-expanded", "true");
  }
});
menuFps.addEventListener("change", () => {
  fpsInput.value = menuFps.value;
  changeFps();
});
menuStartFrame.addEventListener("change", () => {
  startFrameInput.value = menuStartFrame.value;
  changeStartFrame();
});
menuLoop.addEventListener("change", () => {
  loopInput.checked = menuLoop.checked;
  toggleLoop();
});
menuOnion.addEventListener("change", () => {
  setOnion({ enabled: menuOnion.checked });
  setStatus(state.onion.enabled ? "Onion skin on" : "Onion skin off");
});
menuAddFolder.addEventListener("click", () => {
  closeMenus();
  addAnimationFolder();
});
menuFirstFrame.addEventListener("click", () => {
  closeMenus();
  gotoFirstFrame();
});
menuLastFrame.addEventListener("click", () => {
  closeMenus();
  gotoLastFrame();
});
addFrameButton.addEventListener("click", addDrawing);
duplicateFrameButton.addEventListener("click", duplicateFrame);
holdButton.addEventListener("click", holdFrame);
deleteFrameButton.addEventListener("click", deleteFrame);
exposureInput.addEventListener("change", changeExposure);
exposureInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") exposureInput.blur();
});
startFrameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") startFrameInput.blur();
});
frameCountInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") frameCountInput.blur();
});
fpsInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") fpsInput.blur();
});

/* --------------------------------------------------------------- menu bar */

function closeMenus() {
  fileMenu.hidden = true;
  fileButton.setAttribute("aria-expanded", "false");
  recentMenu.hidden = true;
  helpMenu.hidden = true;
  helpButton.setAttribute("aria-expanded", "false");
  if (timelineMenu) {
    timelineMenu.hidden = true;
    timelineMenuButton.setAttribute("aria-expanded", "false");
  }
}

fileButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = fileMenu.hidden;
  helpMenu.hidden = true;
  helpButton.setAttribute("aria-expanded", "false");
  fileMenu.hidden = !open;
  fileButton.setAttribute("aria-expanded", String(open));
});

helpButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = helpMenu.hidden;
  fileMenu.hidden = true;
  fileButton.setAttribute("aria-expanded", "false");
  helpMenu.hidden = !open;
  helpButton.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!fileMenu.hidden && !fileMenu.contains(event.target) && event.target !== fileButton) {
    closeMenus();
  }
  if (!helpMenu.hidden && !helpMenu.contains(event.target) && event.target !== helpButton) {
    closeMenus();
  }
});

fileMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  closeMenus();
  handleAction(button.dataset.action);
});

helpMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-help]");
  if (!button) return;
  closeMenus();
  if (button.dataset.help === "guide") showGuide();
  else showKeys();
});

recentMenu.parentElement.addEventListener("click", (event) => {
  if (!event.target.closest(".submenu > button")) return;
  event.stopPropagation();
  const show = recentMenu.hidden;
  recentMenu.hidden = !show;
  event.target.closest(".submenu > button").setAttribute("aria-expanded", String(show));
});

function renderRecent() {
  recentMenu.replaceChildren();


  const importFLAButton = document.createElement("button");
  importFLAButton.type = "button";
  importFLAButton.className = "recent-import";
  importFLAButton.textContent = "Import FLA...";
  importFLAButton.addEventListener("click", () => {
    closeMenus();
    return chooseAndImportFLA();
  });
  recentMenu.append(importFLAButton);

  if (state.recent.length === 0) {
    const empty = document.createElement("button");
    empty.disabled = true;
    empty.textContent = "No recent projects";
    recentMenu.append(empty);
    return;
  }

  for (const entry of state.recent) {
    const button = document.createElement("button");
    button.type = "button";

    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = entry.name;

    const filePath = document.createElement("span");
    filePath.className = "recent-path";
    filePath.textContent = entry.path;

    button.append(name, filePath);
    button.addEventListener("click", () => {
      closeMenus();
      openPath(entry.path ?? entry.name);
    });
    recentMenu.append(button);
  }

  renderStartRecent();
}
async function refreshRecent() {
  try {
    state.recent = await backend.listRecent();
    renderRecent();
  } catch (error) {
    setStatus(error.message, true);
  }
}

/* --------------------------------------------------------------- actions */

async function handleAction(action) {
  try {
  
    if (action === "new") return newProject();
    if (action === "open") return chooseAndOpen();
    if (action === "importClip") return chooseAndImportClip();
    if (action === "importTvpp") return chooseAndImportTvpp();
    if (action === "importAudio") return chooseAndImportAudio();
    if (action === "removeAudio") return removeAudio();
    if (action === "save") return save();
    if (action === "saveAs") return saveAs();
    if (action === "export") return exportPng();
    if (action === "exportClip") return exportClip();
    if (action === "exportTvpp") return exportTvpp();
    if (action === "importPictures") return chooseAndImportPictures();
    if (action === "importFLA") return chooseAndImportFLA();
    if (action === "exportSettings") return openExportSettings();
    if (action === "exportTimeSheet") return openTimeSheet();
    const kind = EXPORT_ACTIONS[action];
    if (kind) return exportKind(kind);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tvmini] ${action} failed`, error);
    setStatus(message, true);
  }
}

function confirmDiscard() {
  if (!state.dirty) return true;
  return confirm("This project has unsaved changes. Discard them?");
}

/* ------------------------------------------------------------ new project */

/** What the new-project dialog is holding while it is open. */
const newProjectState = {
  ratio: "16:9",
  paper: "A4",
  dpi: 150,
  width: 1754,
  height: 1240,
  cameraWidth: 1500,
  cameraHeight: 844,
  cameraX: 127,
  cameraY: 262,
  constrain: true,
};

/** The elements of the new-project dialog. */
function newProjectFields() {
  return {
    name: document.getElementById("newName"),
    paper: document.getElementById("newPaperSize"),
    dpi: document.getElementById("newDpi"),
    width: document.getElementById("newPaperWidth"),
    height: document.getElementById("newPaperHeight"),
    ratios: document.getElementById("newCameraRatios"),
    constrain: document.getElementById("newConstrain"),
    cameraWidth: document.getElementById("newCameraWidth"),
    cameraHeight: document.getElementById("newCameraHeight"),
    cameraX: document.getElementById("newCameraX"),
    cameraY: document.getElementById("newCameraY"),
    info: document.getElementById("newPreviewInfo"),
    canvas: document.getElementById("newPreview"),
  };
}

/** Put the numbers of the dialog into the fields. */
function fillNewProject(fields) {
  fields.name.value = "untitled";
  fields.paper.value = newProjectState.paper;
  fields.dpi.value = String(newProjectState.dpi);
  fields.width.value = String(newProjectState.width);
  fields.height.value = String(newProjectState.height);
  fields.constrain.checked = newProjectState.constrain;
  fields.cameraWidth.value = String(newProjectState.cameraWidth);
  fields.cameraHeight.value = String(newProjectState.cameraHeight);
  fields.cameraX.value = String(newProjectState.cameraX);
  fields.cameraY.value = String(newProjectState.cameraY);
  for (const chip of fields.ratios.querySelectorAll("[data-ratio]")) {
    chip.classList.toggle("on", chip.dataset.ratio === newProjectState.ratio);
  }
}

/** Take the numbers out of the fields. */
function readNewProject(fields) {
  const number = (input, fallback) => {
    const value = Math.round(Number(input.value));
    return Number.isFinite(value) ? value : fallback;
  };
  newProjectState.width = Math.max(16, Math.min(8192, number(fields.width, newProjectState.width)));
  newProjectState.height = Math.max(16, Math.min(8192, number(fields.height, newProjectState.height)));
  newProjectState.cameraWidth = Math.max(16, Math.min(8192, number(fields.cameraWidth, newProjectState.cameraWidth)));
  newProjectState.cameraHeight = Math.max(16, Math.min(8192, number(fields.cameraHeight, newProjectState.cameraHeight)));
  newProjectState.cameraX = Math.max(0, Math.min(8192, number(fields.cameraX, newProjectState.cameraX)));
  newProjectState.cameraY = Math.max(0, Math.min(8192, number(fields.cameraY, newProjectState.cameraY)));
  newProjectState.dpi = Math.max(30, Math.min(1200, number(fields.dpi, newProjectState.dpi)));
  newProjectState.constrain = fields.constrain.checked;
}

/**
 * The camera of the dialog, in the pixels of the paper.
 *
 * The frame is always centred horizontally, the way Clip Studio Paint holds
 * it, and it is never larger than the paper.
 */
function newProjectCamera() {
  return cameraWindow(
    { width: newProjectState.width, height: newProjectState.height },
    {
      width: newProjectState.cameraWidth,
      height: newProjectState.cameraHeight,
      y: newProjectState.cameraY,
    },
  );
}

/** Draw the paper and the camera frame in the preview. */
function drawNewProjectPreview(fields) {
  const canvas = fields.canvas;
  const context = canvas.getContext("2d");
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  if (box.width && Math.abs(canvas.width - box.width * ratio) > 1) {
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);

  const padding = 12 * ratio;
  const scale = Math.min(
    (canvas.width - padding * 2) / newProjectState.width,
    (canvas.height - padding * 2) / newProjectState.height,
  );
  const paperWidth = newProjectState.width * scale;
  const paperHeight = newProjectState.height * scale;
  const left = (canvas.width - paperWidth) / 2;
  const top = (canvas.height - paperHeight) / 2;

  // The paper.
  context.fillStyle = "#ffffff";
  context.fillRect(left, top, paperWidth, paperHeight);
  context.strokeStyle = "rgba(0,0,0,0.35)";
  context.lineWidth = ratio;
  context.strokeRect(left, top, paperWidth, paperHeight);

  // The camera frame.
  const camera = newProjectCamera();
  const frame = {
    x: left + camera.x * scale,
    y: top + camera.y * scale,
    width: camera.width * scale,
    height: camera.height * scale,
  };
  context.fillStyle = "rgba(255,60,60,0.10)";
  context.fillRect(frame.x, frame.y, frame.width, frame.height);
  context.strokeStyle = "#ff3b30";
  context.lineWidth = ratio;
  context.strokeRect(frame.x, frame.y, frame.width, frame.height);

  // The handle at the bottom right, which resizes the frame.
  const size = 6 * ratio;
  context.fillStyle = "#ff3b30";
  context.beginPath();
  context.arc(frame.x + frame.width, frame.y + frame.height, size * 0.8, 0, Math.PI * 2);
  context.fill();

  fields.info.textContent =
    `Paper ${newProjectState.width} × ${newProjectState.height} · ${newProjectState.paper} at ${newProjectState.dpi} dpi · ` +
    `Camera ${camera.width} × ${camera.height} (${newProjectState.ratio}) at ${camera.x}, ${camera.y}`;
  return { scale, left, top };
}

/** Open the dialog that asks for the size of a new document. */
function openNewProjectDialog() {
  if (!confirmDiscard()) return;
  const fields = newProjectFields();
  fillNewProject(fields);
  document.getElementById("newProjectModal").hidden = false;
  drawNewProjectPreview(fields);
  fields.name.focus();
  fields.name.select();
}

/** Create the document the dialog asks for. */
function createFromNewProject() {
  const fields = newProjectFields();
  readNewProject(fields);
  const camera = newProjectCamera();
  const name = fields.name.value.trim() || "untitled";

  stopPlayback();
  const fresh = {
    project: blankProject(newProjectState.width, newProjectState.height),
    currentPath: null,
    suggestedName: `${name}.tvmini`,
    clipSourcePath: null,
    tvppSourcePath: null,
    dirty: false,
    history: new History({ limit: 100 }),
  };
  fresh.project.camera = {
    keys: [
      {
        frame: 1,
        x: camera.x,
        y: camera.y,
        width: camera.width,
        height: camera.height,
        rotation: 0,
        interp: "linear",
      },
    ],
  };
  fresh.project.title = name;

  captureDocument();
  state.documents.push(fresh);
  state.activeIndex = state.documents.length - 1;
  loadDocument(fresh);

  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  renderDocumentTabs();
  document.getElementById("newProjectModal").hidden = true;
  setStatus(
    `New project "${name}": ${newProjectState.width}×${newProjectState.height}, ` +
      `camera ${camera.width}×${camera.height}.`,
  );
}

/** Put the camera at the shape of a ratio, in the middle of the paper. */
function applyCameraRatio(fields, ratio) {
  newProjectState.ratio = ratio;
  if (ratio === "free") {
    // The shape stays as it is; the camera can be dragged to any size.
  } else {
    const camera = cameraOfRatio(
      { width: newProjectState.width, height: newProjectState.height },
      ratio,
    );
    newProjectState.cameraWidth = camera.width;
    newProjectState.cameraHeight = camera.height;
    newProjectState.cameraX = camera.x;
    newProjectState.cameraY = camera.y;
  }
  fillNewProject(fields);
  drawNewProjectPreview(fields);
}

function newProject() {
  openNewProjectDialog();
}

/**
 * Wire the new-project dialog: the fields, the shape buttons and the
 * preview, which can be dragged.
 */
function wireNewProjectDialog() {
  const fields = newProjectFields();
  const modal = document.getElementById("newProjectModal");

  document.getElementById("newCancel").addEventListener("click", () => {
    modal.hidden = true;
  });
  document.getElementById("newCreate").addEventListener("click", createFromNewProject);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });

  // The paper: a standard size at a number of dots an inch, or a free size.
  const applyPaper = () => {
    readNewProject(fields);
    const pixels = paperPixels(fields.paper.value, newProjectState.dpi);
    if (pixels) {
      newProjectState.width = pixels[0];
      newProjectState.height = pixels[1];
    }
    applyCameraRatio(fields, newProjectState.ratio);
  };
  fields.paper.addEventListener("change", applyPaper);
  fields.dpi.addEventListener("change", applyPaper);

  // The camera shape.
  fields.ratios.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-ratio]");
    if (!chip) return;
    readNewProject(fields);
    applyCameraRatio(fields, chip.dataset.ratio);
  });

  // Every number of the dialog draws the preview again.
  for (const input of [
    fields.width,
    fields.height,
    fields.cameraWidth,
    fields.cameraHeight,
    fields.cameraX,
    fields.cameraY,
  ]) {
    input.addEventListener("input", () => {
      readNewProject(fields);
      drawNewProjectPreview(fields);
    });
  }
  fields.constrain.addEventListener("change", () => {
    readNewProject(fields);
    drawNewProjectPreview(fields);
  });

  // The preview: the frame is dragged to move it, the handle resizes it.
  const canvas = fields.canvas;
  let drag = null;
  const point = (event) => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  canvas.addEventListener("pointerdown", (event) => {
    readNewProject(fields);
    const { scale, left, top } = drawNewProjectPreview(fields);
    const camera = newProjectCamera();
    const at = point(event);
    const handle = {
      x: left + (camera.x + camera.width) * scale,
      y: top + (camera.y + camera.height) * scale,
    };
    const onHandle = Math.hypot(at.x - handle.x, at.y - handle.y) < 12;
    const inside =
      at.x >= left + camera.x * scale &&
      at.x <= left + (camera.x + camera.width) * scale &&
      at.y >= top + camera.y * scale &&
      at.y <= top + (camera.y + camera.height) * scale;
    if (!onHandle && !inside) return;
    drag = { scale, left, top, mode: onHandle ? "resize" : "move", at, camera };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const at = point(event);
    const dx = (at.x - drag.at.x) / drag.scale;
    const dy = (at.y - drag.at.y) / drag.scale;
    if (drag.mode === "move") {
      newProjectState.cameraY = Math.max(
        0,
        Math.min(newProjectState.height - drag.camera.height, Math.round(drag.camera.y + dy)),
      );
    } else {
      const width = Math.round(drag.camera.width + dx);
      const height = Math.round(drag.camera.height + dy);
      newProjectState.cameraWidth = Math.max(16, Math.min(newProjectState.width, width));
      newProjectState.cameraHeight = Math.max(16, Math.min(newProjectState.height, height));
      if (newProjectState.constrain) {
        // The shape of the camera is kept when the position is constrained.
        const shape = drag.camera.width / drag.camera.height;
        const fitted = Math.round(newProjectState.cameraHeight * shape);
        if (Math.abs(fitted - newProjectState.cameraWidth) < Math.abs(newProjectState.cameraHeight - height)) {
          newProjectState.cameraWidth = Math.max(16, Math.min(newProjectState.width, fitted));
        } else {
          newProjectState.cameraHeight = Math.max(
            16,
            Math.min(newProjectState.height, Math.round(newProjectState.cameraWidth / shape)),
          );
        }
      }
    }
    fillNewProject(fields);
    drawNewProjectPreview(fields);
  });
  const endDrag = () => {
    drag = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
}

/**
 * Decode the sound of the current project so the timeline can draw its
 * waveform. The sound travels with the project file, so this runs again
 * every time a project is opened.
 */
async function loadSoundTrack() {
  state.audioPeaks = null;
  const audio = state.project.audio;
  if (!audio) {
    renderTimeline();
    return;
  }
  const buffer = await decodeSound(audio.data);
  if (!buffer) {
    setStatus("The sound in this project could not be decoded", true);
    return;
  }
  state.audioPeaks = soundPeaks(buffer);
  renderTimeline();
}

/**
 * Open a file the program was given: a project, or a `.clip`, `.tvpp` or
 * Flash document that is imported as layers.
 *
 * `discardConfirmed` is set by the one caller that has already asked about
 * unsaved changes, so the question is not asked twice.
 */
async function openPath(filePath, { discardConfirmed = false } = {}) {
  if (!discardConfirmed && !confirmDiscard()) return;
  if (/\.(fla|xfl)$/i.test(filePath) && typeof backend.importFl === "function") return importFl(filePath);
  if (/\.clip$/i.test(filePath)) return importClip(filePath);
  if (/\.tvpp$/i.test(filePath)) return importTvpp(filePath);

  const data = await backend.open(filePath);
  if (!data) return;
  stopPlayback();
  showDocument(data.project, { currentPath: data.name });
  if (data.recent) state.recent = data.recent;
  renderRecent();
  setStatus(`Opened ${baseName(data.name)}`);
}

/* ------------------------------------------------- the loading of an import */

/**
 * The loading window an import shows: the file being read, the step the
 * import is on, a bar that fills while the work runs and a way out. The
 * parsing itself cannot be interrupted, so Cancel hides the window and the
 * finished import is simply not put on the canvas.
 */
let importLoading = null;
// The names of imports the person cancelled while they were running. The
// parsing keeps going underneath, so when the result arrives it is checked
// against this list - keyed by name, because another import may have begun
// in the meantime and its result must still be applied.
const importCancelledNames = new Set();

/** The backend reports the steps of an import; this shows them. */
function importProgressFromBackend(payload) {
  if (!payload) return;
  if (payload.start) {
    showImportLoading(payload.name || "file", payload.phase || "Preparing what you cooked");
    return;
  }
  if (payload.phase) setImportLoadingPhase(payload.phase);
  if (payload.done) finishImportLoading();
}

function showImportLoading(name, phase) {
  const card = document.getElementById("importLoading");
  document.getElementById("importLoadingName").textContent = name;
  document.getElementById("importLoadingPhase").textContent = phase;
  // Importing this file again is a decision of its own, not the cancelled
  // one coming back.
  importCancelledNames.delete(name);
  if (importLoading) {
    clearTimeout(importLoading.timer);
    clearTimeout(importLoading.hideTimer);
  }
  importLoading = { name, percent: 0, timer: 0, hideTimer: 0 };
  paintImportLoading();
  document.getElementById("importLoadingCancel").onclick = () => {
    if (!importLoading) return;
    importCancelledNames.add(importLoading.name);
    hideImportLoading();
    setStatus("Import cancelled");
  };
  card.hidden = false;
  // The bar walks toward the end while the work runs: an import of a few
  // seconds reads as progress, and the last stretch fills when it is done.
  const step = () => {
    if (!importLoading) return;
    importLoading.percent = Math.min(90, importLoading.percent + (92 - importLoading.percent) * 0.08);
    paintImportLoading();
    importLoading.timer = setTimeout(step, 120);
  };
  step();
}

function setImportLoadingPhase(text) {
  if (!importLoading) return;
  document.getElementById("importLoadingPhase").textContent = text;
}

function paintImportLoading() {
  const percent = Math.round(importLoading?.percent ?? 0);
  document.getElementById("importLoadingFill").style.width = `${percent}%`;
  document.getElementById("importLoadingPercent").textContent = `${percent}%`;
}

function finishImportLoading() {
  if (!importLoading) return;
  clearTimeout(importLoading.timer);
  importLoading.percent = 100;
  paintImportLoading();
  importLoading.hideTimer = setTimeout(() => hideImportLoading(), 240);
}

function hideImportLoading() {
  if (!importLoading) return;
  clearTimeout(importLoading.timer);
  clearTimeout(importLoading.hideTimer);
  document.getElementById("importLoading").hidden = true;
  importLoading = null;
}

/** Was the import of this file cancelled while it ran? The answer is taken. */
function importLoadingWasCancelled(name) {
  if (!name || !importCancelledNames.has(name)) return false;
  importCancelledNames.delete(name);
  return true;
}

/** Put an imported .clip/.tvpp onto the canvas (shared by every import path). */
function applyImportedProject(data, extension) {
  stopPlayback();
  showDocument(data.project, {
    suggestedName: `${data.name.replace(new RegExp(`\\.${extension}$`, "i"), "")}.tvmini`,
    clipSourcePath: extension === "clip" ? data.path || null : null,
    tvppSourcePath: extension === "tvpp" ? data.path || null : null,
  });
  const warnings = Array.isArray(data.warnings) && data.warnings.length
    ? ` (${data.warnings.join("; ")})`
    : "";
  if (extension === "tvpp") {
    const layers = data.project.layers.length;
    const images = data.project.layers.reduce((n, l) => n + l.drawings.length, 0);
    setStatus(
      `Imported ${data.name}: ${layers} layer${layers === 1 ? "" : "s"}, ` +
        `${images} frame${images === 1 ? "" : "s"}${warnings}. Save as .tvmini to keep it.`,
    );
  } else {
    const layers = data.project.layers.length;
    const cells = data.project.layers.reduce((n, l) => n + l.drawings.length, 0);
    const folders = data.project.layers.filter((l) => l.type === "group").length;
    setStatus(
      `Imported ${data.name} (${data.project.width}x${data.project.height}): ` +
        `${layers} layer(s), ${folders} folder(s), ${cells} cell(s) at ${data.project.fps} fps. ` +
        "Save as .tvmini to keep it, or export a .clip - the .clip itself is never changed.",
    );
  }
}

async function importClip(filePath) {
  const data = await backend.importClip(filePath);
  if (!data || importLoadingWasCancelled(data.name)) return;
  applyImportedProject(data, "clip");
}

async function chooseAndImportClip() {
  if (!confirmDiscard()) return;
  const data = await backend.chooseAndImportClip();
  if (!data || importLoadingWasCancelled(data.name)) return;
  applyImportedProject(data, "clip");
}

async function importTvpp(filePath) {
  const data = await backend.importTvpp(filePath);
  if (!data || importLoadingWasCancelled(data.name)) return;
  applyImportedProject(data, "tvpp");
}

/** Put an imported Flash document onto the canvas (shared by every .fla import path). */
function applyImportedFla(data) {
  stopPlayback();
  showDocument(data.project, {
    suggestedName: `${data.name.replace(/\.[^.]+$/, "")}.tvmini`,
    clipSourcePath: null,
    tvppSourcePath: null,
  });
  // Show the whole drawing, in the middle: Flash artwork often reaches past
  // the canvas, and at 100% the pane would open on one corner of it.
  fitStage();
  const layers = data.project.layers.length;
  const cells = data.project.layers.reduce((n, l) => n + l.drawings.length, 0);
  const warnings = Array.isArray(data.warnings) && data.warnings.length
    ? ` (${data.warnings.join("; ")})`
    : "";
  setStatus(
    `Imported ${data.name} (${data.project.width}x${data.project.height}): ` +
      `${layers} layer${layers === 1 ? "" : "s"}, ${cells} cell${cells === 1 ? "" : "s"} at ` +
      `${data.project.fps} fps${warnings}. Save as .tvmini to keep it.`,
  );
}

async function importFl(filePath) {
  try {
    const data = await backend.importFl(filePath);
    if (data && !importLoadingWasCancelled(data.name)) applyImportedFla(data);
  } catch (error) {
    setStatus(`FLA import failed: ${error instanceof Error ? error.message : String(error)}`, true);
    console.error("FLA import error", error);
  }
}

/** Choose and import a Flash `.fla` / `.xfl` document (File menu and the recent-files popup). */
async function chooseAndImportFLA() {
  if (!confirmDiscard()) return;
  try {
    const data = await backend.chooseAndImportFLA();
    if (!data) {
      setStatus("FLA import cancelled", true);
      return;
    }
    if (importLoadingWasCancelled(data.name)) return;
    applyImportedFla(data);
  } catch (error) {
    setStatus(`FLA import failed: ${error instanceof Error ? error.message : String(error)}`, true);
    console.error("FLA import error", error);
  }
}

async function chooseAndImportTvpp() {
  if (!confirmDiscard()) return;
  const data = await backend.chooseAndImportTvpp();
  if (!data || importLoadingWasCancelled(data.name)) return;
  applyImportedProject(data, "tvpp");
}

/* ------------------------------------------------------------------ audio */

/** Put a sound on the timeline and work out its waveform. */
async function importAudio(name, base64) {
  const project = state.project;
  const before = snapshot();

  const buffer = await decodeSound(base64);
  if (!buffer) {
    setStatus("This sound could not be decoded by the browser", true);
    return;
  }

  project.audio = {
    name,
    data: base64,
    duration: buffer.duration,
    offset: 0,
  };
  state.audioPeaks = soundPeaks(buffer);
  recordHistory(before);
  markDirty();
  renderTimeline();
  setStatus(`Sound "${name}" added — ${buffer.duration.toFixed(1)} seconds`);
}

async function chooseAndImportAudio() {
  const data = await backend.chooseAndImportAudio();
  if (!data) return;
  await importAudio(data.name, data.data);
}

/** Take the sound off the timeline. */
function removeAudio() {
  if (!state.project.audio) {
    setStatus("There is no sound on the timeline", true);
    return;
  }
  const before = snapshot();
  state.project.audio = null;
  state.audioPeaks = null;
  stopAudio();
  recordHistory(before);
  markDirty();
  renderTimeline();
  setStatus("Sound removed");
}

/** Start the sound with the playback, lined up with the start frame. */
function startAudio() {
  const project = state.project;
  stopAudio();
  if (!project.audio) return;

  const element = new Audio(`data:audio/*;base64,${project.audio.data}`);
  const offset = (project.currentFrame - project.startFrame) / project.fps - project.audio.offset;
  element.currentTime = Math.max(0, offset);
  element.playbackRate = 1;
  const started = element.play();
  if (started && typeof started.catch === "function") {
    started.catch(() => {
      // The browser may refuse to start the sound without a user gesture.
      setStatus("The sound could not start — press play again", true);
    });
  }
  state.audioElement = element;
}

/** Stop the sound. */
function stopAudio() {
  if (!state.audioElement) return;
  state.audioElement.pause();
  state.audioElement = null;
}

async function chooseAndOpen() {
  if (!confirmDiscard()) return;
  // With the server, the path is picked here so that a Flash document can go
  // to the importer instead of being read as a project file.
  if (backend.mode === "server") {
    const path = await choosePath({ mode: "open", title: "Open a project" });
    if (!path) return;
    return openPath(path, { discardConfirmed: true });
  }
  const data = await backend.chooseAndOpen();
  if (!data) return;
  stopPlayback();
  showDocument(data.project, { currentPath: data.name });
  if (data.recent) state.recent = data.recent;
  renderRecent();
  setStatus(`Opened ${baseName(data.name)}`);
}

async function save() {
  const data = await backend.saveProject(
    state.project,
    state.currentPath ? baseName(state.currentPath) : null,
  );
  if (!data) return;
  state.currentPath = data.name;
  state.dirty = false;
  if (data.recent) state.recent = data.recent;
  captureDocument();
  refreshTitle();
  renderDocumentTabs();
  renderRecent();
  setStatus(`Saved ${baseName(data.name)} (${data.bytes} bytes)`);
}

async function saveAs() {
  const data = await backend.saveProject(
    state.project,
    state.currentPath
      ? baseName(state.currentPath)
      : state.suggestedName || "untitled.tvmini",
    { saveAs: true },
  );
  if (!data) return;
  state.currentPath = data.name;
  state.dirty = false;
  if (data.recent) state.recent = data.recent;
  captureDocument();
  refreshTitle();
  renderDocumentTabs();
  renderRecent();
  setStatus(`Saved ${baseName(data.name)} (${data.bytes} bytes)`);
}

async function exportPng() {
  stopPlayback();
  const stem = state.currentPath
    ? baseName(state.currentPath).replace(/\.[^.]+$/, "")
    : state.suggestedName?.replace(/\.tvmini$/i, "") || "untitled";
  const data = await backend.exportPng(state.project, stem);
  if (!data) return;
  setStatus(
    `Exported frame ${state.project.currentFrame} as ${data.width}×${data.height} PNG (${data.bytes} bytes)`,
  );
  refreshTitle();
}

async function exportClip() {
  const stem = state.currentPath
    ? baseName(state.currentPath).replace(/\.[^.]+$/, "")
    : state.suggestedName?.replace(/\.tvmini$/i, "") || "untitled";
  stopPlayback();

  // The export never writes over the file the project came from, so when the
  // project is a .clip the name that is offered is another one, and the
  // folder that is offered is the one the file lies in.
  const source = state.clipSourcePath;
  const folder = source ? source.replace(/[\\/][^\\/]*$/, "") : null;
  const sameName = source
    ? baseName(source).toLowerCase() === `${stem}.clip`.toLowerCase()
    : false;
  const name = sameName ? `${stem} (export).clip` : `${stem}.clip`;

  // The program asks where the file should go first and only then builds it,
  // so the status bar says which of the two is going on.
  setStatus("Choose where to save the .clip…");
  const started = Date.now();
  let tick = null;
  let data;
  try {
    data = await backend.exportClip(
      state.project,
      stem,
      source,
      (chosen, note) => {
        setStatus(
          `Building layered .clip… (${chosen})` + (note ? ` — ${note}; the file will be downloaded instead.` : ""),
        );
        tick = setInterval(() => {
          const seconds = Math.round((Date.now() - started) / 1000);
          setStatus(`Building layered .clip… ${seconds}s (a big document takes a while)`);
        }, 1000);
      },
      { start: folder, name },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tvmini] the .clip export failed", error);
    reportToServer(`the .clip export failed: ${message}`);
    setStatus(message, true);
    if (tick) clearInterval(tick);
    return;
  }
  if (tick) clearInterval(tick);
  reportToServer(`the .clip export wrote ${data?.path ?? "nothing"}`);
  if (!data) {
    setStatus("The .clip export was cancelled, so no file was written.");
    return;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  // The layers of a `.clip` are painted larger than the stage, so that Clip
  // Studio Paint draws them sharp when it fits the canvas to its window.
  const size = data.scale > 1 && data.stageWidth
    ? `${data.width}×${data.height} (${data.scale}× the ${data.stageWidth}×${data.stageHeight} stage)`
    : `${data.width}×${data.height}`;
  setStatus(
    `Exported ${data.layers} layer${data.layers === 1 ? "" : "s"} at ${size} ` +
      `to ${data.path} (${data.bytes} bytes, ${seconds}s). ` +
      (data.animation
        ? `${data.animation} row${data.animation === 1 ? "" : "s"} of cells written as tracks.`
        : "The file holds the layers of the project, without a timeline."),
  );
  refreshTitle();
}

async function exportTvpp() {
  const stem = state.currentPath
    ? baseName(state.currentPath).replace(/\.[^.]+$/, "")
    : state.suggestedName?.replace(/\.tvmini$/i, "") || "untitled";
  stopPlayback();
  setStatus("Building .tvpp…");
  const data = await backend.exportTvpp(state.project, stem, state.tvppSourcePath);
  if (!data) return;
  setStatus(
    `Exported ${baseName(data.path)} (${data.bytes} bytes, ${data.width}×${data.height}). ` +
      "Open it in TVPaint Animation to verify.",
  );
  refreshTitle();
}

/* -------------------------------------------------- more exports, presets */

const EXPORT_ACTIONS = {
  exportPsd: "psd",
  exportGif: "gif",
  exportSheet: "sheet",
  exportSequence: "sequence",
  exportXdts: "xdts",
  exportCsv: "csv",
};

const PRESET_KEY = "tvmini.exportPresets.v1";

/** Saved export settings: `{ current: options, presets: { name: options } }`. */
function loadExportSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "null");
  } catch {
    stored = null;
  }
  const presets = {};
  for (const [name, options] of Object.entries(stored?.presets ?? {})) {
    presets[name] = cleanExportOptions(options);
  }
  return { current: cleanExportOptions(stored?.current), presets };
}

function storeExportSettings(settings) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(settings));
  } catch {
    /* the settings still apply for this session */
  }
}

state.exportSettings = loadExportSettings();

async function exportKind(kind) {
  stopPlayback();
  const stem = state.currentPath
    ? baseName(state.currentPath).replace(/\.[^.]+$/, "")
    : state.suggestedName?.replace(/\.tvmini$/i, "") || "untitled";
  setStatus(`Building ${EXPORT_KINDS[kind].label}…`);
  const data = await backend.exportFile(kind, state.project, stem, state.exportSettings.current);
  if (!data) return;
  const extra = data.extra?.length ? ` and ${data.extra.map(baseName).join(", ")}` : "";
  setStatus(`Exported ${baseName(data.path)}${extra} (${data.bytes} bytes; ${data.summary}).`);
  refreshTitle();
}

/** Put imported pictures onto the canvas (shared by the dialog and a drop). */
function applyImportedPictures(data) {
  stopPlayback();
  showDocument(data.project, {
    suggestedName: `${data.name.replace(/\.[^.]+$/, "")}.tvmini`,
    clipSourcePath: null,
    tvppSourcePath: null,
  });
  const cells = data.project.layers.reduce((n, l) => n + l.drawings.length, 0);
  setStatus(
    `Imported ${data.name} (${data.project.width}x${data.project.height}): ${cells} cell${cells === 1 ? "" : "s"} at ${data.project.fps} fps. Save as .tvmini to keep it.`,
  );
}

async function chooseAndImportPictures() {
  if (!confirmDiscard()) return;
  const data = await backend.chooseAndImportPictures();
  if (!data) return;
  applyImportedPictures(data);
}

/* ----------------------------------------------------------- drag and drop */

/**
 * Any file the program can open or import may be dropped on the window: the
 * same work the File menu does, without the dialogs. A browser never knows
 * the path of a dropped file, so the bytes travel - on the desktop the
 * bridge hands over the real path and the file is read from there, and
 * without one the server keeps a copy of its own for the importers to read.
 */

/** True while any dialog of the page is open: a drop must not fight it. */
function aModalIsOpen() {
  return [...document.querySelectorAll(".modal")].some((element) => !element.hidden);
}

/** The folder the copies of one drop are staged in, so names never collide. */
function dropSessionId() {
  return `drop-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

async function readDroppedFiles(fileList) {
  return Promise.all(
    [...fileList].map(async (file) => ({
      name: file.name,
      path: window.tvminiDesktop?.pathForFile ? String(window.tvminiDesktop.pathForFile(file) || "") : "",
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

/** Open a dropped `.tvmini`: from its path when there is one, else its bytes. */
async function dropProject(entry) {
  if (entry.path) return openPath(entry.path, { discardConfirmed: true });
  const text = new TextDecoder().decode(entry.bytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not a valid TVMini project: the file is not JSON");
  }
  const project = normalizeProject(parsed);
  stopPlayback();
  showDocument(project, { suggestedName: entry.name });
  const recent = await backend.rememberProject?.(entry.name, text);
  if (recent) {
    state.recent = recent;
    renderRecent();
  }
  setStatus(`Opened ${entry.name}`);
}

async function importDroppedFiles(fileList) {
  const dropped = await readDroppedFiles(fileList);
  const plan = planDrop(dropped.map((entry) => entry.name));
  if (!plan.kind) {
    setStatus(
      `${plan.ignored[0] ?? "That file"} cannot be opened by TVMini - drop a .tvmini, .clip, ` +
        ".tvpp, .fla or .xfl, a .sut brush, a picture (PNG, GIF, BMP, TGA) or a sound.",
      true,
    );
    return;
  }
  const chosen = plan.entries.map((index) => dropped[index]);
  const entry = chosen[0];

  // A brush joins the library and the document that is open is left as it
  // is, so a brush drop is taken without the question of a discard. Several
  // brushes come in together, the way they were picked.
  if (plan.kind === "brush") {
    const files = chosen.map(
      (item) => new File([item.bytes], item.name, { type: "application/octet-stream" }),
    );
    await importBrushFiles(files);
    return;
  }

  // A sound joins the document that is open; everything else replaces it.
  if (plan.kind !== "audio" && !confirmDiscard()) return;

  const session = dropSessionId();
  try {
    if (plan.kind === "project") return await dropProject(entry);

    if (plan.kind === "clip") {
      const data = entry.path
        ? await backend.importClip(entry.path)
        : await backend.importClipDropped(session, entry.name, entry.bytes);
      if (data && !importLoadingWasCancelled(data.name)) applyImportedProject(data, "clip");
      return;
    }

    if (plan.kind === "tvpp") {
      const data = entry.path
        ? await backend.importTvpp(entry.path)
        : await backend.importTvppDropped(session, entry.name, entry.bytes);
      if (data && !importLoadingWasCancelled(data.name)) applyImportedProject(data, "tvpp");
      return;
    }

    if (plan.kind === "fla") {
      const data = entry.path
        ? await backend.importFl(entry.path)
        : await backend.importFlaDropped(session, entry.name, entry.bytes);
      if (data && !importLoadingWasCancelled(data.name)) applyImportedFla(data);
      return;
    }

    if (plan.kind === "pictures") {
      const data =
        chosen.every((item) => item.path) && typeof backend.importPicturesPaths === "function"
          ? await backend.importPicturesPaths(chosen.map((item) => item.path))
          : await backend.importPicturesDropped(
              session,
              chosen.map((item) => ({ name: item.name, bytes: item.bytes })),
            );
      if (data) applyImportedPictures(data);
      return;
    }

    await importAudio(entry.name, bytesToBase64(entry.bytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tvmini] the dropped file failed", error);
    reportToServer(`the dropped file failed: ${message}`);
    setStatus(message, true);
  }
}

/** The veil over the window while a file is dragged over it. */
function wireDropTarget() {
  const overlay = document.getElementById("dropOverlay");
  let depth = 0;
  const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

  window.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event) || aModalIsOpen()) return;
    event.preventDefault();
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    // "none" tells the machine the drop is not wanted while a dialog is
    // open, so the file is not swallowed by the page by accident.
    if (event.dataTransfer) event.dataTransfer.dropEffect = aModalIsOpen() ? "none" : "copy";
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    depth = 0;
    overlay.hidden = true;
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (aModalIsOpen()) {
      setStatus("Close the open dialog first - a drop is not taken while it is up.", true);
      return;
    }
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) importDroppedFiles(files);
  });
}

function openExportSettings() {
  const modal = document.getElementById("exportModal");
  const presetSelect = document.getElementById("exportPreset");
  const range = document.getElementById("exportRange");
  const custom = document.getElementById("exportCustomRange");
  const from = document.getElementById("exportFrom");
  const to = document.getElementById("exportTo");
  const pattern = document.getElementById("exportPattern");
  const format = document.getElementById("exportFormat");
  const columns = document.getElementById("exportColumns");
  const scale = document.getElementById("exportScale");

  const fill = (options) => {
    const isCustom = typeof options.range === "object";
    range.value = isCustom ? "custom" : options.range;
    custom.hidden = !isCustom;
    from.value = isCustom ? options.range.from : state.project.startFrame;
    to.value = isCustom ? options.range.to : state.project.startFrame + 23;
    pattern.value = options.pattern;
    format.value = options.format;
    columns.value = options.columns;
    scale.value = options.scale ?? 100;
  };
  const read = () =>
    cleanExportOptions({
      range:
        range.value === "custom"
          ? { from: Math.floor(Number(from.value)), to: Math.floor(Number(to.value)) }
          : range.value,
      pattern: pattern.value,
      format: format.value,
      columns: Math.floor(Number(columns.value) || 0),
      scale: Math.floor(Number(scale.value) || 100),
    });
  const refreshPresets = (selected = "") => {
    presetSelect.replaceChildren(new Option("Current settings", ""));
    for (const name of Object.keys(state.exportSettings.presets)) presetSelect.append(new Option(name, name));
    presetSelect.value = selected;
  };
  const commit = () => {
    state.exportSettings.current = read();
    storeExportSettings(state.exportSettings);
  };

  refreshPresets();
  fill(state.exportSettings.current);
  modal.hidden = false;

  const close = () => {
    commit();
    modal.hidden = true;
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
  };
  // The panel holds the settings *and* the commands, the way Umoupen's export
  // panel does, so every way of writing a file is in one place.
  const commands = document.getElementById("exportCommands");
  const onCommand = (event) => {
    const button = event.target.closest("[data-export-command]");
    if (!button) return;
    const command = button.dataset.exportCommand;
    commit();
    close();
    handleAction(command);
  };

  const listeners = [
    [commands, "click", onCommand],
    [range, "change", () => { custom.hidden = range.value !== "custom"; commit(); }],
    [from, "change", commit],
    [to, "change", commit],
    [pattern, "change", commit],
    [format, "change", commit],
    [columns, "change", commit],
    [scale, "change", commit],
    [presetSelect, "change", () => {
      const chosen = state.exportSettings.presets[presetSelect.value];
      if (chosen) { fill(chosen); commit(); }
    }],
    [document.getElementById("exportPresetSave"), "click", () => {
      const name = (prompt("Name for this preset:") ?? "").trim().slice(0, 40);
      if (!name || name === "__proto__") return;
      state.exportSettings.presets[name] = read();
      commit();
      refreshPresets(name);
    }],
    [document.getElementById("exportPresetDelete"), "click", () => {
      if (!presetSelect.value) return;
      delete state.exportSettings.presets[presetSelect.value];
      commit();
      refreshPresets();
    }],
    [document.getElementById("exportSettingsClose"), "click", close],
  ];
  for (const [target, type, handler] of listeners) target.addEventListener(type, handler);
}

/* ------------------------------------------------------------- time sheet */

// The header of the last sheet is remembered for the next one, because a
// series is drawn with the same title, episode and author over and over.
const timeSheetMemory = {
  title: "",
  episode: "",
  cut: "",
  author: "",
  date: "",
  notes: "",
  camera: true,
};

function timeSheetStem() {
  return state.currentPath
    ? baseName(state.currentPath).replace(/\.[^.]+$/, "")
    : state.suggestedName?.replace(/\.tvmini$/i, "") || "untitled";
}

function openTimeSheet() {
  const project = state.project;
  const modal = document.getElementById("timeSheetModal");
  const titleInput = document.getElementById("timeSheetTitleInput");
  const episodeInput = document.getElementById("timeSheetEpisode");
  const cutInput = document.getElementById("timeSheetCut");
  const authorInput = document.getElementById("timeSheetAuthor");
  const dateInput = document.getElementById("timeSheetDate");
  const fromInput = document.getElementById("timeSheetFrom");
  const toInput = document.getElementById("timeSheetTo");
  const notesInput = document.getElementById("timeSheetNotes");
  const cameraInput = document.getElementById("timeSheetCamera");
  const list = document.getElementById("timeSheetLayers");
  const summary = document.getElementById("timeSheetSummary");
  const countLabel = document.getElementById("timeSheetLayerCount");
  const create = document.getElementById("timeSheetCreate");
  const stem = timeSheetStem();
  const base = buildTimeSheetLayout(project, { name: stem });
  const layers = project.layers ?? [];

  /* The layer tree: a folder is one row, and every drawing layer under it is
     a row of its own. Choosing a folder chooses all of them. */
  const boxes = new Map();
  const folders = [];
  list.replaceChildren();
  const addRow = (index, depth) => {
    const layer = layers[index];
    if (!layer || layer.type === "guide" || layer.type === "mask") return;
    const row = document.createElement("label");
    row.className = `time-sheet-layer${layer.type === "group" ? " is-folder" : ""}`;
    row.style.paddingLeft = `${6 + depth * 15}px`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.dataset.layerIndex = String(index);
    const name = document.createElement("span");
    name.className = "time-sheet-layer-name";
    name.textContent = layer.name || `Layer ${index + 1}`;
    row.append(input, name);
    list.append(row);
    boxes.set(index, input);
    if (layer.type === "group") {
      folders.push(index);
      for (const child of childrenOf(project, index)) addRow(child, depth + 1);
    }
  };
  for (const index of childrenOf(project, -1)) addRow(index, 0);

  const drawingDescendants = (folderIndex) => {
    const out = [];
    const visit = (parent) => {
      for (const child of childrenOf(project, parent)) {
        const layer = layers[child];
        if (!layer) continue;
        if (layer.type === "group") visit(child);
        else if (layer.type !== "guide" && layer.type !== "mask") out.push(child);
      }
    };
    visit(folderIndex);
    return out;
  };
  const drawingBoxes = () => [...boxes.keys()].filter((index) => layers[index]?.type !== "group");
  const syncFolders = () => {
    for (const index of folders) {
      const children = drawingDescendants(index);
      const box = boxes.get(index);
      const checked = children.filter((child) => boxes.get(child)?.checked).length;
      box.checked = children.length > 0 && checked === children.length;
      box.indeterminate = checked > 0 && checked < children.length;
    }
  };
  const selection = () => [...boxes].filter(([, box]) => box.checked).map(([index]) => index);

  const read = () => ({
    name: stem,
    title: titleInput.value,
    episode: episodeInput.value,
    cut: cutInput.value,
    author: authorInput.value,
    date: dateInput.value,
    notes: notesInput.value,
    from: Math.floor(Number(fromInput.value)),
    to: Math.floor(Number(toInput.value)),
    camera: cameraInput.checked,
    layers: selection(),
  });
  const refreshSummary = () => {
    const layout = buildTimeSheetLayout(project, read());
    const pages = layout.pageCount;
    countLabel.textContent = `${layout.layerCount} of ${drawingBoxes().length} layers`;
    summary.textContent =
      `${layout.frameCount} frames · ${layout.duration} at ${layout.fps} fps · ` +
      `${pages} page${pages === 1 ? "" : "s"}`;
    create.disabled = layout.layerCount === 0;
  };
  const remember = () => {
    timeSheetMemory.title = titleInput.value;
    timeSheetMemory.episode = episodeInput.value;
    timeSheetMemory.cut = cutInput.value;
    timeSheetMemory.author = authorInput.value;
    timeSheetMemory.date = dateInput.value;
    timeSheetMemory.notes = notesInput.value;
    timeSheetMemory.camera = cameraInput.checked;
  };
  const close = () => {
    remember();
    modal.hidden = true;
  };

  titleInput.value = timeSheetMemory.title || stem;
  episodeInput.value = timeSheetMemory.episode;
  cutInput.value = timeSheetMemory.cut;
  authorInput.value = timeSheetMemory.author;
  dateInput.value = timeSheetMemory.date || todayStamp();
  notesInput.value = timeSheetMemory.notes;
  cameraInput.checked = timeSheetMemory.camera;
  fromInput.value = base.startFrame;
  toInput.value = base.endFrame;
  syncFolders();
  refreshSummary();
  modal.hidden = false;

  for (const [index, box] of boxes) {
    const folder = layers[index]?.type === "group";
    box.addEventListener("change", () => {
      if (folder) {
        for (const child of drawingDescendants(index)) {
          const childBox = boxes.get(child);
          if (childBox) childBox.checked = box.checked;
        }
        box.indeterminate = false;
        syncFolders();
      }
      refreshSummary();
    });
  }
  const checkAll = (checked) => {
    for (const box of boxes.values()) {
      box.checked = checked;
      box.indeterminate = false;
    }
    refreshSummary();
  };
  document.getElementById("timeSheetLayersAll").onclick = () => checkAll(true);
  document.getElementById("timeSheetLayersNone").onclick = () => checkAll(false);
  document.getElementById("timeSheetCancel").onclick = close;
  for (const input of [titleInput, episodeInput, cutInput, authorInput, dateInput, fromInput, toInput, notesInput, cameraInput]) {
    input.oninput = refreshSummary;
    input.onchange = refreshSummary;
  }

  create.onclick = async () => {
    const options = read();
    if (!options.layers.length) return;
    close();
    stopPlayback();
    try {
      setStatus("Building the time sheet image…");
      const layout = buildTimeSheetLayout(project, options);
      for (let index = 0; index < layout.pages.length; index += 1) {
        setStatus(`Drawing time sheet page ${index + 1} of ${layout.pages.length}…`);
        const canvas = renderTimeSheetPage(layout, index, { scale: 2 });
        const bytes = await timeSheetPngBytes(canvas);
        const name =
          layout.pages.length === 1
            ? `${stem}-timesheet.png`
            : `${stem}-timesheet-${index + 1}.png`;
        setStatus(`Saving time sheet page ${index + 1} of ${layout.pages.length}…`);
        const saved = await backend.saveBytes(bytes, name, "Save the time sheet image");
        if (!saved) {
          setStatus("The time sheet was cancelled, so no file was written.");
          return;
        }
      }
      const pages = layout.pageCount === 1 ? "1 page" : `${layout.pageCount} pages`;
      setStatus(
        `Exported the time sheet (${pages}, ${layout.frameCount} frames, ` +
          `${layout.layerCount} layer${layout.layerCount === 1 ? "" : "s"}).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[tvmini] the time sheet image failed", error);
      reportToServer(`the time sheet image failed: ${message}`);
      setStatus(message, true);
    }
  };
}

/* ------------------------------------------------------------- file modal */

let picker = null;

/**
 * Write a line down on the server, so the steps of the program can be seen
 * while it runs.
 */
function reportToServer(message) {
  try {
    fetch("api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: String(message) }),
    }).catch(() => {});
  } catch {
    // Reporting is a convenience; a failure to report is not an error.
  }
}

function choosePath({ mode, title, name = "", start = null }) {
  // On the desktop the dialog of the operating system is used: it knows the
  // folders of the machine, it can be resized and it is the one every
  // program of the machine uses.
  if (window.tvminiDesktop?.pickPath) {
    reportToServer(`the native file dialog opened for ${title} with the name "${name}"`);
    return window.tvminiDesktop
      .pickPath({ mode, title, name, start })
      .catch((error) => {
        reportToServer(`the native file dialog failed: ${error?.message ?? error}`);
        return null;
      });
  }
  picker = { mode, resolve: null, dir: null, suggested: name, named: false };
  modalTitle.textContent = title;
  nameInput.value = name;
  confirmButton.textContent = mode === "open" ? "Open" : "Save";
  modal.hidden = false;

  const home = state.currentPath
    ? state.currentPath.replace(/[\\/][^\\/]*$/, "")
    : null;

  loadDir(start || home || dirInput.value || state.homeDir || ".");
  reportToServer(`the file dialog opened for ${title} with the name "${name}"`);

  return new Promise((resolve) => {
    picker.resolve = resolve;
  });
}

function finishPicker(value) {
  modal.hidden = true;
  const resolve = picker?.resolve;
  picker = null;
  if (resolve) resolve(value);
}

async function loadDir(dir) {
  const current = picker;
  try {
    const data = await backend.listDirectory(dir);
    if (!current || picker !== current) return;
    picker.dir = data.dir;
    dirInput.value = data.dir;
    upButton.disabled = !data.parent;

    dirList.replaceChildren();

    for (const entry of data.entries) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";

      const label = document.createElement("span");
      label.textContent = entry.dir ? `📁 ${entry.name}` : `📄 ${entry.name}`;

      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = entry.dir ? "" : `${entry.size} B`;

      button.append(label, meta);
      button.addEventListener("click", () => {
        if (entry.dir) {
          // Going into a folder does not throw the name away: the name the
          // export suggested is still the name the user wants.
          loadDir(entry.path);
          if (!picker?.named) nameInput.value = picker?.suggested ?? "";
          reportToServer(`the folder ${entry.name} was opened; the name is now "${nameInput.value}"`);
        } else {
          nameInput.value = entry.path;
          picker.named = true;
          reportToServer(`the file ${entry.name} was chosen`);
        }
      });

      item.append(button);
      dirList.append(item);
    }

    if (data.entries.length === 0) {
      const item = document.createElement("li");
      item.textContent = "This folder is empty.";
      item.style.padding = "8px";
      item.style.color = "#6b7280";
      dirList.append(item);
    }
  } catch (error) {
    if (current && picker === current) setStatus(error.message, true);
  }
}

upButton.addEventListener("click", () => {
  const parent = dirInput.value.replace(/[\\/][^\\/]*$/, "");
  if (parent && parent !== dirInput.value) loadDir(parent);
});

goButton.addEventListener("click", () => loadDir(dirInput.value));

dirInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadDir(dirInput.value);
});

cancelButton.addEventListener("click", () => finishPicker(null));

modal.addEventListener("click", (event) => {
  if (event.target === modal) finishPicker(null);
});

confirmButton.addEventListener("click", () => {
  const name = nameInput.value.trim();
  // The folder is the one in the field, not the one that was listed last: a
  // folder that is still loading would send the file somewhere else.
  const folder = dirInput.value.trim() || picker?.dir || state.homeDir || ".";
  reportToServer(`save was pressed with the name "${name}" in "${folder}"`);
  if (!name) {
    setStatus("Type a file name for the file, then press Save.", true);
    nameInput.focus();
    return;
  }
  finishPicker(joinPath(folder, name));
});

nameInput.addEventListener("input", () => {
  if (picker) picker.named = true;
});

nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") confirmButton.click();
});

/* ------------------------------------------------- colour wheel (HSV) */

const wheelCanvas = document.getElementById("wheelCanvas");
const wheelHex = document.getElementById("wheelHex");
const wheelTransparent = document.getElementById("wheelTransparent");
const onionInput = document.getElementById("onion");
const speedInput = document.getElementById("speed");
const onionBeforeInput = document.getElementById("onionBefore");
const onionAfterInput = document.getElementById("onionAfter");

/* Matches the reference layout: hue ring around an inscribed SV square.
   The wheel sits in the tool property panel, the way MoArt's colour circle
   does, so it is always there and needs no button to open it.

   The maths of the wheel lives in core/wheel.js, because the ring is drawn
   with the arc of a hue at the angle of that hue and the point that is
   picked has to read the hue at that same angle. When the two disagree the
   marker of the ring lands a quarter turn away from the arc under the
   cursor, and the colour that comes out is not the colour of the arc that
   was clicked. */
const wheelShape = wheelLayout(WHEEL_SIZE);

const wheel = { hue: 222, saturation: 0.8, value: 0.6 };

/* True while the wheel is the one writing the colour, so that the wheel and
   the colour of the strokes do not chase each other. */
let wheelOwnsColour = false;

function renderWheel() {
  const ctx = wheelCanvas.getContext("2d");
  const { centre, ringOuter, ringInner, ringMiddle, side, squareX, squareY } = wheelShape;

  ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);

  // Hue ring: one thin arc per degree. The arc of a hue sits at the angle of
  // that hue, so the marker of the ring lands on the arc it was picked from.
  for (let angle = 0; angle < 360; angle += 1) {
    ctx.beginPath();
    ctx.strokeStyle = `hsl(${angle}, 100%, 50%)`;
    ctx.lineWidth = ringOuter - ringInner;
    ctx.arc(centre, centre, ringMiddle, (angle - 0.9) * (Math.PI / 180), (angle + 0.9) * (Math.PI / 180));
    ctx.stroke();
  }

  // Saturation (x) / value (y) square in the middle.
  ctx.fillStyle = `hsl(${wheel.hue}, 100%, 50%)`;
  ctx.fillRect(squareX, squareY, side, side);
  let gradient = ctx.createLinearGradient(squareX, 0, squareX + side, 0);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(squareX, squareY, side, side);
  gradient = ctx.createLinearGradient(0, squareY, 0, squareY + side);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(squareX, squareY, side, side);

  // Markers: ring dot at the hue, crosshair in the square.
  const ring = huePoint(wheel.hue, wheelShape);
  ctx.beginPath();
  ctx.arc(ring.x, ring.y, 4, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();
  const markerX = squareX + wheel.saturation * side;
  const markerY = squareY + (1 - wheel.value) * side;
  ctx.beginPath();
  ctx.arc(markerX, markerY, 4, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(markerX, markerY, 5.5, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
}

/** Put the colour of the wheel into the strokes and into the hex field. */
function wheelApply() {
  const [red, green, blue] = hsvToRgb(wheel.hue, wheel.saturation, wheel.value);
  const hex = rgbToHex(red, green, blue);
  wheelOwnsColour = true;
  colorInput.value = hex;
  wheelHex.value = hex;
  colorInput.dispatchEvent(new Event("input", { bubbles: true }));
  wheelOwnsColour = false;
  renderWheel();
}

/**
 * Take the colour of the strokes into the wheel, so the marker of the ring
 * and the dot of the square always stand for the colour that is in use.
 */
function wheelSyncFromColor() {
  const match = /^#?([0-9a-f]{6})$/i.exec(colorInput.value.trim());
  if (!match) return;
  const hex = match[1];
  const rgb = [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
  const [hue, saturation, value] = rgbToHsv(...rgb);
  wheel.saturation = saturation;
  wheel.value = value;
  // A grey has no hue of its own, so the ring keeps the hue it had instead
  // of jumping to red every time a grey is picked.
  if (saturation > 0) wheel.hue = hue;
  wheelHex.value = `#${hex}`;
}

function wheelFromEvent(event) {
  const rect = wheelCanvas.getBoundingClientRect();
  const scale = WHEEL_SIZE / rect.width;
  const x = (event.clientX - rect.left) * scale;
  const y = (event.clientY - rect.top) * scale;
  const pick = wheelPick(x, y, wheelShape);
  if (pick.region === "ring") {
    wheel.hue = pick.hue;
  } else if (pick.region === "square") {
    wheel.saturation = pick.saturation;
    wheel.value = pick.value;
  }
  wheelApply();
}

colorInput.addEventListener("input", () => {
  syncQuickBar();
  // The colour of the strokes can also be changed with the colour picker of
  // the browser or with the eyedropper, so the wheel follows it: the marker
  // of the ring and the dot of the square always stand for the colour that
  // is in use. When the wheel is the one that wrote the colour it already
  // knows, and it must not be sent back to itself.
  if (wheelOwnsColour) return;
  wheelSyncFromColor();
  renderWheel();
});

// The wheel is always on screen, so it follows the colour from the start.
wheelSyncFromColor();
wheelApply();

wheelCanvas.addEventListener("pointerdown", (event) => {
  try {
    wheelCanvas.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic events (or stale pointers) have no capturable pointer id.
  }
  wheelFromEvent(event);
});

wheelCanvas.addEventListener("pointermove", (event) => {
  if (event.buttons & 1) wheelFromEvent(event);
});

wheelHex.addEventListener("change", () => {
  const match = /^#?([0-9a-f]{6})$/i.exec(wheelHex.value.trim());
  if (!match) return; // keep the last valid colour
  colorInput.value = `#${match[1]}`;
  wheelSyncFromColor();
  wheelApply();
});

wheelTransparent.addEventListener("click", () => {
  selectTool("eraser");
  setStatus("Transparent: switched to the eraser (E)");
});

onionInput.addEventListener("change", () => {
  setOnion({ enabled: onionInput.checked });
  setStatus(state.onion.enabled ? "Onion skin on" : "Onion skin off");
});
onionBeforeInput.addEventListener("change", () => {
  setOnion({ before: clampOnion(onionBeforeInput.value, state.onion.before) });
});
onionAfterInput.addEventListener("change", () => {
  setOnion({ after: clampOnion(onionAfterInput.value, state.onion.after) });
});
speedInput.addEventListener("change", () => {
  state.playSpeed = Number(speedInput.value) || 1;
  saveSettings();
  setStatus(`Playback speed ${speedInput.options[speedInput.selectedIndex].text}`);
});

/* ------------------------------------------------- flip preview (hold S) */

let flipTimer = null;
let flipFrame = null;

function flipLayer() {
  return state.project.layers[state.project.currentLayer];
}

function flipPaint(frameNumber) {
  const project = state.project;
  const layer = flipLayer();
  const canvas = document.getElementById("flipCanvas");
  canvas.width = project.width;
  canvas.height = project.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, project.width, project.height);
  context.fillStyle = project.background;
  context.fillRect(0, 0, project.width, project.height);
  const resolved = resolveDrawing(layer, frameNumber);
  if (resolved) {
    const base = drawingImageElement(resolved.drawing);
    if (base) context.drawImage(base, ...cellBaseOrigin(resolved.drawing), ...cellBaseSize(project, resolved.drawing));
    drawStrokesInto(context, resolved.drawing.strokes, resolved.drawing.brush);
  }
  const labelCell = document.getElementById("flipLabel");
  labelCell.textContent = resolved
    ? `Frame ${frameNumber} — drawing at ${resolved.drawing.at} (hold ${resolved.drawing.hold})`
    : `Frame ${frameNumber} — empty`;
  return context.canvas;
}

function startFlipPreview() {
  if (flipTimer || state.playing) return;
  const layer = flipLayer();
  if (!layer || layer.drawings.length === 0) {
    setStatus("Nothing exposed on this layer yet — flip preview plays its frames");
    return;
  }
  const overlay = document.getElementById("flipOverlay");
  overlay.hidden = false;
  flipFrame = state.project.currentFrame;
  const project = state.project;
  const step = () => {
    const bounds = layerBounds(layer);
    const end = bounds ? bounds.last : project.startFrame;
    if (flipFrame > end) flipFrame = project.startFrame;
    flipPaint(flipFrame);
    flipFrame += 1;
  };
  step();
  flipTimer = setInterval(step, 160);
}

function stopFlipPreview() {
  if (!flipTimer) return;
  clearInterval(flipTimer);
  flipTimer = null;
  document.getElementById("flipOverlay").hidden = true;
  renderCanvas();
}

document.addEventListener("keyup", (event) => {
  if (event.key?.toLowerCase() === "s") stopFlipPreview();
});

/* ------------------------------------------------- keyboard */

const KEYS = [
  {
    group: "Tools",
    rows: [
      ["Brush", "B"],
      ["Pick a colour from the canvas", "I"],
      ["Eraser", "E"],
      ["Line", "L"],
      ["Rectangle", "R"],
      ["Ellipse", "V"],
      ["Fill", "F"],
      ["Add a camera key on this frame", "Shift+C"],
      ["Camera tool", "C"],
      ["Smaller / larger brush", "[ / ]"],
      ["Clear the current drawing", "Backspace"],
    ],
  },
  {
    group: "Timeline",
    rows: [
      ["Play / pause", "Space"],
      ["Flip preview of the current layer (hold)", "S"],
      ["Toggle onion skin", "O"],
      ["Previous / next frame", "← / →"],
      ["Select layer above / below", "↑ / ↓"],
      ["Extend the exposure one frame", "5"],
      ["Shorten the exposure one frame", "Shift+5"],
      ["Insert a blank drawing", "6"],
      ["Duplicate the drawing", "Ctrl+D"],
      ["Delete the drawing", "Delete"],
    ],
  },
  {
    group: "Project",
    rows: [
      ["New", "Ctrl+N"],
      ["Next document", "Ctrl+Tab"],
      ["Open", "Ctrl+O"],
      ["Save", "Ctrl+S"],
      ["Save As", "Ctrl+Shift+S"],
      ["Export current frame PNG", "Ctrl+E"],
      ["Export layered .clip", "Ctrl+Shift+E"],
      ["Undo", "Ctrl+Z"],
      ["Redo", "Ctrl+Y / Ctrl+Shift+Z / Ctrl+A"],
      ["Keyboard shortcuts", "F1"],
      ["Close dialogs", "Esc"],
    ],
  },
];

function buildKeysBody() {
  keysBody.replaceChildren();
  for (const group of KEYS) {
    const card = element("div", "keys-group");
    card.append(element("h3", null, group.group));
    for (const [label, keys] of group.rows) {
      const row = element("div", "keys-row");
      row.append(element("span", null, label), element("span", "keys-key", keys));
      card.append(row);
    }
    keysBody.append(card);
  }
}

function showGuide() {
  guideDialog.hidden = false;
}

function showKeys() {
  buildKeysBody();
  keysDialog.hidden = false;
}

function showStart() {
  if (state.showStart === false) return;
  syncSettingsUI();
  renderStartRecent();
  startOverlay.hidden = false;
}

function closeAllOverlays() {
  startOverlay.hidden = true;
  keysDialog.hidden = true;
  guideDialog.hidden = true;
  brushDialog.hidden = true;
}

function anyOverlayOpen() {
  return !startOverlay.hidden || !keysDialog.hidden || !guideDialog.hidden || !brushDialog.hidden;
}

startDrawButton.addEventListener("click", () => {
  startOverlay.hidden = true;
  setStatus("Draw on the canvas — F1 lists every shortcut");
});

startOpenButton.addEventListener("click", async () => {
  startOverlay.hidden = true;
  await chooseAndOpen();
});

startImportButton.addEventListener("click", async () => {
  startOverlay.hidden = true;
  await chooseAndImportClip();
});

startImportFlaButton.addEventListener("click", async () => {
  startOverlay.hidden = true;
  await chooseAndImportFLA();
});

startGuideButton.addEventListener("click", showGuide);
startKeysButton.addEventListener("click", showKeys);

guideDialog.addEventListener("click", (event) => {
  if (event.target === guideDialog) guideDialog.hidden = true;
});

keysDialog.addEventListener("click", (event) => {
  if (event.target === keysDialog) keysDialog.hidden = true;
});

startOverlay.addEventListener("click", (event) => {
  if (event.target === startOverlay) startOverlay.hidden = true;
});

for (const button of document.querySelectorAll(".overlay [data-close]")) {
  button.addEventListener("click", (event) => {
    event.target.closest(".overlay").hidden = true;
  });
}

function renderStartRecent() {
  startRecent.replaceChildren();

  if (state.recent.length === 0) {
    startRecent.append(element("li", "empty", "Nothing yet — save a project to see it here"));
    return;
  }

  for (const entry of state.recent) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";

    const name = document.createElement("span");
    name.className = "start-name";
    name.textContent = entry.name;

    const filePath = document.createElement("span");
    filePath.className = "start-path";
    filePath.textContent = entry.path || "in this browser";

    button.append(name, filePath);
    button.addEventListener("click", () => {
      closeAllOverlays();
      openPath(entry.path ?? entry.name);
    });
    item.append(button);
    startRecent.append(item);
  }
}

document.addEventListener("keydown", (event) => {
  // Escape lets go of a selection drag before it clears a selection, so a
  // drag that went wrong can be given up without losing the selection.
  if (event.key === "Escape") {
    if (state.selectionDrag) {
      state.selectionDrag = null;
      drawOverlay();
      event.preventDefault();
      return;
    }
    if (!modal.hidden) {
      finishPicker(null);
      return;
    }
    if (anyOverlayOpen()) {
      closeAllOverlays();
      event.preventDefault();
      return;
    }
    if (!fileMenu.hidden || !helpMenu.hidden || !recentMenu.hidden) {
      closeMenus();
      return;
    }
    if (state.selection) {
      clearSelection();
      event.preventDefault();
      return;
    }
  }

  if (!modal.hidden || anyOverlayOpen()) return;

  // F1 and "?" open the shortcut list even while a control has focus, so a
  // user stuck in an input can still find the way out.
  if (event.key === "F1" || (!event.ctrlKey && !event.metaKey && event.key === "?")) {
    event.preventDefault();
    showKeys();
    return;
  }

  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLButtonElement;

  // Ctrl+A takes the whole canvas and Ctrl+D lets it go, the way they do in
  // Flash. Both are kept from the browser, which would select the page.
  if (modifier && !typing && !state.drawing) {
    if (key === "a") {
      event.preventDefault();
      selectWholeCanvas();
      return;
    }
    if (key === "d") {
      event.preventDefault();
      clearSelection();
      return;
    }
  }

  // Never hijack keys while a stroke is being drawn.
  if (!typing && !modifier && !event.altKey && !state.drawing) {
    if (event.key === " ") {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepFrame(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepFrame(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectLayer(Math.max(0, state.project.currentLayer - 1));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectLayer(Math.min(state.project.layers.length - 1, state.project.currentLayer + 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      gotoFirstFrame();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      gotoLastFrame();
      return;
    }
    if (event.key === "PageUp") {
      event.preventDefault();
      gotoPreviousKey();
      return;
    }
    if (event.key === "PageDown") {
      event.preventDefault();
      gotoNextKey();
      return;
    }
    if (key === "o") {
      event.preventDefault();
      setOnion({ enabled: !state.onion.enabled });
      setStatus(state.onion.enabled ? "Onion skin on" : "Onion skin off");
      return;
    }
    if (key === "b") {
      event.preventDefault();
      selectTool("brush");
      return;
    }
    if (key === "p") {
      event.preventDefault();
      selectTool("pencil");
      return;
    }
    if (key === "e") {
      event.preventDefault();
      selectTool("eraser");
      return;
    }
    if (key === "l") {
      event.preventDefault();
      selectTool("line");
      return;
    }
    if (key === "r") {
      event.preventDefault();
      selectTool("rect");
      return;
    }
    if (key === "v") {
      event.preventDefault();
      selectTool("ellipse");
      return;
    }
    if (key === "f") {
      event.preventDefault();
      selectTool("fill");
      return;
    }
    if (key === "c" && event.shiftKey) {
      event.preventDefault();
      toggleCameraKey();
      return;
    }
    if (key === "c") {
      event.preventDefault();
      selectTool("camera");
      return;
    }
    if (key === "i") {
      event.preventDefault();
      selectTool(state.tool === "pick" ? "brush" : "pick");
      return;
    }
    if (key === "m") {
      event.preventDefault();
      selectTool("marquee");
      return;
    }
    if (key === "a") {
      event.preventDefault();
      selectTool("lasso");
      return;
    }
    // Hold S for a flipbook preview of the current layer (paper-toggle style).
    if (key === "s") {
      event.preventDefault();
      startFlipPreview();
      return;
    }
    if (event.key === "[") {
      event.preventDefault();
      changeWidth(-1);
      return;
    }
    if (event.key === "]") {
      event.preventDefault();
      changeWidth(1);
      return;
    }
    // Numeric-row 5 extends the exposure (Flash's F5 slot); Shift+5 shortens.
    // Shifted layouts report "%" for Shift+5, so it is mapped on its own.
    if (key === "%" || (key === "5" && event.shiftKey)) {
      event.preventDefault();
      shrinkExposure();
      return;
    }
    if (key === "5") {
      event.preventDefault();
      holdFrame();
      return;
    }
    if (key === "6") {
      event.preventDefault();
      addDrawing();
      return;
    }
    if (key === "backspace") {
      event.preventDefault();
      clearDrawing();
      return;
    }
    if (key === "delete") {
      event.preventDefault();
      deleteFrame();
      return;
    }
  }

  if (!modifier) return;

  if (!typing && key === "z" && event.shiftKey) {
    event.preventDefault();
    redo();
  } else if (!typing && key === "z") {
    event.preventDefault();
    undo();
  } else if (!typing && (key === "a" || key === "y")) {
    event.preventDefault();
    redo();
  } else if (key === "d") {
    event.preventDefault();
    duplicateFrame();
  } else if (key === "e" && event.shiftKey) {
    event.preventDefault();
    exportClip();
  } else if (key === "e") {
    event.preventDefault();
    exportPng();
  } else if (key === "s" && event.shiftKey) {
    event.preventDefault();
    saveAs();
  } else if (key === "s") {
    event.preventDefault();
    save();
  } else if (key === "o") {
    event.preventDefault();
    chooseAndOpen();
  } else if (key === "n") {
    event.preventDefault();
    newProject();
  } else if (event.key === "Tab" || event.key === "PageDown") {
    // Ctrl+Tab walks through the open documents.
    event.preventDefault();
    const count = state.documents.length;
    if (count > 1) {
      const step = event.shiftKey ? count - 1 : 1;
      activateDocument((state.activeIndex + step) % count);
    }
  }
});

/* ------------------------------------------------------------------ boot */

async function boot() {
  backend = await detectBackend({
    pickPath: choosePath,
    importProgress: importProgressFromBackend,
  });

  if (backend.mode !== "server") {
    // Without a server there is no directory to browse, so the built-in
    // file dialog is hidden and the browser's own picker is used.
    document.body.classList.add("browser-mode");
  }

  // The first document is an empty one; the tab strip grows from here.
  state.documents = [
    {
      project: state.project,
      currentPath: null,
      suggestedName: null,
      clipSourcePath: null,
      tvppSourcePath: null,
      dirty: false,
      history,
    },
  ];
  state.activeIndex = 0;

  loadSettings();
  syncSettingsUI();
  // The panel shows the section of the tool that is in the hand.
  showToolProps();
  applyCompactView();
  syncQuickBar();
  wireNewProjectDialog();

  try {
    state.recent = await backend.listRecent();
    renderRecent();
  } catch (error) {
    setStatus(error.message, true);
  }

  resizeCanvas();
  refreshTitle();
  updateHistoryButtons();
  renderDocumentTabs();
  setStatus(
    backend.mode === "server"
      ? "Ready — draw on the canvas, then use the timeline to add layers and drawings"
      : "Ready — running in the browser. Files are saved to this device.",
  );
  showStart();

  // The menu of the window (the desktop only) asks the page for the very
  // actions the shortcuts of the page carry out.
  window.tvminiDesktop?.onMenu?.((action) => {
    if (action === "new-project") newProject();
    else if (action === "open") chooseAndOpen();
    else if (action === "save") save();
    else if (action === "export-png") exportPng();
    else if (action === "export-clip") exportClip();
    else if (action === "export-time-sheet") openTimeSheet();
  });

  // A file dragged from the machine onto the window is opened or imported.
  wireDropTarget();
}

boot();
