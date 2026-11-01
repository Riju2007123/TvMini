/**
 * Flash 8 options: the panel, the dialogs and the glue to the drawing logic.
 *
 * `core/flash8-drawing.js` holds the behaviour (tables, recognition, curve
 * fitting, snapping, gap-closing fill). This file owns the settings, wires
 * the controls that `index.html` already has, and gives `app.js` a few small
 * hooks. It reads nothing from Flash itself: the numbers come from the
 * behavioural notes in `docs/flash8-re/`.
 */

import {
  FLASH8_ASSISTANT,
  GAP_TOLERANCES,
  PENCIL_MODES,
  constrain45,
  optimizeCurves,
  processStraighten,
  smoothBézierFit,
  snapToGrid,
  snapToObjectPoints,
} from "./core/flash8-drawing.js";
import {
  clearKeyframe,
  insertBlankKeyframe,
  insertFrameSpan,
  insertKeyframe,
  removeFrameSpan,
} from "./timeline.js";

const STORAGE_KEY = "tvmini.flash8";

const DEFAULTS = {
  pencilMode: PENCIL_MODES.SMOOTH,
  paintMode: "normal",
  brushShape: "circle",
  lockFill: false,
  gap: "none",
  eraserMode: "normal",
  faucet: false,
  snapGrid: false,
  snapObjects: true,
  gridSize: 20,
  brushSmoothness: 50, // `Stroke\Brush Smoothness` default
  pencilSmoothness: 50, // `Stroke\Pencil Smoothness` default
  assistant: { connect: 2, curve: 2, line: 2, shape: 2, tap: 2 },
};

/** The live settings. `app.js` reads these directly. */
export const settings = structuredClone(DEFAULTS);

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return;
    for (const key of Object.keys(DEFAULTS)) {
      if (key === "assistant") continue;
      if (typeof saved[key] === typeof DEFAULTS[key]) settings[key] = saved[key];
    }
    for (const key of Object.keys(DEFAULTS.assistant)) {
      const level = Number(saved.assistant?.[key]);
      if (Number.isInteger(level)) settings.assistant[key] = clampLevel(level);
    }
  } catch {
    // Settings are a convenience; a blocked or broken store is not an error.
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Same as above.
  }
}

function clampLevel(level) {
  return Math.max(0, Math.min(4, level));
}

/* ------------------------------------------------------------- app hooks */

/** Gap in pixels for the paint bucket (0 closes nothing). */
export function gapTolerance() {
  return GAP_TOLERANCES[settings.gap] ?? 0;
}

/** Click accuracy as a snap radius in pixels. */
function snapRadius() {
  const level = Math.min(2, settings.assistant.tap);
  return FLASH8_ASSISTANT.CLICK_ACCURACY.SNAP_RADIUS[level];
}

/** The composite operation a stroke is painted with. */
export function compositeFor(stroke) {
  return stroke.paintMode === "behind" ? "destination-over" : "source-over";
}

/** What the current tool adds to a new stroke. */
export function strokeExtras(tool) {
  if (tool === "brush") {
    const extras = {};
    if (settings.paintMode !== "normal") extras.paintMode = settings.paintMode;
    if (settings.brushShape !== "circle") extras.tip = settings.brushShape;
    if (settings.lockFill) extras.lockFill = true;
    return extras;
  }
  if (tool === "eraser") {
    const extras = {};
    if (settings.eraserMode !== "normal") extras.eraseMode = settings.eraserMode;
    if (settings.faucet) extras.faucet = true;
    return extras;
  }
  return {};
}

/**
 * Where a stroke starts or a shape ends: snapped to the grid and to the
 * ends of the strokes already in the cell.
 */
export function snapPoint(point, drawing) {
  let [x, y] = point;
  if (settings.snapObjects && drawing) {
    const candidates = [];
    for (const stroke of drawing.strokes) {
      if (stroke.eraser || stroke.kind === "fill" || !stroke.points?.length) continue;
      candidates.push(stroke.points[0], stroke.points[stroke.points.length - 1]);
    }
    const hit = snapToObjectPoints(x, y, candidates, snapRadius());
    if (hit.snapped) return [hit.x, hit.y, ...point.slice(2)];
  }
  if (settings.snapGrid) [x, y] = snapToGrid(x, y, settings.gridSize);
  return [x, y, ...point.slice(2)];
}

