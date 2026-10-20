import { History } from "./history.js";
import { onionTargets } from "./onion.js";
import { detectBackend } from "./core/platform.js";
import { decodeSound, soundPeaks } from "./audio.js";
import { floodFillRgba, parseHexColor, smoothPoint } from "./core/paint.js";
import { brushImageFromBytes } from "./core/brush.js";
import { readSutBrush } from "./core/sut.js";
import {
  cameraAt,
  cameraCorners,
  cameraKeyAt,
  cameraView,
  contentEnd,
  deleteCameraKey,
  deleteDrawing,
  drawingAt,
  duplicateDrawing,
  exposureInfo,
  holdDrawing,
  insertDrawing,
  layerBounds,
  resolveDrawing,
  setCameraKey,
  setExposure,
  shiftStartFrame,
  timelineColumns,
} from "./timeline.js";

const FORMAT = "tvmini";
const VERSION = 2;
const MAX_COLUMNS = 1000;
// Keep these in sync with src/model.js.
const MAX_LAYERS = 100;
const MAX_DRAWINGS_PER_LAYER = 1000;
const MAX_TOTAL_DRAWINGS = 5000;
const MAX_HOLD = 10000;
const MAX_START_FRAME = 100000;
const MAX_FRAME = 10_000_000;
/** Colour behind the camera window when the stage shows the camera view. */
const CAMERA_BACKDROP = "#12161c";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
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
const eraserButton = document.getElementById("eraserButton");
const pickButton = document.getElementById("pickButton");
const lineToolButton = document.getElementById("lineTool");
const rectToolButton = document.getElementById("rectTool");
const ellipseToolButton = document.getElementById("ellipseTool");
const fillToolButton = document.getElementById("fillTool");
const cameraToolButton = document.getElementById("cameraTool");
const stabilizerInput = document.getElementById("stabilizer");
const stabilizerValue = document.getElementById("stabilizerValue");
const strokeOpacityInput = document.getElementById("strokeOpacity");
const strokeBlendSelect = document.getElementById("strokeBlend");
const cameraAddButton = document.getElementById("cameraAdd");
const cameraRemoveButton = document.getElementById("cameraRemove");
const cameraFitButton = document.getElementById("cameraFit");
const cameraZoomButton = document.getElementById("cameraZoom");
const cameraZoomInButton = document.getElementById("cameraZoomIn");
const cameraZoomOutButton = document.getElementById("cameraZoomOut");
const zoomLabel = document.getElementById("zoomLabel");
const cameraXInput = document.getElementById("cameraX");
const cameraYInput = document.getElementById("cameraY");
const cameraWidthInput = document.getElementById("cameraWidth");
const cameraHeightInput = document.getElementById("cameraHeight");
const cameraRotationInput = document.getElementById("cameraRotation");
const cameraInterpSelect = document.getElementById("cameraInterp");
const cameraHint = document.getElementById("cameraHint");
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
const opacityValue = document.getElementById("opacityValue");
const preBehaviorInput = document.getElementById("preBehavior");
const postBehaviorInput = document.getElementById("postBehavior");

const playButton = document.getElementById("playButton");
const loopInput = document.getElementById("loop");
const fpsInput = document.getElementById("fps");
const startFrameInput = document.getElementById("startFrame");
const frameLabel = document.getElementById("frameLabel");
const addLayerButton = document.getElementById("addLayerButton");
const deleteLayerButton = document.getElementById("deleteLayerButton");
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
  stabilizer: 0,
  smoothedPoint: null,
  homeDir: ".",
  playing: false,
  playTimer: null,
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
    drawings: [],
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
  });
}

