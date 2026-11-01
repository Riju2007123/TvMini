/**
 * Shell chrome: panel visibility, the Window menu, the timeline resize grip,
 * the panels that float and the document tab.
 *
 * This file owns layout only. It never touches the project model; actions that
 * belong to the editor are forwarded to the existing File-menu buttons, which
 * is where app.js binds them.
 */

import {
  MAX_COLUMN,
  MIN_FLOAT,
  MIN_LAYERS,
  MIN_LEFT,
  MIN_RIGHT,
  clampBox,
  clampWidth,
  draggedHeight,
  isDocked,
  resizeBox,
  windowRows,
  workspaceColumns,
} from "./core/layout.js";

const STORAGE_KEY = "tvmini.shell.v2";
const PANES = ["tools", "stage", "layers", "inspector", "timeline"];
// The timeline is the thinnest part of the window: its header, its toolbar
// and a handful of rows of frames fit in this height.
const DEFAULT_HEIGHT = 164;
const MIN_HEIGHT = 84;
// The width of the column of the tool property panel and of the column of the
// layers and the inspector.
const DEFAULT_LEFT = 196;
const DEFAULT_RIGHT = 232;
// The handles of a panel that floats.
const HANDLES = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** The state of a panel that has never been moved. */
function blankPane() {
  return { floating: false, x: 40, y: 60, width: 260, height: 360 };
}

/** Read the state of the panels out of what was saved. */
function readPanes(saved) {
  const panes = {};
  for (const name of PANES) {
    const pane = saved?.[name] ?? {};
    panes[name] = {
      floating: Boolean(pane.floating),
      x: Number.isFinite(pane.x) ? pane.x : blankPane().x,
      y: Number.isFinite(pane.y) ? pane.y : blankPane().y,
      width: Number.isFinite(pane.width) ? pane.width : blankPane().width,
      height: Number.isFinite(pane.height) ? pane.height : blankPane().height,
    };
  }
  return panes;
}

function readState() {
  const fallback = {
    hidden: [],
    timelineHeight: DEFAULT_HEIGHT,
    leftWidth: DEFAULT_LEFT,
    rightWidth: DEFAULT_RIGHT,
    layersHeight: null,
    panes: readPanes(null),
  };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      hidden: Array.isArray(raw.hidden)
        ? raw.hidden.filter((pane) => PANES.includes(pane))
        : [],
      timelineHeight: Number.isFinite(raw.timelineHeight)
        ? raw.timelineHeight
        : DEFAULT_HEIGHT,
      leftWidth: Number.isFinite(raw.leftWidth) ? raw.leftWidth : DEFAULT_LEFT,
      rightWidth: Number.isFinite(raw.rightWidth) ? raw.rightWidth : DEFAULT_RIGHT,
      layersHeight: Number.isFinite(raw.layersHeight) ? raw.layersHeight : null,
      panes: readPanes(raw.panes),
    };
  } catch {
    return fallback;
  }
}

let state = readState();

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage disabled — the layout simply does not persist */
  }
}

function isVisible(pane) {
  return !state.hidden.includes(pane);
}

/**
 * Tell the editor that the window has changed shape, so the stage can follow
 * the panel it sits in.
 */
function announceLayout() {
  window.dispatchEvent(new Event("tvmini:layout"));
}

function applyPanes() {
  for (const pane of PANES) {
    document.body.classList.toggle(`hide-${pane}`, !isVisible(pane));
  }
  document.documentElement.style.setProperty(
    "--timeline-h",
    `${state.timelineHeight}px`,
  );

  for (const button of document.querySelectorAll("[data-pane-toggle]")) {
    const pane = button.dataset.paneToggle;
    const visible = isVisible(pane);
    if (button.getAttribute("role") === "menuitemcheckbox") {
      button.setAttribute("aria-checked", String(visible));
    } else {
      button.title = `Hide the ${pane} panel`;
      button.setAttribute("aria-label", `Hide the ${pane} panel`);
    }
  }
}