/** The free end of a line or shape, held to 45° steps while Shift is down. */
export function constrainEnd(origin, point, shiftKey) {
  if (!shiftKey) return point;
  const [x, y] = constrain45(origin[0], origin[1], point[0], point[1]);
  return [x, y, ...point.slice(2)];
}

/** The pencil's finished line, shaped by its mode. */
export function finishPencil(stroke) {
  const points = stroke.points;
  if (!points || points.length < 2) return;
  if (settings.pencilMode === PENCIL_MODES.STRAIGHTEN) {
    stroke.points = processStraighten(points, settings.assistant);
  } else if (settings.pencilMode === PENCIL_MODES.SMOOTH) {
    stroke.points = smoothBézierFit(points, settings.pencilSmoothness, settings.assistant.curve);
  }
  // Ink keeps the line as it was drawn.
}

/* -------------------------------------------------------------- the panel */

const $ = (id) => document.getElementById(id);

function show(id, visible) {
  const element = $(id);
  if (element) element.hidden = !visible;
}

/** Show the option group that belongs to the tool in the hand. */
export function syncTool(tool) {
  show("f8PencilOpts", tool === "pencil");
  show("flash8BrushOpts", tool === "brush");
  show("flash8FillOpts", tool === "fill");
  show("flash8EraserOpts", tool === "eraser");
}

function bindSelect(id, key, after) {
  const element = $(id);
  if (!element) return;
  element.value = String(settings[key]);
  element.addEventListener("change", () => {
    settings[key] = element.value;
    save();
    after?.(element.value);
  });
}

function bindCheckbox(id, key) {
  const element = $(id);
  if (!element) return;
  element.checked = settings[key] === true;
  element.addEventListener("change", () => {
    settings[key] = element.checked;
    save();
  });
}

function bindNumber(id, key, min, max) {
  const element = $(id);
  if (!element) return;
  element.value = String(settings[key]);
  element.addEventListener("change", () => {
    const value = Math.round(Number(element.value) || 0);
    settings[key] = Math.max(min, Math.min(max, value));
    element.value = String(settings[key]);
    save();
  });
}

function bindToggle(id, key) {
  const element = $(id);
  if (!element) return;
  const paint = () => {
    element.classList.toggle("on", settings[key] === true);
    element.setAttribute("aria-pressed", String(settings[key] === true));
  };
  paint();
  element.addEventListener("click", () => {
    settings[key] = !settings[key];
    save();
    paint();
  });
}

const ASSISTANT_FIELDS = [
  ["f8ConnectSetting", "connect"],
  ["f8CurveSetting", "curve"],
  ["f8LineSetting", "line"],
  ["f8ShapeSetting", "shape"],
  ["f8TapSetting", "tap"],
];

/** Five levels per setting; Flash's own labels were not recovered. */
function fillAssistantSelects() {
  for (const [id, key] of ASSISTANT_FIELDS) {
    const select = $(id);
    if (!select) continue;
    select.replaceChildren();
    const top = key === "tap" ? 2 : 4;
    for (let level = 0; level <= top; level += 1) {
      const option = document.createElement("option");
      option.value = String(level);
      option.textContent = level === FLASH8_ASSISTANT.DEFAULT_LEVEL ? `Level ${level} (default)` : `Level ${level}`;
      select.append(option);
    }
  }
}

function openAssistant() {
  for (const [id, key] of ASSISTANT_FIELDS) {
    const select = $(id);
    if (select) select.value = String(Math.min(settings.assistant[key], key === "tap" ? 2 : 4));
  }
  show("drawingSettingsModal", true);
}

function bindAssistant(host) {
  fillAssistantSelects();
  const close = () => show("drawingSettingsModal", false);
  $("f8DrawingSettingsBtn")?.addEventListener("click", openAssistant);
  $("f8DrawingSettingsCancel")?.addEventListener("click", close);
  $("f8DrawingSettingsReset")?.addEventListener("click", () => {
    for (const [id, key] of ASSISTANT_FIELDS) {
      const select = $(id);
      if (select) select.value = String(DEFAULTS.assistant[key]);
    }
  });
  $("f8DrawingSettingsOk")?.addEventListener("click", () => {
    for (const [id, key] of ASSISTANT_FIELDS) {
      const select = $(id);
      if (select) settings.assistant[key] = clampLevel(Number(select.value));
    }
    save();
    close();
    host.setStatus("Drawing settings updated");
  });
}

