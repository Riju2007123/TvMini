/**
 * The maths of the layout of the window: which column a panel takes, how big
 * it is, and where it sits when it is pulled out of the window.
 *
 * The shell owns the behaviour; this file owns the numbers, so they can be
 * measured without a browser.
 */

/** The panels of the window. */
export const PANES = ["tools", "stage", "layers", "inspector", "timeline"];

/** The smallest a column of the window may be. */
export const MIN_LEFT = 150;
export const MIN_RIGHT = 170;
export const MAX_COLUMN = 520;

/** The smallest a panel that is pulled out of the window may be. */
export const MIN_FLOAT = { width: 190, height: 110 };

/** The smallest the panel of the layers may be. */
export const MIN_LAYERS = 80;

/**
 * Is a panel in its place in the window?
 *
 * A panel that is hidden is not in its place, and a panel that floats is not
 * either: it is on top of the window and takes no room in it.
 *
 * @param {object} state The layout of the window.
 * @param {string} pane The name of the panel.
 * @returns {boolean} True when the panel sits in the window.
 */
export function isDocked(state, pane) {
  const hidden = Array.isArray(state?.hidden) ? state.hidden : [];
  const floating = Boolean(state?.panes?.[pane]?.floating);
  return !hidden.includes(pane) && !floating;
}

/**
 * The columns of the workspace.
 *
 * A panel that floats takes no room in the window, so the column it used to
 * hold is gone and the others move into it.
 *
 * @param {object} state The layout of the window.
 * @returns {Array<string>} The columns, as they are written in the grid.
 */
export function workspaceColumns(state) {
  const columns = [];
  if (isDocked(state, "tools")) columns.push("var(--left-w)");
  if (isDocked(state, "stage")) columns.push("minmax(0, 1fr)");
  if (isDocked(state, "layers") || isDocked(state, "inspector")) {
    columns.push("var(--right-w)");
  }
  return columns;
}

/**
 * The rows of the window.
 *
 * The timeline sits in a row of its own, and the grip above it in a row of
 * its own. A timeline that floats takes neither.
 *
 * @param {object} state The layout of the window.
 * @returns {Array<string>} The rows, as they are written in the grid.
 */
export function windowRows(state) {
  const timeline = isDocked(state, "timeline");
  return [
    "var(--topbar-h)",
    "var(--tabstrip-h)",
    "minmax(0, 1fr)",
    timeline ? "5px" : "0",
    timeline ? "var(--timeline-h)" : "0",
    "24px",
  ];
}

/**
 * The height of a panel whose edge is dragged.
 *
 * The grip on the **bottom** edge of a panel is pulled down to make the
 * panel taller, and the grip on the **top** edge is pulled up for the same
 * reason: the panel grows away from the edge the grip is on. A grip that
 * is on the top edge of the timeline therefore makes the timeline shorter
 * when it is pulled down.
 *
 * @param {number} height The height of the panel before the drag.
 * @param {number} delta How far the pointer went down.
 * @param {string} edge The edge the grip is on: "top" or "bottom".
 * @param {object} limits The smallest and the largest the panel may be.
 * @returns {number} The height of the panel, in whole pixels.
 */
export function draggedHeight(height, delta, edge, limits = {}) {
  const min = limits.min ?? 0;
  const max = limits.max ?? Infinity;
  const next = edge === "bottom" ? height + delta : height - delta;
  return Math.round(Math.min(Math.max(next, min), max));
}

/**
 * The size of a column of the window, kept between its limits.
 *
 * @param {number} value The size that was asked for.
 * @param {number} min The smallest the column may be.
 * @param {number} max The largest the column may be.
 * @returns {number} The size of the column, in whole pixels.
 */
export function clampWidth(value, min, max) {
  const width = Number.isFinite(value) ? value : min;
  return Math.round(Math.min(Math.max(width, min), max));
}

/**
 * A box that stays within reach of the window.
 *
 * A panel goes where it is put, so it may hang over the edge of the window.
 * It may not hang so far that it cannot be grabbed again, so a strip of it
 * is always left on the screen.
 *
 * @param {object} box The box of the panel.
 * @param {object} viewport The size of the window.
 * @param {number} keep How much of the panel must stay on the screen.
 * @returns {object} The box, within reach of the window.
 */
export function clampBox(box, viewport, keep = 120) {
  const width = Math.min(box.width, Math.max(0, viewport.width));
  const height = Math.min(box.height, Math.max(0, viewport.height));
  return {
    x: Math.round(Math.min(Math.max(box.x, keep - width), viewport.width - keep)),
    y: Math.round(Math.min(Math.max(box.y, keep - height), viewport.height - keep)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * The box after a handle of a floating panel is dragged.
 *
 * The handle on the right makes the panel wider, the handle on the left makes
 * it wider the other way and moves its left edge with it, and the handles in
 * the corners do both at once.
 *
 * @param {object} box The box of the panel.
 * @param {string} handle The handle that is dragged.
 * @param {number} dx How far the pointer went to the right.
 * @param {number} dy How far the pointer went down.
 * @param {object} limits The smallest the panel may be.
 * @returns {object} The box after the drag.
 */
export function resizeBox(box, handle, dx, dy, limits = {}) {
  const min = limits.min ?? MIN_FLOAT;
  let { x, y, width, height } = box;

  if (handle.includes("e")) width = Math.max(min.width, width + dx);
  if (handle.includes("s")) height = Math.max(min.height, height + dy);
  if (handle.includes("w")) {
    const next = Math.max(min.width, width - dx);
    x += width - next;
    width = next;
  }
  if (handle.includes("n")) {
    const next = Math.max(min.height, height - dy);
    y += height - next;
    height = next;
  }

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