function togglePane(pane) {
  if (!PANES.includes(pane)) return;
  const next = state.hidden.includes(pane)
    ? state.hidden.filter((entry) => entry !== pane)
    : [...state.hidden, pane];

  // Never leave the window with nothing in it.
  state.hidden = next.length === PANES.length ? next.slice(1) : next;
  saveState();
  applyLayout();
  announceLayout();
}

/* window menu ------------------------------------------------------------ */

const windowButton = document.getElementById("windowButton");
const windowMenu = document.getElementById("windowMenu");
const fileMenu = document.getElementById("fileMenu");
const fileButton = document.getElementById("fileButton");
const helpMenu = document.getElementById("helpMenu");
const helpButton = document.getElementById("helpButton");

function setMenu(button, menu, open) {
  if (!button || !menu) return;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeWindowMenu() {
  setMenu(windowButton, windowMenu, false);
}

windowButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = windowMenu.hidden;
  setMenu(fileButton, fileMenu, false);
  setMenu(helpButton, helpMenu, false);
  setMenu(windowButton, windowMenu, open);
});

document.addEventListener("click", (event) => {
  if (!windowMenu || windowMenu.hidden) return;
  if (windowMenu.contains(event.target) || event.target === windowButton) return;
  closeWindowMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeWindowMenu();
});

windowMenu?.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-pane-toggle]");
  if (toggle) {
    togglePane(toggle.dataset.paneToggle);
    return;
  }
  const action = event.target.closest("[data-shell-action]");
  if (action) closeWindowMenu();
});

/* forwarded actions ------------------------------------------------------ */

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-shell-action]");
  if (!button) return;

  if (button.dataset.shellAction === "resetLayout") {
    // The panels that float are put back first: after that the state can be
    // thrown away and read again from the beginning.
    for (const name of PANES) dockPane(paneElement(name));
    state = {
      hidden: [],
      timelineHeight: DEFAULT_HEIGHT,
      leftWidth: DEFAULT_LEFT,
      rightWidth: DEFAULT_RIGHT,
      layersHeight: null,
      panes: readPanes(null),
    };
    saveState();
    applyLayout();
    announceLayout();
    return;
  }

  const source = document.querySelector(
    `#fileMenu [data-action="${button.dataset.shellAction}"]`,
  );
  source?.click();
});

/* header collapse buttons ------------------------------------------------ */

for (const button of document.querySelectorAll(".pane-header [data-pane-toggle]")) {
  button.addEventListener("click", () => togglePane(button.dataset.paneToggle));
}

/* timeline grip ---------------------------------------------------------- */

const grip = document.getElementById("timelineGrip");
let timelineDrag = null;

grip?.addEventListener("pointerdown", (event) => {
  timelineDrag = { y: event.clientY, height: state.timelineHeight, id: event.pointerId };
  try {
    grip.setPointerCapture(event.pointerId);
  } catch {
    /* a pointer that is not really down cannot be held */
  }
  grip.classList.add("dragging");
  event.preventDefault();
});

function endTimelineDrag(event) {
  if (!timelineDrag || event.pointerId !== timelineDrag.id) return;
  timelineDrag = null;
  grip.classList.remove("dragging");
  saveState();
  announceLayout();
}

grip?.addEventListener("pointerup", endTimelineDrag);
grip?.addEventListener("pointercancel", endTimelineDrag);

grip?.addEventListener("dblclick", () => {
  state.timelineHeight = DEFAULT_HEIGHT;
  saveState();
  applyLayout();
  announceLayout();
});

/* the panels that float -------------------------------------------------- */

/**
 * The layer the handles of the panels that float live in. It is a fixed box
 * over the whole window, so a panel can be put anywhere in it.
 */
const floatLayer = document.createElement("div");
floatLayer.id = "floatLayer";
document.body.appendChild(floatLayer);

/** The frame that holds the handles of a panel that floats. */
function frameOf(name) {
  return floatLayer.querySelector(`.pane-float[data-float-pane="${name}"]`);
}

