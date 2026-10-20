import { History } from "./history.js";
import { detectBackend } from "./core/platform.js";
import {
  contentEnd,
  deleteDrawing,
  drawingAt,
  duplicateDrawing,
  exposureInfo,
  holdDrawing,
  insertDrawing,
  resolveDrawing,
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
  recent: [],
  drawing: null,
  strokeBefore: null,
  strokeWasNew: false,
  pressureEnabled: true,
  tool: "brush",
  homeDir: ".",
  playing: false,
  playTimer: null,
  opacityBefore: null,
  // Remembered preferences (pressure gain, touch drawing, start screen).
  pressureGain: 1,
  touchDraw: true,
  showStart: true,
};

const history = new History({ limit: 100 });

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
}

function recordHistory(before) {
  if (!before) return;
  history.record(before);
  updateHistoryButtons();
}

function markDirty() {
  state.dirty = true;
  refreshTitle();
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
const paintCtx = paintCanvas.getContext("2d");

const MIN_PRESSURE_SCALE = 0.2;

function strokeRadius(stroke, point) {
  const base = stroke.width / 2;
  const radius =
    point.length === 3
      ? base * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * point[2])
      : base;
  return Math.max(0.5, radius);
}

function drawStrokesToPaint(strokes) {
  paintCtx.globalCompositeOperation = "source-over";
  paintCtx.lineCap = "round";
  paintCtx.lineJoin = "round";

  for (const stroke of strokes) {
    paintCtx.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
    paintCtx.strokeStyle = stroke.color;
    paintCtx.fillStyle = stroke.color;

    const radii = stroke.points.map((point) => strokeRadius(stroke, point));

    if (stroke.points.length === 1) {
      paintCtx.beginPath();
      paintCtx.arc(stroke.points[0][0], stroke.points[0][1], radii[0], 0, Math.PI * 2);
      paintCtx.fill();
      continue;
    }

    const tapered = stroke.points.some((point) => point.length === 3);
    if (!tapered) {
      paintCtx.lineWidth = stroke.width;
      paintCtx.beginPath();
      paintCtx.moveTo(stroke.points[0][0], stroke.points[0][1]);
      for (let i = 1; i < stroke.points.length; i += 1) {
        paintCtx.lineTo(stroke.points[i][0], stroke.points[i][1]);
      }
      paintCtx.stroke();
      continue;
    }

    // Pressure strokes are drawn segment by segment with an interpolated width.
    for (let i = 1; i < stroke.points.length; i += 1) {
      const from = stroke.points[i - 1];
      const to = stroke.points[i];
      paintCtx.lineWidth = Math.max(1, radii[i - 1] + radii[i]);
      paintCtx.beginPath();
      paintCtx.moveTo(from[0], from[1]);
      paintCtx.lineTo(to[0], to[1]);
      paintCtx.stroke();
    }
  }

  paintCtx.globalCompositeOperation = "source-over";
}

function renderCanvas(frame = state.project.currentFrame) {
  const project = state.project;
  const { width, height } = project;

  ctx.globalAlpha = 1;
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

    const resolved = resolveDrawing(layer, frame);
    if (!resolved) continue;

    paintCtx.clearRect(0, 0, width, height);
    drawStrokesToPaint(resolved.drawing.strokes);

    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(paintCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
}

/* ---------------------------------------------------------------- timeline */

function timelineColumnCount() {
  return Math.max(12, Math.min(MAX_COLUMNS, timelineColumns(state.project, 12)));
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

  updatePlayhead();
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
  const project = state.project;
  if (contentEnd(project) < project.startFrame) {
    setStatus("There are no drawings to play", true);
    return;
  }
  if (project.currentFrame > playbackEnd()) project.currentFrame = project.startFrame;

  state.playing = true;
  playButton.textContent = "⏸ Pause";

  const tick = () => {
    const end = playbackEnd();
    if (project.currentFrame >= end) {
      if (project.loop) {
        project.currentFrame = project.startFrame;
      } else {
        stopPlayback();
        setStatus("Playback finished");
        return;
      }
    } else {
      project.currentFrame += 1;
    }
    updateFrameLabel();
    updatePlayhead();
    renderCanvas();
  };

  state.playTimer = setInterval(tick, Math.max(16, Math.round(1000 / project.fps)));
  setStatus(`Playing at ${project.fps} fps`);
}

function stopPlayback() {
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
  state.playing = false;
  playButton.textContent = "▶ Play";
  if (state.project?.layers?.length) syncLayerControls();
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
  return [
    ((event.clientX - rect.left) * state.project.width) / rect.width,
    ((event.clientY - rect.top) * state.project.height) / rect.height,
  ];
}

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

  drawing.strokes.push(stroke);
  state.strokeBefore = before;
  state.strokeWasNew = !existing;
  state.drawing = stroke;
  markDirty();
  renderCanvas();
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.drawing) return;
  const point = drawPoint(event);
  const last = state.drawing.points[state.drawing.points.length - 1];
  if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 1.5) return;
  state.drawing.points.push(point);
  renderCanvas();
});