/* ------------------------------------------------------- optimize curves */

function bindOptimize(host) {
  const slider = $("f8OptSmoothing");
  const output = $("f8OptSmoothingValue");
  const passes = $("f8OptPasses");
  const result = $("f8OptResult");
  slider?.addEventListener("input", () => {
    if (output) output.textContent = slider.value;
  });
  $("f8OptClose")?.addEventListener("click", () => show("optimizeCurvesModal", false));
  $("f8OptRunBtn")?.addEventListener("click", () => {
    const drawing = host.currentDrawing();
    if (!drawing) {
      if (result) result.textContent = "There is no drawing on this frame.";
      return;
    }
    const before = host.snapshot();
    const targets = drawing.strokes.filter(
      (stroke) => !stroke.eraser && !stroke.kind && stroke.points?.length > 2,
    );
    const outcome = optimizeCurves(targets, Number(slider?.value ?? 50), passes?.checked !== false);
    targets.forEach((stroke, index) => {
      stroke.points = outcome.strokes[index].points;
    });
    if (outcome.afterCount < outcome.beforeCount) {
      host.recordHistory(before);
      host.markDirty();
      host.afterChange({ timeline: false });
    }
    if (result) {
      result.textContent = `${outcome.beforeCount} points before, ${outcome.afterCount} after (${outcome.reduction}% fewer).`;
    }
  });
}

/* ------------------------------------------------------------ the keyframes */

function bindKeyframes(host) {
  const run = (label, change) => () => {
    const layer = host.currentLayer();
    if (!layer) return;
    const before = host.snapshot();
    const frame = host.state.project.currentFrame;
    const outcome = change(layer, frame, host.state.project);
    if (outcome === false) return;
    host.recordHistory(before);
    host.markDirty();
    host.afterChange({ timeline: true });
    host.setStatus(label);
  };
  $("f8InsertKeyframe")?.addEventListener("click", run("Keyframe inserted (F6)", (l, f) => insertKeyframe(l, f)));
  $("f8InsertBlankKeyframe")?.addEventListener("click", run("Blank keyframe inserted (F7)", (l, f) => insertBlankKeyframe(l, f)));
  $("f8ClearKeyframe")?.addEventListener("click", run("Keyframe cleared (Shift+F6)", (l, f) => clearKeyframe(l, f)));
  $("f8InsertFrameSpan")?.addEventListener("click", run("Frame inserted (F5)", (l, f, p) => insertFrameSpan(p, f)));
  $("f8RemoveFrameSpan")?.addEventListener("click", run("Frame removed (Shift+F5)", (l, f, p) => removeFrameSpan(p, f)));
}

/** Menu actions that open Flash 8 dialogs. Returns true when handled. */
export function handleAction(action) {
  if (action === "drawingSettings") {
    openAssistant();
    return true;
  }
  if (action === "optimizeCurves") {
    show("optimizeCurvesModal", true);
    return true;
  }
  return false;
}

/**
 * Wire the controls. `host` is what `app.js` offers: `state`, `snapshot`,
 * `recordHistory`, `markDirty`, `afterChange`, `setStatus`, `currentLayer`
 * and `currentDrawing`.
 */
export function init(host) {
  load();
  bindSelect("f8PencilMode", "pencilMode");
  bindSelect("f8BrushPaintMode", "paintMode");
  bindSelect("f8BrushShape", "brushShape");
  bindSelect("f8GapSize", "gap");
  bindSelect("f8EraserMode", "eraserMode");
  bindNumber("f8BrushSmoothing", "brushSmoothness", 0, 100);
  bindCheckbox("f8LockFill", "lockFill");
  bindCheckbox("f8FillLockFill", "lockFill");
  bindToggle("f8FaucetBtn", "faucet");
  bindToggle("f8SnapGridBtn", "snapGrid");
  bindToggle("f8SnapObjectsBtn", "snapObjects");
  $("f8BrushSize")?.addEventListener("change", (event) => {
    const width = Number(event.target.value);
    const target = host.state.toolSettings.brush;
    target.width = width;
    host.onBrushSize?.(width);
  });
  bindAssistant(host);
  bindOptimize(host);
  bindKeyframes(host);
  syncTool(host.state.tool);
}