function paneElement(name) {
  return document.querySelector(`.pane[data-pane="${name}"]`);
}

/**
 * Put a panel where it belongs and make it the size it should be.
 *
 * The panel keeps its place in the window and is only put over it, so the
 * panels around it stay where they are.
 */
function setPaneBox(pane, box) {
  pane.style.left = `${box.x}px`;
  pane.style.top = `${box.y}px`;
  pane.style.width = `${box.width}px`;
  pane.style.height = `${box.height}px`;
  const frame = frameOf(pane.dataset.pane);
  if (!frame) return;
  frame.style.left = `${box.x}px`;
  frame.style.top = `${box.y}px`;
  frame.style.width = `${box.width}px`;
  frame.style.height = `${box.height}px`;
}

/**
 * Pull a panel out of the window.
 *
 * The panel keeps the size it had and comes under the pointer where it was
 * taken from, so nothing jumps when the pointer moves.
 *
 * @param {Element} pane The panel.
 * @param {object} box Where the panel comes, and how big it is.
 * @param {boolean} force Pull it out even when the state says it floats.
 * @returns {Element|null} The frame that holds the handles of the panel.
 */
function floatPane(pane, box, force = false) {
  if (!pane) return null;
  const name = pane.dataset.pane;
  const info = state.panes[name];
  if (info.floating && !force) return null;

  const frame = document.createElement("div");
  frame.className = "pane-float";
  // The frame is named apart from the panel it belongs to, so that the
  // panel is still the one that is found when the window is put together.
  frame.dataset.floatPane = name;

  for (const dir of HANDLES) {
    const handle = document.createElement("div");
    handle.className = `pane-handle pane-handle-${dir}`;
    handle.dataset.handle = dir;
    frame.appendChild(handle);
  }
  floatLayer.appendChild(frame);

  pane.classList.add("floating");
  pane.style.position = "fixed";
  // The panel floats above the other panels, and below the windows that are
  // opened over the app.
  pane.style.zIndex = "35";
  setPaneBox(pane, box);

  info.floating = true;
  info.x = box.x;
  info.y = box.y;
  info.width = box.width;
  info.height = box.height;
  return frame;
}

/**
 * Put a panel back in the place it came from.
 *
 * @param {Element} pane The panel.
 */
function dockPane(pane) {
  if (!pane) return;
  const name = pane.dataset.pane;
  const info = state.panes[name];
  if (!info.floating) return;
  pane.classList.remove("floating");
  pane.style.position = "";
  pane.style.zIndex = "";
  pane.style.left = "";
  pane.style.top = "";
  pane.style.width = "";
  pane.style.height = "";
  frameOf(name)?.remove();
  info.floating = false;
}

/* the heads of the panels are the handles that move them ------------------ */

let paneDrag = null;
let resizeDrag = null;

/** The two buttons of a panel that float and of a panel that does not. */
const FLOAT_BUTTONS = new Map();
const DOCK_BUTTONS = new Map();

/**
 * The button that takes a panel out of the window.
 *
 * The panel keeps the place and the size it has, so it does not jump
 * anywhere when it is taken out: it is the same window, only loose.
 */
function makeFloatButton(pane) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn pane-float-btn";
  button.title = "Take the panel out of the window";
  button.setAttribute("aria-label", "Take the panel out of the window");
  button.innerHTML =
    '<svg class="tli" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10.5V3.5" /><path d="M5 6.5 8 3.5l3 3" /><path d="M3.5 13h9" /></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = pane.getBoundingClientRect();
    floatPane(pane, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    applyLayout();
    saveState();
    announceLayout();
  });
  return button;
}

/** The button that puts a panel back in its place. */
function makeDockButton(pane) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn pane-dock";
  button.title = "Put the panel back in its place";
  button.setAttribute("aria-label", "Put the panel back in its place");
  button.innerHTML =
    '<svg class="tli" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5 8 11l4.5-4.5" /><path d="M3 12.5h10" /></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    dockPane(pane);
    applyLayout();
    saveState();
    announceLayout();
  });
  return button;
}