function endStroke() {
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
});

pressureInput.addEventListener("change", () => {
  state.pressureEnabled = pressureInput.checked;
  setStatus(
    state.pressureEnabled
      ? "Pen pressure on — width follows the stylus"
      : "Pen pressure off — constant width",
  );
});

function selectTool(tool) {
  state.tool = tool;
  const eraser = tool === "eraser";
  const pick = tool === "pick";

  brushButton.classList.toggle("active", !eraser && !pick);
  eraserButton.classList.toggle("active", eraser);
  pickButton.classList.toggle("active", pick);
  brushButton.setAttribute("aria-pressed", String(!eraser && !pick));
  eraserButton.setAttribute("aria-pressed", String(eraser));
  pickButton.setAttribute("aria-pressed", String(pick));
  colorInput.disabled = eraser;
  canvas.classList.toggle("picking", pick);

  setStatus(
    pick
      ? "Pick — click the canvas to sample a colour"
      : eraser
        ? "Eraser — removes paint and reveals lower layers or the canvas"
        : "Brush — paint with the selected colour",
  );
}

brushButton.addEventListener("click", () => selectTool("brush"));
eraserButton.addEventListener("click", () => selectTool("eraser"));
pickButton.addEventListener("click", () => selectTool("pick"));

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

function loadSettings() {
  try {
    const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") || {};
    if (Number.isFinite(data.pressureGain)) {
      state.pressureGain = Math.min(3, Math.max(0.25, data.pressureGain));
    }
    state.touchDraw = data.touchDraw !== false;
    state.showStart = data.showStart !== false;
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
    if (action === "save") return save();
    if (action === "saveAs") return saveAs();
    if (action === "export") return exportPng();
    if (action === "exportClip") return exportClip();
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
  state.project = blankProject(960, 600);
  state.currentPath = null;
  state.suggestedName = null;
  state.clipSourcePath = null;
  state.dirty = false;
  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  setStatus("New project");
}

async function openPath(filePath) {
  if (!confirmDiscard()) return;
  if (/\.clip$/i.test(filePath)) return importClip(filePath);

  const data = await backend.open(filePath);
  if (!data) return;
  stopPlayback();
  state.project = data.project;
  state.currentPath = data.name;
  state.suggestedName = null;
  state.clipSourcePath = null;
  state.dirty = false;
  if (data.recent) state.recent = data.recent;
  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  renderRecent();
  setStatus(`Opened ${baseName(data.name)}`);
}

/** Put an imported .clip preview on the canvas (shared by every import path). */
function applyImportedClip(data) {
  stopPlayback();
  state.project = data.project;
  state.currentPath = null;
  state.suggestedName = `${data.name.replace(/\.clip$/i, "")}.tvmini`;
  state.clipSourcePath = data.path || null;
  state.dirty = false;
  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  setStatus(
    `Imported the preview from ${data.name} (${data.project.width}×${data.project.height}). ` +
      "Save as .tvmini to keep it — the .clip itself is never changed.",
  );
}

async function importClip(filePath) {
  const data = await backend.importClip(filePath);
  if (!data) return;
  applyImportedClip(data);
}

async function chooseAndImportClip() {
  if (!confirmDiscard()) return;
  const data = await backend.chooseAndImportClip();
  if (!data) return;
  applyImportedClip(data);
}

async function chooseAndOpen() {
  if (!confirmDiscard()) return;
  const data = await backend.chooseAndOpen();
  if (!data) return;
  stopPlayback();
  state.project = data.project;
  state.currentPath = data.name;
  state.suggestedName = null;
  state.clipSourcePath = null;
  state.dirty = false;
  if (data.recent) state.recent = data.recent;
  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
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
  refreshTitle();
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
  refreshTitle();
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

/* ---------------------------------------------------------------- keyboard */

const KEYS = [
  {
    group: "Tools",
    rows: [
      ["Brush", "B"],
      ["Pick a colour from the canvas", "I"],
      ["Eraser", "E"],
      ["Smaller / larger brush", "[ / ]"],
      ["Clear the current drawing", "Backspace"],
    ],
  },
  {
    group: "Timeline",
    rows: [
      ["Play / pause", "Space"],
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
    if (key === "i") {
      event.preventDefault();
      selectTool(state.tool === "pick" ? "brush" : "pick");
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

  loadSettings();
  syncSettingsUI();

  try {
    state.recent = await backend.listRecent();
    renderRecent();
  } catch (error) {
    setStatus(error.message, true);
  }

  resizeCanvas();
  refreshTitle();
  updateHistoryButtons();
  setStatus(
    backend.mode === "server"
      ? "Ready — draw on the canvas, then use the timeline to add layers and drawings"
      : "Ready — running in the browser. Files are saved to this device.",
  );
  showStart();
}

boot();
