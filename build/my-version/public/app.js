import { History } from "./history.js";

const FORMAT = "tvmini";
const VERSION = 1;

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

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const dirInput = document.getElementById("dirInput");
const dirList = document.getElementById("dirList");
const nameInput = document.getElementById("nameInput");
const upButton = document.getElementById("upButton");
const goButton = document.getElementById("goButton");
const cancelButton = document.getElementById("cancelButton");
const confirmButton = document.getElementById("confirmButton");

const state = {
  project: blankProject(960, 600),
  currentPath: null,
  suggestedName: null,
  dirty: false,
  recent: [],
  drawing: null,
  strokeBefore: null,
  pressureEnabled: true,
  homeDir: ".",
};

const history = new History({ limit: 100 });

function cloneStrokes() {
  return structuredClone(state.project.strokes);
}

function updateHistoryButtons() {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
}

function recordHistory(before) {
  history.record(before);
  updateHistoryButtons();
}

function undo() {
  if (state.drawing) return;
  const previous = history.undo(cloneStrokes());
  if (!previous) return;
  state.project.strokes = structuredClone(previous);
  state.dirty = true;
  render();
  refreshTitle();
  updateHistoryButtons();
  setStatus("Undo");
}

function redo() {
  if (state.drawing) return;
  const next = history.redo(cloneStrokes());
  if (!next) return;
  state.project.strokes = structuredClone(next);
  state.dirty = true;
  render();
  refreshTitle();
  updateHistoryButtons();
  setStatus("Redo");
}

/* ------------------------------------------------------------------ model */

function blankProject(width, height) {
  return {
    format: FORMAT,
    version: VERSION,
    width,
    height,
    background: "#ffffff",
    image: null,
    strokes: [],
  };
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

/* -------------------------------------------------------------- api calls */

async function api(method, endpoint, body) {
  const response = await fetch(endpoint, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

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

function resizeCanvas() {
  canvas.width = state.project.width;
  canvas.height = state.project.height;
  render();
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
    previewImage.onload = () => render();
    previewImage.src = `data:image/png;base64,${data}`;
  }

  return previewImage?.complete ? previewImage : null;
}

function render() {
  ctx.fillStyle = state.project.background;
  ctx.fillRect(0, 0, state.project.width, state.project.height);

  const image = projectImage();
  if (image) {
    ctx.drawImage(image, 0, 0, state.project.width, state.project.height);
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of state.project.strokes) {
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;

    const radii = stroke.points.map((point) => strokeRadius(stroke, point));

    if (stroke.points.length === 1) {
      ctx.beginPath();
      ctx.arc(stroke.points[0][0], stroke.points[0][1], radii[0], 0, Math.PI * 2);
      ctx.fill();
      continue;
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
      continue;
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
  }
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
  return Math.min(1, Math.max(0.05, value));
}

function drawPoint(event) {
  const [x, y] = canvasPoint(event);
  const pressure = pressureFor(event);
  if (pressure === null) return [x, y];
  pressureValue.textContent = pressure.toFixed(2);
  return [x, y, pressure];
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic or already-released pointers have nothing to capture.
  }

  const stroke = {
    color: colorInput.value,
    width: Number(widthInput.value),
    points: [drawPoint(event)],
  };

  state.strokeBefore = cloneStrokes();
  state.project.strokes.push(stroke);
  state.drawing = stroke;
  state.dirty = true;
  refreshTitle();
  render();
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.drawing) return;
  const point = drawPoint(event);
  const last = state.drawing.points[state.drawing.points.length - 1];
  if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 1.5) return;
  state.drawing.points.push(point);
  render();
});

function endStroke() {
  if (!state.drawing) return;
  state.drawing = null;

  const before = state.strokeBefore;
  state.strokeBefore = null;
  if (before) recordHistory(before);

  setStatus(`${state.project.strokes.length} stroke(s)`);
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

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

clearButton.addEventListener("click", () => {
  if (state.project.strokes.length === 0) return;
  if (!confirm("Clear every stroke on this canvas?")) return;
  const before = cloneStrokes();
  state.project.strokes = [];
  recordHistory(before);
  state.dirty = true;
  refreshTitle();
  render();
});

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);

/* --------------------------------------------------------------- menu bar */

function closeMenus() {
  fileMenu.hidden = true;
  fileButton.setAttribute("aria-expanded", "false");
  recentMenu.hidden = true;
}

fileButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = fileMenu.hidden;
  fileMenu.hidden = !open;
  fileButton.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (!fileMenu.hidden && !fileMenu.contains(event.target) && event.target !== fileButton) {
    closeMenus();
  }
});

fileMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  closeMenus();
  handleAction(button.dataset.action);
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
      openPath(entry.path);
    });
    recentMenu.append(button);
  }
}

async function refreshRecent() {
  try {
    const data = await api("GET", "/api/recent");
    state.recent = data.entries;
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
  } catch (error) {
    setStatus(error.message, true);
  }
}

function confirmDiscard() {
  if (!state.dirty) return true;
  return confirm("This canvas has unsaved changes. Discard them?");
}

function newProject() {
  if (!confirmDiscard()) return;
  state.project = blankProject(960, 600);
  state.currentPath = null;
  state.suggestedName = null;
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

  const data = await api("POST", "/api/open", { path: filePath });
  state.project = data.project;
  state.currentPath = data.path;
  state.suggestedName = null;
  state.dirty = false;
  state.recent = data.recent;
  history.reset();
  updateHistoryButtons();
  resizeCanvas();
  refreshTitle();
  renderRecent();
  setStatus(`Opened ${baseName(data.path)}`);
}

async function importClip(filePath) {
  const data = await api("POST", "/api/import-clip", { path: filePath });
  state.project = data.project;
  state.currentPath = null;
  state.suggestedName = `${data.name.replace(/\.clip$/i, "")}.tvmini`;
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

async function chooseAndImportClip() {
  if (!confirmDiscard()) return;
  const filePath = await choosePath({ mode: "open", title: "Import .clip preview" });
  if (!filePath) return;
  if (!/\.clip$/i.test(filePath)) {
    setStatus("Choose a Clip Studio .clip file", true);
    return;
  }
  await importClip(filePath);
}

async function chooseAndOpen() {
  if (!confirmDiscard()) return;
  const filePath = await choosePath({ mode: "open", title: "Open project" });
  if (!filePath) return;
  await openPath(filePath);
}

async function save() {
  if (!state.currentPath) return saveAs();
  const data = await api("POST", "/api/save", {
    path: state.currentPath,
    project: state.project,
  });
  state.currentPath = data.path;
  state.dirty = false;
  state.recent = data.recent;
  refreshTitle();
  renderRecent();
  setStatus(`Saved ${baseName(data.path)} (${data.bytes} bytes)`);
}

async function saveAs() {
  const filePath = await choosePath({
    mode: "save",
    title: "Save project as",
    name: state.currentPath
      ? baseName(state.currentPath)
      : state.suggestedName || "untitled.tvmini",
  });
  if (!filePath) return;

  const data = await api("POST", "/api/save", { path: filePath, project: state.project });
  state.currentPath = data.path;
  state.dirty = false;
  state.recent = data.recent;
  refreshTitle();
  renderRecent();
  setStatus(`Saved ${baseName(data.path)} (${data.bytes} bytes)`);
}

async function exportPng() {
  const filePath = await choosePath({
    mode: "save",
    title: "Export PNG",
    name: `${state.currentPath ? baseName(state.currentPath).replace(/\.[^.]+$/, "") : "untitled"}.png`,
  });
  if (!filePath) return;

  const data = await api("POST", "/api/export", { path: filePath, project: state.project });
  setStatus(`Exported ${data.width}×${data.height} PNG (${data.bytes} bytes)`);
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
    const data = await api("GET", `/api/list?dir=${encodeURIComponent(dir)}`);
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.hidden) {
    finishPicker(null);
    return;
  }

  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier) return;

  const key = event.key.toLowerCase();
  const typing =
    event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

  if (!typing && key === "z" && event.shiftKey) {
    event.preventDefault();
    redo();
  } else if (!typing && key === "z") {
    event.preventDefault();
    undo();
  } else if (!typing && (key === "a" || key === "y")) {
    event.preventDefault();
    redo();
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
  try {
    const data = await api("GET", "/api/state");
    state.recent = data.recent;
    state.homeDir = data.home;
    renderRecent();
    setStatus("Ready — nothing is saved until you choose Save");
  } catch (error) {
    setStatus(`Cannot reach the local server: ${error.message}`, true);
  }

  resizeCanvas();
  refreshTitle();
  updateHistoryButtons();
}

boot();