function restore(snapshotValue) {
  const clean = structuredClone(snapshotValue);
  Object.assign(state.project, {
    layers: clean.layers,
    currentLayer: clean.currentLayer,
    currentFrame: clean.currentFrame,
    fps: clean.fps,
    startFrame: clean.startFrame,
    loop: clean.loop,
    camera: clean.camera ?? null,
    audio: clean.audio ?? null,
  });
  clampSelection();
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
  syncQuickBar();
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
  const separator = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${name}`;
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
  const name = state.currentPath ? baseName(state.currentPath) : "Untitled";
  document.title = `${name}${state.dirty ? " *" : ""} — TVMini`;
  pathLabel.textContent = state.currentPath || "not saved yet";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
}

function resizeCanvas() {
  canvas.width = state.project.width;
  canvas.height = state.project.height;
  renderCanvas();
  renderTimeline();
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
    previewImage.onload = () => renderCanvas();
    previewImage.src = `data:image/png;base64,${data}`;
  }

  return previewImage?.complete ? previewImage : null;
}

const paintCanvas = document.createElement("canvas");
const paintCtx = paintCanvas.getContext("2d", { willReadFrequently: true });
// Scratch canvas for transparent/blending strokes: the stroke is painted
// opaque here first, then applied to the paint canvas in a single pass.
const blendCanvas = document.createElement("canvas");
const blendCtx = blendCanvas.getContext("2d");

/* Raster bases (imported .tvpp frames) as <img> elements, cached by data. */
const drawingImages = new Map();

function drawingImageElement(drawing) {
  if (!drawing?.image?.data) return null;
  let element = drawingImages.get(drawing.image.data);
  if (!element) {
    element = new Image();
    element.onload = () => renderCanvas();
    element.src = `data:image/png;base64,${drawing.image.data}`;
    drawingImages.set(drawing.image.data, element);
  }
  return element.complete ? element : null;
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

function drawStrokesInto(ctx, strokes) {
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
      // pass — a multi-part stroke must not darken its own overlaps.
      if (blendCanvas.width !== canvasWidth || blendCanvas.height !== canvasHeight) {
        blendCanvas.width = canvasWidth;
        blendCanvas.height = canvasHeight;
      }
      blendCtx.clearRect(0, 0, canvasWidth, canvasHeight);
      drawStrokeDirect(blendCtx, stroke, canvasWidth, canvasHeight);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation =
        stroke.eraser === true ? "destination-out" : blend === "normal" ? "source-over" : blend;
      ctx.drawImage(blendCanvas, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      continue;
    }

    drawStrokeDirect(ctx, stroke, canvasWidth, canvasHeight);
  }

  ctx.globalCompositeOperation = "source-over";
}

/** Bucket fill: flood the paint canvas from the seed with the stroke colour. */
function floodFillCanvas(ctx, canvasWidth, canvasHeight, stroke) {
  const rgb = parseHexColor(stroke.color);
  if (!rgb) return;
  const image = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  floodFillRgba(
    image.data,
    canvasWidth,
    canvasHeight,
    stroke.points[0][0],
    stroke.points[0][1],
    rgb,
  );
  ctx.putImageData(image, 0, 0);
}

/** Paint one stroke (shape or freehand) directly into a 2D context. */
function drawStrokeDirect(ctx, stroke, canvasWidth, canvasHeight) {
  ctx.globalCompositeOperation = stroke.eraser === true ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  const radii = stroke.points.map((point) => strokeRadius(stroke, point));

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

  // Pressure strokes are drawn segment by segment with an interpolated width.
  for (let i = 1; i < stroke.points.length; i += 1) {
    const from = stroke.points[i - 1];
    const to = stroke.points[i];
    ctx.lineWidth = Math.max(1, radii[i - 1] + radii[i]);
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawStrokesToPaint(strokes) {
  drawStrokesInto(paintCtx, strokes);
}

/** Paint one drawing (raster base + strokes) into paintCanvas and return it. */
function drawDrawingToPaint(project, drawing, alpha = 1) {
  paintCtx.clearRect(0, 0, project.width, project.height);
  paintCtx.globalAlpha = alpha;
  const base = drawingImageElement(drawing);
  if (base) paintCtx.drawImage(base, 0, 0, project.width, project.height);
  drawStrokesInto(paintCtx, drawing.strokes);
  paintCtx.globalAlpha = 1;
  return paintCanvas;
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

function renderCanvas(frame = state.project.currentFrame) {
  const project = state.project;
  const { width, height } = project;
  const camera = cameraAt(project.camera, frame);
  // The stage shows the shot the camera takes; switching the camera view off
  // shows the whole canvas with the camera frame drawn on it instead.
  const view = state.cameraView && state.tool !== "camera"
    ? cameraView(project.camera, frame, width, height)
    : null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;

  if (view) {
    // The area outside the camera window is the letterbox.
    ctx.fillStyle = CAMERA_BACKDROP;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.setTransform(
      view.scale,
      0,
      0,
      view.scale,
      view.offsetX - view.camera.x * view.scale,
      view.offsetY - view.camera.y * view.scale,
    );
    // Only the camera window shows the canvas.
    ctx.beginPath();
    ctx.rect(view.camera.x, view.camera.y, view.camera.width, view.camera.height);
    ctx.clip();
  }

  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, width, height);

  const image = projectImage();
  if (image) ctx.drawImage(image, 0, 0, width, height);

  if (paintCanvas.width !== width || paintCanvas.height !== height) {
    paintCanvas.width = width;
    paintCanvas.height = height;
  }

  // Layers are stored top-to-bottom, so paint them in reverse order.
  for (let index = project.layers.length - 1; index >= 0; index -= 1) {
    const layer = project.layers[index];
    if (!layer.visible || layer.opacity <= 0) continue;

    // Onion skins sit just under the current layer's own drawing and are
    // hidden during playback so they never flicker.
    if (state.onion.enabled && !state.playing && index === project.currentLayer) {
      drawOnionSkins(project, layer, frame);
    }

    const resolved = resolveDrawing(layer, frame);
    if (!resolved) continue;

    drawDrawingToPaint(project, resolved.drawing);

    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(paintCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }

  drawBrushTip();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
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

function timelineColumnCount() {
  return Math.max(12, Math.min(MAX_COLUMNS, timelineColumns(state.project, 12)));
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

/** How many canvas units one screen pixel is worth. */
function cameraTolerance() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return 10;
  return (10 * state.project.width) / rect.width;
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

cameraZoomInButton.addEventListener("click", () => {
  const box = canvas.getBoundingClientRect();
  zoomStage(1 + ZOOM_STEP, box.left + box.width / 2, box.top + box.height / 2);
  setStatus("Zoomed in");
});

cameraZoomOutButton.addEventListener("click", () => {
  const box = canvas.getBoundingClientRect();
  zoomStage(1 / (1 + ZOOM_STEP), box.left + box.width / 2, box.top + box.height / 2);
  setStatus("Zoomed out");
});

/* ------------------------------------------------------- the brush image */

const brushImageButton = document.getElementById("brushImageButton");
const brushImageInput = document.getElementById("brushImageInput");
const brushImageName = document.getElementById("brushImageName");

brushImageButton.addEventListener("click", () => brushImageInput.click());

/**
 * Use a picture as the shape of the brush.
 *
 * A PNG works, and so does a Clip Studio Paint brush, because the picture is
 * looked for inside the file. The picture becomes the tip of the brush of
 * the drawing that is being drawn on.
 */
brushImageInput.addEventListener("change", async () => {
  const file = brushImageInput.files?.[0];
  brushImageInput.value = "";
  if (!file) return;

  const bytes = new Uint8Array(await file.arrayBuffer());
  let picture = null;
  let name = file.name;

  // A Clip Studio Paint brush is a database with the picture of the tip in
  // it, so it is read as one; anything else is taken as a picture.
  if (/\.sut$/i.test(file.name)) {
    const brush = await readSutBrush(bytes);
    if (!brush) {
      setStatus("That brush holds no picture the brush can use", true);
      return;
    }
    picture = brush.texture;
    name = brush.name || file.name;
  } else {
    picture = brushImageFromBytes(bytes);
    if (!picture) {
      setStatus("That file holds no picture the brush can use", true);
      return;
    }
  }

  const layer = currentLayer();
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }
  const drawing = ensureDrawing(layer, state.project.currentFrame);
  const before = snapshot();
  drawing.brush = { data: picture.data };
  recordHistory(before);
  markDirty();
  afterChange();
  brushImageName.textContent = name;
  setStatus(`The brush is now ${name}`);
});

/* ------------------------------------------------------- the brush library */

const brushLibrarySelect = document.getElementById("brushLibrary");
const brushSaveButton = document.getElementById("brushSave");
const brushRemoveButton = document.getElementById("brushRemove");

/** Where the saved brushes are kept. */
const BRUSH_STORE = "tvmini.brushes";

/** The saved brushes. */
function readBrushLibrary() {
  try {
    const raw = localStorage.getItem(BRUSH_STORE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((b) => b && typeof b.data === "string") : [];
  } catch {
    return [];
  }
}

function writeBrushLibrary(list) {
  try {
    localStorage.setItem(BRUSH_STORE, JSON.stringify(list));
  } catch {
    setStatus("The brushes could not be saved", true);
  }
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
  brushRemoveButton.disabled = list.length === 0;
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

/** Put a brush on the drawing that is being drawn on. */
function useBrush(brush, name) {
  const layer = currentLayer();
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return false;
  }
  const drawing = ensureDrawing(layer, state.project.currentFrame);
  const before = snapshot();
  if (brush) drawing.brush = { data: brush.data };
  else delete drawing.brush;
  recordHistory(before);
  markDirty();
  afterChange();
  brushImageName.textContent = name;
  return true;
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
  const list = readBrushLibrary().filter((item) => item.name !== name);
  list.push({ name, data: brush.data });
  writeBrushLibrary(list);
  refreshBrushLibrary();
  brushLibrarySelect.value = name;
  setStatus(`Saved the brush ${name}`);
});

brushRemoveButton.addEventListener("click", () => {
  const name = brushLibrarySelect.value;
  if (!name) return;
  writeBrushLibrary(readBrushLibrary().filter((item) => item.name !== name));
  refreshBrushLibrary();
  setStatus(`Removed the brush ${name}`);
});

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
 */
function drawBrushTip() {
  if (!tipPoint || state.playing) return;
  if (state.tool !== "brush" && state.tool !== "eraser") return;

  const radius = Math.max(0.5, (Number(widthInput.value) || 1) / 2);
  const brush = currentBrush();

  ctx.save();
  if (brush) {
    const image = tipImage(brush);
    if (image.complete && image.naturalWidth > 0) {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(image, tipPoint.x - radius, tipPoint.y - radius, radius * 2, radius * 2);
    }
  } else {
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#101418";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(tipPoint.x, tipPoint.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

canvas.addEventListener("pointermove", (event) => {
  const [x, y] = canvasPoint(event);
  tipPoint = { x, y };
  renderCanvas();
});

canvas.addEventListener("pointerleave", () => {
  if (!tipPoint) return;
  tipPoint = null;
  renderCanvas();
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
let viewPanX = 0;
let viewPanY = 0;

/** Put the zoom and the pan on the canvas element. */
function applyView() {
  canvas.style.transformOrigin = "0 0";
  canvas.style.transform = `translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`;
  showZoom();
}

/** Zoom the stage by a factor, keeping the point under the pointer in place. */
function zoomStage(factor, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const local = (clientX - rect.left) / viewZoom;
  const next = Math.max(0.1, Math.min(16, viewZoom * factor));
  if (next === viewZoom) return;
  // The element has to move so that the same point is under the pointer.
  viewPanX += clientX - local * next - rect.left;
  viewZoom = next;
  applyView();
}

/** Drag the stage with the middle mouse button. */
function panStage(event) {
  const startX = event.clientX;
  const startY = event.clientY;
  const panX = viewPanX;
  const panY = viewPanY;

  const move = (moveEvent) => {
    viewPanX = panX + (moveEvent.clientX - startX);
    viewPanY = panY + (moveEvent.clientY - startY);
    applyView();
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
  viewZoom = 1;
  viewPanX = 0;
  viewPanY = 0;
  applyView();
  setStatus("The stage is back to full size");
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

  const name = element("button", "tl-name", "🎥 Camera");
  name.title = "The camera frames the shot; the stage shows what it sees";
  name.addEventListener("click", () => {
    if (currentCameraKey()) {
      setStatus(`Camera key on frame ${project.currentFrame}`);
    } else {
      addCameraKey();
    }
  });
  head.append(name);

  const add = element("button", "tl-icon", "◆");
  add.title = "Add or remove the camera key on the current frame";
  add.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCameraKey();
  });

  const remove = element("button", "tl-icon", "✕");
  remove.title = "Remove the camera key on the current frame";
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    removeCameraKey();
  });

  const view = element("button", "tl-icon", state.cameraView ? "🎥" : "▣");
  view.title = "Show the camera's shot in the stage";
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
    cell.textContent = key ? "◆" : "";
    cell.title = key
      ? `Camera key — ${Math.round(key.width)}×${Math.round(key.height)} at ${Math.round(key.x)}, ${Math.round(key.y)}`
      : `Frame ${frame}`;
    cell.addEventListener("click", () => selectFrame(frame));
    cells.append(cell);
  }

  row.append(head, cells);
  return row;
}

function renderTimeline() {
  const project = state.project;
  const columns = timelineColumnCount();
  const start = project.startFrame;

  timelineEl.replaceChildren();

  const header = element("div", "tl-header");
  header.append(element("div", "tl-corner", "Layers"));
  const numbers = element("div", "tl-numbers");
  numbers.style.setProperty("--frames", String(columns));
  for (let i = 0; i < columns; i += 1) {
    const frame = start + i;
    const showNumber = columns <= 40 || i === 0 || i === columns - 1 || i % 5 === 0;
    const cell = element("div", "tl-number", showNumber ? String(frame) : "");
    cell.title = `Frame ${frame}`;
    numbers.append(cell);
  }
  header.append(numbers);
  timelineEl.append(header);

  timelineEl.append(renderCameraRow(columns, start));

  project.layers.forEach((layer, index) => {
    const row = element("div", "tl-row");
    row.dataset.layer = String(index);
    if (index === project.currentLayer) row.classList.add("selected");

    const head = element("div", "tl-head");

    const visibility = element("button", "tl-icon", layer.visible ? "👁" : "🚫");
    visibility.title = layer.visible ? "Hide layer" : "Show layer";
    visibility.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleVisibility(index);
    });

    const name = element("button", "tl-name", layer.name);
    name.title = "Select this layer (double-click to rename)";
    name.addEventListener("click", () => selectLayer(index));
    name.addEventListener("dblclick", (event) => {
      event.preventDefault();
      renameLayer(index);
    });

    const lock = element("button", "tl-icon", layer.locked ? "🔒" : "🔓");
    lock.title = layer.locked ? "Unlock layer" : "Lock layer";
    lock.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleLock(index);
    });

    head.append(visibility, name, lock);
    head.addEventListener("click", (event) => {
      if (event.target === head) selectLayer(index);
    });
    // The row can be dragged to another place in the list.
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target === visibility || event.target === lock) return;
      startLayerDrag(event, index);
    });

    const cells = element("div", "tl-cells");
    cells.style.setProperty("--frames", String(columns));

    for (let i = 0; i < columns; i += 1) {
      const frame = start + i;
      const info = exposureInfo(layer, frame);
      const cell = element("button", `tl-cell ${info.kind}`);
      cell.dataset.frame = String(frame);
      cell.type = "button";
      if (frame === project.currentFrame) cell.classList.add("current");
      if (i === 0) cell.classList.add("first");

      if (info.kind === "head") {
        cell.textContent = "●";
        cell.title = `Drawing starts here — ${info.count} frame${info.count === 1 ? "" : "s"}`;
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
      cells.append(cell);
    }

    row.append(head, cells);
    timelineEl.append(row);
  });

  if (project.image) {
    const row = element("div", "tl-row");
    const head = element("div", "tl-head");
    head.append(element("div", "tl-image-head", "📷 Imported image"));
    const cells = element("div", "tl-cells");
    cells.style.setProperty("--frames", String(columns));
    for (let i = 0; i < columns; i += 1) {
      const cell = element("button", "tl-cell image");
      cell.disabled = true;
      cell.title = "Read-only .clip preview (behind every layer)";
      cells.append(cell);
    }
    row.append(head, cells);
    timelineEl.append(row);
  }

  const audioRow = renderAudioRow(columns, start);
  if (audioRow) timelineEl.append(audioRow);

  updatePlayhead();
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
  for (const row of timelineEl.querySelectorAll(".tl-row[data-layer]")) {
    row.classList.toggle("selected", Number(row.dataset.layer) === project.currentLayer);
  }
  for (const cell of timelineEl.querySelectorAll(".tl-cell[data-frame]")) {
    cell.classList.toggle("current", Number(cell.dataset.frame) === project.currentFrame);
  }
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
  loopInput.checked = project.loop;

  const info = exposureInfo(layer, project.currentFrame);
  const editable = info.kind === "head" || info.kind === "hold";
  exposureInput.value = String(info.count || 1);
  exposureInput.disabled = !editable;
  clearButton.disabled = !editable;
  duplicateFrameButton.disabled = !editable;
  holdButton.disabled = !editable;
  deleteFrameButton.disabled = !editable;

  deleteLayerButton.disabled = project.layers.length <= 1;
  layerUpButton.disabled = project.currentLayer <= 0;
  layerDownButton.disabled = project.currentLayer >= project.layers.length - 1;

  syncCameraControls();
}

function selectLayer(index) {
  stopPlayback();
  state.project.currentLayer = index;
  updatePlayhead();
  syncLayerControls();
  setStatus(`Layer ${index + 1}: ${currentLayer().name}`);
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

function afterChange({ timeline = true } = {}) {
  clampSelection();
  refreshTitle();
  syncLayerControls();
  if (timeline) renderTimeline();
  else updatePlayhead();
  updateFrameLabel();
  renderCanvas();
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

function addLayer() {
  const project = state.project;
  if (project.layers.length >= MAX_LAYERS) {
    setStatus(`At most ${MAX_LAYERS} layers are allowed`, true);
    return;
  }

  stopPlayback();
  const before = snapshot();
  project.layers.unshift(createLayer(`Layer ${project.layers.length + 1}`));
  project.currentLayer = 0;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Added ${currentLayer().name}`);
}

