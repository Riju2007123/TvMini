/**
 * Shell chrome: panel visibility, the Window menu, the timeline resize grip
 * and the document tab.
 *
 * This file owns layout only. It never touches the project model; actions that
 * belong to the editor are forwarded to the existing File-menu buttons, which
 * is where app.js binds them.
 */

const STORAGE_KEY = "tvmini.shell.v1";
const PANES = ["tools", "stage", "inspector", "timeline"];
const DEFAULT_HEIGHT = 184;
const MIN_HEIGHT = 110;

function readState() {
  const fallback = { hidden: [], timelineHeight: DEFAULT_HEIGHT };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      hidden: Array.isArray(raw.hidden)
        ? raw.hidden.filter((pane) => PANES.includes(pane))
        : [],
      timelineHeight: Number.isFinite(raw.timelineHeight)
        ? raw.timelineHeight
        : DEFAULT_HEIGHT,
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
  applyPanes();
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
    state = { hidden: [], timelineHeight: DEFAULT_HEIGHT };
    saveState();
    applyPanes();
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
let drag = null;

grip?.addEventListener("pointerdown", (event) => {
  drag = { y: event.clientY, height: state.timelineHeight, id: event.pointerId };
  grip.setPointerCapture(event.pointerId);
  grip.classList.add("dragging");
  event.preventDefault();
});

grip?.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  const max = Math.max(MIN_HEIGHT, window.innerHeight - 240);
  const height = Math.round(
    Math.min(Math.max(drag.height - (event.clientY - drag.y), MIN_HEIGHT), max),
  );
  state.timelineHeight = height;
  applyPanes();
});

function endDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  drag = null;
  grip.classList.remove("dragging");
  saveState();
}

grip?.addEventListener("pointerup", endDrag);
grip?.addEventListener("pointercancel", endDrag);

grip?.addEventListener("dblclick", () => {
  state.timelineHeight = DEFAULT_HEIGHT;
  saveState();
  applyPanes();
});

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