for (const pane of document.querySelectorAll(".pane[data-pane]")) {
  const header = pane.querySelector(".pane-header");
  if (!header) continue;

  const floatButton = makeFloatButton(pane);
  const dockButton = makeDockButton(pane);
  // The two buttons sit next to the name of the panel.
  const title = header.querySelector(".pane-title");
  if (title) title.after(floatButton, dockButton);
  else header.prepend(floatButton, dockButton);
  FLOAT_BUTTONS.set(pane.dataset.pane, floatButton);
  DOCK_BUTTONS.set(pane.dataset.pane, dockButton);

  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // A button in the head of a panel is a button, not a handle.
    if (event.target.closest("button, input, select, a, label")) return;
    paneDrag = {
      pane,
      name: pane.dataset.pane,
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: 0,
      grabY: 0,
      moved: false,
    };
  });

  header.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, input, select, a, label")) return;
    const name = pane.dataset.pane;
    if (state.panes[name].floating) {
      dockPane(pane);
    } else {
      const rect = pane.getBoundingClientRect();
      floatPane(pane, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    applyLayout();
    saveState();
    announceLayout();
  });
}

/* the handles of a panel that floats -------------------------------------- */

floatLayer.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest?.("[data-handle]");
  if (!handle) return;
  event.preventDefault();
  event.stopPropagation();
  const frame = handle.closest(".pane-float");
  const name = frame.dataset.floatPane;
  const info = state.panes[name];
  resizeDrag = {
    pane: paneElement(name),
    name,
    handle: handle.dataset.handle,
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    box: { x: info.x, y: info.y, width: info.width, height: info.height },
  };
  document.body.classList.add("pane-dragging");
});

/* the grips between the panels that stay in the window -------------------- */

const workspace = document.querySelector(".workspace");
const rightColumn = document.querySelector(".right-column");
const layersPane = paneElement("layers");
const inspectorPane = paneElement("inspector");

function makeGrip(id, title, orientation) {
  const element = document.createElement("div");
  element.id = id;
  element.className = `pane-grip pane-grip-${orientation}`;
  element.setAttribute("role", "separator");
  element.setAttribute("aria-orientation", orientation === "v" ? "vertical" : "horizontal");
  element.title = title;
  return element;
}

const leftGrip = makeGrip("leftGrip", "Resize the tool property panel", "v");
const rightGrip = makeGrip("rightGrip", "Resize the layers and the inspector", "v");
const layersGrip = makeGrip("layersGrip", "Resize the layers panel", "h");

workspace?.append(leftGrip, rightGrip);
if (rightColumn && inspectorPane) rightColumn.insertBefore(layersGrip, inspectorPane);

let columnDrag = null;
let layersDrag = null;

/**
 * Hold on to the pointer that is dragging a grip.
 *
 * The capture is a comfort, not a necessity: the drag is watched on the
 * window, so a pointer that cannot be captured still moves the panel.
 */
function holdPointer(element, id) {
  try {
    element.setPointerCapture(id);
  } catch {
    /* a pointer that is not really down (a synthetic event) cannot be held */
  }
}

leftGrip.addEventListener("pointerdown", (event) => {
  columnDrag = { which: "left", x: event.clientX, width: state.leftWidth, id: event.pointerId };
  holdPointer(leftGrip, event.pointerId);
  leftGrip.classList.add("dragging");
  event.preventDefault();
});

rightGrip.addEventListener("pointerdown", (event) => {
  columnDrag = { which: "right", x: event.clientX, width: state.rightWidth, id: event.pointerId };
  holdPointer(rightGrip, event.pointerId);
  rightGrip.classList.add("dragging");
  event.preventDefault();
});

layersGrip.addEventListener("pointerdown", (event) => {
  const height = state.layersHeight ?? layersPane?.getBoundingClientRect().height ?? MIN_LAYERS;
  layersDrag = { y: event.clientY, height, id: event.pointerId };
  holdPointer(layersGrip, event.pointerId);
  layersGrip.classList.add("dragging");
  event.preventDefault();
});