function deleteLayer() {
  const project = state.project;
  if (project.layers.length <= 1) {
    setStatus("At least one layer is required", true);
    return;
  }
  const layer = currentLayer();
  if (!confirm(`Delete layer "${layer.name}" and all of its drawings?`)) return;

  stopPlayback();
  const before = snapshot();
  project.layers.splice(project.currentLayer, 1);
  project.currentLayer = Math.min(project.currentLayer, project.layers.length - 1);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Deleted ${layer.name}`);
}

function moveLayer(delta) {
  const project = state.project;
  const from = project.currentLayer;
  const to = from + delta;
  if (to < 0 || to >= project.layers.length) return;

  stopPlayback();
  const before = snapshot();
  const [layer] = project.layers.splice(from, 1);
  project.layers.splice(to, 0, layer);
  project.currentLayer = to;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Moved ${layer.name} ${delta < 0 ? "up" : "down"}`);
}

/* --------------------------------------------------- dragging layers to reorder */

/** The layer drag that is going on, if any. */
let layerDrag = null;

/**
 * Move a layer to a new place in the list.
 *
 * The list is drawn top first, so a smaller index is a higher layer.
 */
function reorderLayer(from, to) {
  const project = state.project;
  if (from === to || to < 0 || to >= project.layers.length) return;

  stopPlayback();
  const before = snapshot();
  const [layer] = project.layers.splice(from, 1);
  project.layers.splice(to, 0, layer);
  project.currentLayer = to;
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Moved ${layer.name} to position ${to + 1} of ${project.layers.length}`);
}

/**
 * Start a drag of a layer row.
 *
 * The list is not rearranged while the pointer is down, because the rows are
 * drawn again after every change and a row that is drawn again cannot keep
 * the pointer. The row under the pointer is marked instead, and the move
 * happens when the button is let go.
 */
function startLayerDrag(event, index) {
  const rows = [...timelineEl.querySelectorAll(".tl-row[data-layer]")];
  if (rows.length < 2) return;

  layerDrag = { index, rows, target: index };
  event.preventDefault();
  window.addEventListener("pointermove", onLayerDragMove);
  window.addEventListener("pointerup", onLayerDragEnd, { once: true });
  window.addEventListener("pointercancel", onLayerDragEnd, { once: true });
}

/** Work out which row the pointer is over and mark it. */
function onLayerDragMove(event) {
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
  if (!layerDrag) return;
  const { index, target, rows } = layerDrag;
  layerDrag = null;
  for (const row of rows) row.classList.remove("drop-target");
  reorderLayer(index, target);
}

function addDrawing() {
  const layer = currentLayer();
  if (layer.locked) {
    setStatus("This layer is locked — unlock it first", true);
    return;
  }

  const info = exposureInfo(layer, state.project.currentFrame);
  const added = info.kind === "hold" ? 2 : 1;
  if (!canAddDrawings(state.project, layer, added)) return;

  stopPlayback();
  const before = snapshot();
  insertDrawing(layer, state.project.currentFrame);
  recordHistory(before);
  markDirty();
  afterChange();
  setStatus(`Inserted a blank drawing at frame ${state.project.currentFrame}`);
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
  playButton.textContent = "⏸ Pause";
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
    // After a long stall (hidden tab, debugger) resume gently, not in a jump.
    carry += elapsed > 500 ? 0 : (elapsed / 1000) * project.fps * state.playSpeed;
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
  playButton.textContent = "▶ Play";
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
  const canvasX = ((event.clientX - rect.left) * state.project.width) / rect.width;
  const canvasY = ((event.clientY - rect.top) * state.project.height) / rect.height;

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
 * Zoom with the wheel over the canvas.
 *
 * Every wheel over the stage zooms: a plain wheel, the middle button held
 * down and scrolled, and the control key that a trackpad sends for a pinch.
 * The button of a wheel event is not used to tell them apart, because a
 * browser reports every wheel as the primary button.
 */
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP);
  zoomStage(factor, event.clientX, event.clientY);
}, { passive: false });

// The middle mouse button drags the stage, the way Clip Studio Paint does it.
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  panStage(event);
});

function pressureFor(event) {
  if (!state.pressureEnabled) return null;
  if (event.pointerType !== "pen") return null;

  const value = Number(event.pressure);
  if (!Number.isFinite(value)) return null;
  // A pen touching the tablet can briefly report 0; keep a visible hairline.
  // The remembered gain scales the recorded pressure; 100% is neutral.
  return Math.min(1, Math.max(0.05, value * state.pressureGain));
}

function drawPoint(event) {
  const [x, y] = canvasPoint(event);
  const pressure = pressureFor(event);
  if (pressure === null) return [x, y];
  pressureValue.textContent = pressure.toFixed(2);
  return [x, y, pressure];
}

function layerForDrawing() {
  const layer = currentLayer();
  if (!layer) return null;
  if (!layer.visible) {
    setStatus("This layer is hidden — show it before drawing", true);
    return null;
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
  layer.drawings.push(drawing);
  layer.drawings.sort((a, b) => a.at - b.at);
  return drawing;
}

canvas.addEventListener("pointerdown", (event) => {
  if (state.playing) return;
  if (event.button !== 0) return;
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

  const layer = layerForDrawing();
  if (!layer) return;

  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic or already-released pointers have nothing to capture.
  }

  const before = snapshot();
  const existing = drawingAt(layer, state.project.currentFrame);
  const drawing = existing || ensureDrawing(layer, state.project.currentFrame);
  const stroke = {
    color: colorInput.value,
    width: Number(widthInput.value),
    points: [drawPoint(event)],
  };
  if (state.tool === "eraser") stroke.eraser = true;
  if (state.tool === "line" || state.tool === "rect" || state.tool === "ellipse") {
    // Shapes are a drag from the first point to this one; the second point
    // follows the pointer until release.
    stroke.kind = state.tool;
    stroke.points.push(drawPoint(event));
  } else if (state.tool === "fill") {
    stroke.kind = "fill";
  } else if (state.tool === "brush") {
    // Per-stroke finish applies to painted strokes (not eraser/fill).
    if (Number(strokeOpacityInput.value) < 100) {
      stroke.opacity = Number(strokeOpacityInput.value) / 100;
    }
    if (strokeBlendSelect.value !== "normal") stroke.blend = strokeBlendSelect.value;
  }
  state.smoothedPoint = stroke.points[stroke.points.length - 1];

  drawing.strokes.push(stroke);
  state.strokeBefore = before;
  state.strokeWasNew = !existing;
  state.drawing = stroke;
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
  if (!state.drawing) return;
  const point = drawPoint(event);

  if (state.drawing.kind && state.drawing.kind !== "fill") {
    // Shapes: the second point tracks the pointer for a live preview.
    state.drawing.points[1] = point;
    renderCanvas();
    return;
  }
  if (state.drawing.kind === "fill") return; // a fill is a single click

  // Freehand with stabiliser: ease each raw sample toward the running
  // point so shaky input becomes a smoother path (higher = smoother).
  const smoothed = smoothPoint(state.smoothedPoint, point, state.stabilizer);
  state.smoothedPoint = smoothed;

  const last = state.drawing.points[state.drawing.points.length - 1];
  if (Math.hypot(smoothed[0] - last[0], smoothed[1] - last[1]) < 1.5) return;
  state.drawing.points.push(smoothed);
  renderCanvas();
});

function endStroke() {
  if (state.cameraDrag) {
    commitCameraDrag();
    return;
  }
  if (!state.drawing) return;
  state.drawing = null;

  const before = state.strokeBefore;
  const wasNew = state.strokeWasNew;
  state.strokeBefore = null;
  state.strokeWasNew = false;
  if (before) recordHistory(before);

  const layer = currentLayer();
  const drawing = drawingAt(layer, state.project.currentFrame);
  const count = drawing ? drawing.strokes.length : 0;
  afterChange({ timeline: wasNew });
  setStatus(`${count} stroke${count === 1 ? "" : "s"} on ${layer.name}, frame ${state.project.currentFrame}`);
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

/* ------------------------------------------------------------- tool panel */

widthInput.addEventListener("input", () => {
  widthValue.textContent = widthInput.value;
  syncQuickBar();
});

colorInput.addEventListener("input", () => {
  syncQuickBar();
});

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
  eraser: () => eraserButton,
  pick: () => pickButton,
  line: () => lineToolButton,
  rect: () => rectToolButton,
  ellipse: () => ellipseToolButton,
  fill: () => fillToolButton,
  camera: () => cameraToolButton,
};

const TOOL_STATUS = {
  brush: "Brush — paint with the selected colour",
  eraser: "Eraser — removes paint and reveals lower layers or the canvas",
  pick: "Pick — click the canvas to sample a colour",
  line: "Line — drag from one point to another (L)",
  rect: "Rectangle — drag opposite corners (R)",
  ellipse: "Ellipse — drag the outline (E)",
  fill: "Fill — click a region to flood it with the colour (F)",
  camera: "Camera — drag the frame to aim the shot, drag a corner to resize (C)",
};

function selectTool(tool) {
  state.tool = tool;
  const picking = tool === "pick";

  for (const [name, buttonOf] of Object.entries(TOOL_BUTTONS)) {
    const active = name === tool;
    buttonOf().classList.toggle("active", active);
    buttonOf().setAttribute("aria-pressed", String(active));
  }
  colorInput.disabled = tool === "eraser" || tool === "fill" || tool === "camera";
  canvas.classList.toggle("picking", picking);
  canvas.classList.toggle("camera-tool", tool === "camera");
  setStatus(TOOL_STATUS[tool] ?? "Tool ready");
}

brushButton.addEventListener("click", () => selectTool("brush"));
eraserButton.addEventListener("click", () => selectTool("eraser"));
pickButton.addEventListener("click", () => selectTool("pick"));
lineToolButton.addEventListener("click", () => selectTool("line"));
rectToolButton.addEventListener("click", () => selectTool("rect"));
ellipseToolButton.addEventListener("click", () => selectTool("ellipse"));
fillToolButton.addEventListener("click", () => selectTool("fill"));
cameraToolButton.addEventListener("click", () => selectTool("camera"));

function selectedWidth() {
  return Number(widthInput.value);
}

function changeWidth(delta) {
  const next = Math.max(1, Math.min(60, selectedWidth() + delta));
  if (next === selectedWidth()) return;
  widthInput.value = String(next);
  widthValue.textContent = String(next);
  setStatus(`Brush width ${next}`);
}

function rgbToHex(red, green, blue) {
  const hex = (value) => value.toString(16).padStart(2, "0");
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

/** Sample the composited canvas colour under the cursor, then draw again. */
function pickColourAt(event) {
  const [x, y] = canvasPoint(event);
  const px = Math.min(canvas.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(canvas.height - 1, Math.max(0, Math.round(y)));
  const [red, green, blue] = ctx.getImageData(px, py, 1, 1).data;
  colorInput.value = rgbToHex(red, green, blue);
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
      state.stabilizer = Math.max(0, Math.min(10, Math.round(data.stabilizer)));
    }
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
        stabilizer: state.stabilizer,
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
  stabilizerInput.value = String(state.stabilizer);
  stabilizerValue.textContent = String(state.stabilizer);
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
  const value = Math.max(0, Math.min(10, Math.round(Number(stabilizerInput.value))));
  state.stabilizer = value;
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

playButton.addEventListener("click", togglePlayback);
loopInput.addEventListener("change", toggleLoop);
fpsInput.addEventListener("change", changeFps);
startFrameInput.addEventListener("change", changeStartFrame);
addLayerButton.addEventListener("click", addLayer);
deleteLayerButton.addEventListener("click", deleteLayer);
layerUpButton.addEventListener("click", () => moveLayer(-1));
layerDownButton.addEventListener("click", () => moveLayer(1));
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
  } catch (error) {
    setStatus(error.message, true);
  }
}

function confirmDiscard() {
  if (!state.dirty) return true;
  return confirm("This project has unsaved changes. Discard them?");
}

function newProject() {
  if (!confirmDiscard()) return;
  stopPlayback();
  newDocument();
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

async function openPath(filePath) {
  if (!confirmDiscard()) return;
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
    setStatus(
      `Imported ${data.name} (${data.project.width}x${data.project.height}), ` +
        `${data.project.layers.length} layer(s) at ${data.project.fps} fps. ` +
        "Save as .tvmini to keep it, or export a .clip - the .clip itself is never changed.",
    );
  }
}

async function importClip(filePath) {
  const data = await backend.importClip(filePath);
  if (!data) return;
  applyImportedProject(data, "clip");
}

async function chooseAndImportClip() {
  if (!confirmDiscard()) return;
  const data = await backend.chooseAndImportClip();
  if (!data) return;
  applyImportedProject(data, "clip");
}

async function importTvpp(filePath) {
  const data = await backend.importTvpp(filePath);
  if (!data) return;
  applyImportedProject(data, "tvpp");
}

async function chooseAndImportTvpp() {
  if (!confirmDiscard()) return;
  const data = await backend.chooseAndImportTvpp();
  if (!data) return;
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
  setStatus("Building layered .clip…");
  const data = await backend.exportClip(state.project, stem, state.clipSourcePath);
  if (!data) return;
  setStatus(
    `Exported ${data.layers} layer${data.layers === 1 ? "" : "s"} at ${data.width}×${data.height} ` +
      `to ${baseName(data.path)} (${data.bytes} bytes). Timeline frames are flattened to the current frame.`,
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

/* ------------------------------------------------------------- file modal */

let picker = null;

function choosePath({ mode, title, name = "" }) {
  picker = { mode, resolve: null, dir: null };
  modalTitle.textContent = title;
  nameInput.value = name;
  confirmButton.textContent = mode === "open" ? "Open" : "Save";
  modal.hidden = false;

  const start = state.currentPath
    ? state.currentPath.replace(/[\\/][^\\/]*$/, "")
    : null;

  loadDir(start || dirInput.value || state.homeDir || ".");

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
          loadDir(entry.path);
          nameInput.value = "";
        } else {
          nameInput.value = entry.path;
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
  if (!name) {
    setStatus("Enter a file name", true);
    nameInput.focus();
    return;
  }
  finishPicker(joinPath(picker.dir, name));
});

nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") confirmButton.click();
});

/* ------------------------------------------------- colour wheel (HSV) */

const wheelButton = document.getElementById("wheelButton");
const wheelPanel = document.getElementById("wheelPanel");
const wheelCanvas = document.getElementById("wheelCanvas");
const wheelHex = document.getElementById("wheelHex");
const wheelTransparent = document.getElementById("wheelTransparent");
const onionInput = document.getElementById("onion");
const speedInput = document.getElementById("speed");
const onionBeforeInput = document.getElementById("onionBefore");
const onionAfterInput = document.getElementById("onionAfter");

/* Matches the reference layout: hue ring around an inscribed SV square. */
const WHEEL_SIZE = 214;

const wheel = { hue: 222, saturation: 0.8, value: 0.6 };

function hsvToRgb(h, s, v) {
  const sector = ((h % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((sector % 2) - 1));
  const m = v - c;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][Math.floor(sector) % 6];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === red) h = 60 * (((green - blue) / delta) % 6);
    else if (max === green) h = 60 * ((blue - red) / delta + 2);
    else h = 60 * ((red - green) / delta + 4);
  }
  return [((h % 360) + 360) % 360, max === 0 ? 0 : delta / max, max];
}

function renderWheel() {
  const ctx = wheelCanvas.getContext("2d");
  const centre = WHEEL_SIZE / 2;
  const ringOuter = centre - 0;
  const ringInner = centre - 24;
  const ringMiddle = (ringOuter + ringInner) / 2;
  const svHalf = Math.floor(ringInner * Math.SQRT1_2) - 1;
  const side = svHalf * 2;
  const squareX = centre - svHalf;
  const squareY = centre - svHalf;

  ctx.clearRect(0, 0, WHEEL_SIZE, WHEEL_SIZE);

  // Hue ring: one thin arc per degree.
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
  const hueAngle = wheel.hue * (Math.PI / 180);
  ctx.beginPath();
  ctx.arc(centre + ringMiddle * Math.cos(hueAngle), centre + ringMiddle * Math.sin(hueAngle), 4, 0, Math.PI * 2);
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

function wheelApply() {
  const [red, green, blue] = hsvToRgb(wheel.hue, wheel.saturation, wheel.value);
  const hex = rgbToHex(red, green, blue);
  colorInput.value = hex;
  wheelHex.value = hex;
  colorInput.dispatchEvent(new Event("input", { bubbles: true }));
  renderWheel();
}

function wheelFromEvent(event) {
  const rect = wheelCanvas.getBoundingClientRect();
  const scale = WHEEL_SIZE / rect.width;
  const x = (event.clientX - rect.left) * scale;
  const y = (event.clientY - rect.top) * scale;
  const dx = x - WHEEL_SIZE / 2;
  const dy = y - WHEEL_SIZE / 2;
  const radius = Math.hypot(dx, dy);
  const ringInner = WHEEL_SIZE / 2 - 24;
  const svHalf = Math.floor(ringInner * Math.SQRT1_2) - 1;

  if (radius >= ringInner - 2 && radius <= WHEEL_SIZE / 2 + 2) {
    wheel.hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360;
  } else if (Math.abs(dx) <= svHalf + 2 && Math.abs(dy) <= svHalf + 2) {
    wheel.saturation = Math.min(1, Math.max(0, dx / (svHalf * 2) + 0.5));
    wheel.value = Math.min(1, Math.max(0, 1 - (dy / (svHalf * 2) + 0.5)));
  }
  wheelApply();
}

function wheelSyncFromColor() {
  const match = /^#?([0-9a-f]{6})$/i.exec(colorInput.value.trim());
  if (!match) return;
  const hex = match[1];
  const rgb = [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
  [wheel.hue, wheel.saturation, wheel.value] = rgbToHsv(...rgb);
}

wheelButton.addEventListener("click", () => {
  wheelPanel.hidden = !wheelPanel.hidden;
  if (!wheelPanel.hidden) {
    wheelSyncFromColor();
    wheelApply();
  }
});

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
  wheelPanel.hidden = true;
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
    if (base) context.drawImage(base, 0, 0, project.width, project.height);
    drawStrokesInto(context, resolved.drawing.strokes);
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
}

function anyOverlayOpen() {
  return !startOverlay.hidden || !keysDialog.hidden || !guideDialog.hidden;
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
  if (event.key === "Escape") {
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
  backend = await detectBackend({ pickPath: choosePath });

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
  syncQuickBar();

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
}

boot();