function endColumnDrag(event) {
  if (!columnDrag || event.pointerId !== columnDrag.id) return;
  columnDrag = null;
  leftGrip.classList.remove("dragging");
  rightGrip.classList.remove("dragging");
  saveState();
  announceLayout();
}

function endLayersDrag(event) {
  if (!layersDrag || event.pointerId !== layersDrag.id) return;
  layersDrag = null;
  layersGrip.classList.remove("dragging");
  saveState();
  announceLayout();
}

/* the pointer moves the panel, or makes it bigger ----------------------- */

window.addEventListener("pointermove", (event) => {
  if (paneDrag && event.pointerId === paneDrag.id) {
    const dx = event.clientX - paneDrag.startX;
    const dy = event.clientY - paneDrag.startY;
    if (!paneDrag.moved) {
      // A click in the head of a panel is not a drag.
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      paneDrag.moved = true;
      document.body.classList.add("pane-dragging");
      const pane = paneDrag.pane;
      const rect = pane.getBoundingClientRect();
      paneDrag.grabX = paneDrag.startX - rect.left;
      paneDrag.grabY = paneDrag.startY - rect.top;
      floatPane(pane, {
        x: rect.left + dx,
        y: rect.top + dy,
        width: rect.width,
        height: rect.height,
      });
      applyLayout();
      announceLayout();
    }
    const info = state.panes[paneDrag.name];
    if (!info.floating) return;
    const box = clampBox(
      {
        x: event.clientX - paneDrag.grabX,
        y: event.clientY - paneDrag.grabY,
        width: info.width,
        height: info.height,
      },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPaneBox(paneDrag.pane, box);
    info.x = box.x;
    info.y = box.y;
    return;
  }

  if (resizeDrag && event.pointerId === resizeDrag.id) {
    const box = resizeBox(
      resizeDrag.box,
      resizeDrag.handle,
      event.clientX - resizeDrag.startX,
      event.clientY - resizeDrag.startY,
      { min: MIN_FLOAT },
    );
    setPaneBox(resizeDrag.pane, box);
    const info = state.panes[resizeDrag.name];
    info.x = box.x;
    info.y = box.y;
    info.width = box.width;
    info.height = box.height;
    return;
  }

  if (columnDrag && event.pointerId === columnDrag.id) {
    if (columnDrag.which === "left") {
      // The column of the tool property panel is on the left, so the grip
      // grows it when it goes to the right.
      state.leftWidth = clampWidth(
        columnDrag.width + (event.clientX - columnDrag.x),
        MIN_LEFT,
        MAX_COLUMN,
      );
    } else {
      // The column of the layers is on the right, so the grip grows it when
      // it goes to the left.
      state.rightWidth = clampWidth(
        columnDrag.width - (event.clientX - columnDrag.x),
        MIN_RIGHT,
        MAX_COLUMN,
      );
    }
    applyLayout();
    return;
  }

  if (layersDrag && event.pointerId === layersDrag.id) {
    const max = Math.max(MIN_LAYERS, Math.round(window.innerHeight * 0.6));
    // The grip is on the bottom edge of the layers, so pulling it down gives
    // them more room.
    state.layersHeight = draggedHeight(
      layersDrag.height,
      event.clientY - layersDrag.y,
      "bottom",
      { min: MIN_LAYERS, max },
    );
    applyLayout();
    return;
  }

  if (timelineDrag && event.pointerId === timelineDrag.id) {
    const max = Math.max(MIN_HEIGHT, window.innerHeight - 240);
    // The grip is on the top edge of the timeline, so pulling it up makes
    // the timeline taller and pulling it down makes it shorter.
    state.timelineHeight = draggedHeight(
      timelineDrag.height,
      event.clientY - timelineDrag.y,
      "top",
      { min: MIN_HEIGHT, max },
    );
    applyLayout();
  }
});

window.addEventListener("pointerup", (event) => {
  if (paneDrag && event.pointerId === paneDrag.id) {
    if (paneDrag.moved) saveState();
    paneDrag = null;
    document.body.classList.remove("pane-dragging");
  }
  if (resizeDrag && event.pointerId === resizeDrag.id) {
    resizeDrag = null;
    document.body.classList.remove("pane-dragging");
    saveState();
    announceLayout();
  }
  if (columnDrag && event.pointerId === columnDrag.id) endColumnDrag(event);
  if (layersDrag && event.pointerId === layersDrag.id) endLayersDrag(event);
  if (timelineDrag && event.pointerId === timelineDrag.id) endTimelineDrag(event);
});

window.addEventListener("pointercancel", (event) => {
  if (paneDrag && event.pointerId === paneDrag.id) {
    paneDrag = null;
    document.body.classList.remove("pane-dragging");
  }
  if (resizeDrag && event.pointerId === resizeDrag.id) {
    resizeDrag = null;
    document.body.classList.remove("pane-dragging");
  }
  if (columnDrag && event.pointerId === columnDrag.id) endColumnDrag(event);
  if (layersDrag && event.pointerId === layersDrag.id) endLayersDrag(event);
  if (timelineDrag && event.pointerId === timelineDrag.id) endTimelineDrag(event);
});

/* the layout of the window ------------------------------------------------ */

function applyLayout() {
  applyPanes();

  const root = document.documentElement;
  root.style.setProperty("--left-w", `${state.leftWidth}px`);
  root.style.setProperty("--right-w", `${state.rightWidth}px`);
  if (state.layersHeight) root.style.setProperty("--layers-h", `${state.layersHeight}px`);
  else root.style.removeProperty("--layers-h");

  // A panel that floats takes no room in the window, so the columns of the
  // workspace and the rows of the window are worked out again.
  const floating = PANES.some((name) => state.panes[name].floating);
  if (floating) {
    if (workspace) workspace.style.gridTemplateColumns = workspaceColumns(state).join(" ");
    document.body.style.gridTemplateRows = windowRows(state).join(" ");
  } else {
    if (workspace) workspace.style.gridTemplateColumns = "";
    document.body.style.gridTemplateRows = "";
  }

  // The grips follow the panels they belong to.
  leftGrip.style.display = isDocked(state, "tools") ? "" : "none";
  rightGrip.style.display =
    isDocked(state, "layers") || isDocked(state, "inspector") ? "" : "none";
  layersGrip.style.display = isDocked(state, "layers") ? "" : "none";

  // The button that takes a panel out is only there while it is in place,
  // and the button that puts it back only while it floats.
  for (const [name, button] of FLOAT_BUTTONS) {
    button.style.display = state.panes[name].floating ? "none" : "";
  }
  for (const [name, button] of DOCK_BUTTONS) {
    button.style.display = state.panes[name].floating ? "" : "none";
  }

  // A panel that is hidden takes its float with it.
  for (const name of PANES) {
    const frame = floatLayer.querySelector(`.pane-float[data-float-pane="${name}"]`);
    if (frame) frame.style.display = isVisible(name) ? "" : "none";
  }
}

/** Put back the panels that were floating when the window was closed. */
function restoreFloaters() {
  for (const name of PANES) {
    if (!state.panes[name].floating) continue;
    const pane = paneElement(name);
    if (!pane) continue;
    const info = state.panes[name];
    floatPane(pane, { x: info.x, y: info.y, width: info.width, height: info.height }, true);
  }
}

/* document tab ----------------------------------------------------------- */

const tabName = document.getElementById("docTabName");

function syncTab() {
  if (!tabName) return;
  const name = document.title.replace(/\s+—\s+TVMini$/, "").trim();
  tabName.textContent = name || "Untitled";
}

const titleEl = document.querySelector("title");
const pathEl = document.getElementById("pathLabel");
const tabObserver = new MutationObserver(syncTab);
if (titleEl) tabObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
if (pathEl) tabObserver.observe(pathEl, { childList: true, characterData: true, subtree: true });
syncTab();

applyPanes();
restoreFloaters();
applyLayout();
