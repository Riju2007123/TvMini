import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COLUMN,
  MIN_FLOAT,
  MIN_LEFT,
  MIN_RIGHT,
  clampBox,
  clampWidth,
  draggedHeight,
  isDocked,
  resizeBox,
  windowRows,
  workspaceColumns,
} from "../public/core/layout.js";

/** A layout with nothing hidden and nothing floating. */
function layout(overrides = {}) {
  return {
    hidden: [],
    panes: {
      tools: { floating: false },
      stage: { floating: false },
      layers: { floating: false },
      inspector: { floating: false },
      timeline: { floating: false },
    },
    ...overrides,
  };
}

test("a panel that is hidden or that floats is not in its place", () => {
  const state = layout();
  assert.equal(isDocked(state, "tools"), true);

  const hidden = layout({ hidden: ["tools"] });
  assert.equal(isDocked(hidden, "tools"), false);

  const floating = layout();
  floating.panes.tools.floating = true;
  assert.equal(isDocked(floating, "tools"), false);
});

test("the workspace has a column for every panel that stays in it", () => {
  assert.deepEqual(workspaceColumns(layout()), [
    "var(--left-w)",
    "minmax(0, 1fr)",
    "var(--right-w)",
  ]);

  // The tool property panel is hidden: the stage takes its place.
  assert.deepEqual(workspaceColumns(layout({ hidden: ["tools"] })), [
    "minmax(0, 1fr)",
    "var(--right-w)",
  ]);
});

test("a panel that floats takes no room in the window", () => {
  const state = layout();
  state.panes.tools.floating = true;
  assert.deepEqual(workspaceColumns(state), ["minmax(0, 1fr)", "var(--right-w)"]);

  const stage = layout();
  stage.panes.stage.floating = true;
  assert.deepEqual(workspaceColumns(stage), ["var(--left-w)", "var(--right-w)"]);

  // Both the layers and the inspector float: the column on the right is gone.
  const right = layout();
  right.panes.layers.floating = true;
  right.panes.inspector.floating = true;
  assert.deepEqual(workspaceColumns(right), ["var(--left-w)", "minmax(0, 1fr)"]);
});

test("the timeline keeps its row and its grip, unless it floats", () => {
  const rows = windowRows(layout());
  assert.equal(rows[3], "5px");
  assert.equal(rows[4], "var(--timeline-h)");

  const floating = layout();
  floating.panes.timeline.floating = true;
  const gone = windowRows(floating);
  assert.equal(gone[3], "0");
  assert.equal(gone[4], "0");

  const hidden = layout({ hidden: ["timeline"] });
  assert.equal(windowRows(hidden)[4], "0");
});

test("a column of the window keeps its size between its limits", () => {
  assert.equal(clampWidth(200, MIN_LEFT, MAX_COLUMN), 200);
  assert.equal(clampWidth(10, MIN_LEFT, MAX_COLUMN), MIN_LEFT);
  assert.equal(clampWidth(5000, MIN_LEFT, MAX_COLUMN), MAX_COLUMN);
  assert.equal(clampWidth(NaN, MIN_LEFT, MAX_COLUMN), MIN_LEFT);
  assert.equal(clampWidth(200.6, MIN_LEFT, MAX_COLUMN), 201);
});

test("a panel that is dragged goes where it is put", () => {
  const viewport = { width: 1000, height: 700 };
  // It may hang over the edge of the window: it is put where it is put, as
  // long as a strip of it stays on the screen.
  const box = clampBox({ x: 860, y: 560, width: 200, height: 300 }, viewport);
  assert.equal(box.x, 860);
  assert.equal(box.y, 560);

  // A strip of it must stay on the screen, or it could not be grabbed again.
  const off = clampBox({ x: -5000, y: -5000, width: 200, height: 300 }, viewport);
  assert.equal(off.x, 120 - 200);
  assert.equal(off.y, 120 - 300);

  const far = clampBox({ x: 5000, y: 5000, width: 200, height: 300 }, viewport);
  assert.equal(far.x, 1000 - 120);
  assert.equal(far.y, 700 - 120);

  // A panel that is bigger than the window is measured against the window.
  const big = clampBox({ x: 40, y: 40, width: 2000, height: 2000 }, viewport);
  assert.equal(big.width, 1000);
  assert.equal(big.height, 700);
});

test("the grip on the top edge of the timeline makes it taller when it goes up", () => {
  // The grip sits on the top edge of the timeline, so pulling it up gives
  // the timeline more room and pulling it down takes room away from it.
  const up = draggedHeight(164, -40, "top", { min: 84, max: 600 });
  assert.equal(up, 204);

  const down = draggedHeight(164, 40, "top", { min: 84, max: 600 });
  assert.equal(down, 124);
});

test("the grip on the bottom edge of the layers makes them taller when it goes down", () => {
  const down = draggedHeight(120, 40, "bottom", { min: 80, max: 600 });
  assert.equal(down, 160);

  const up = draggedHeight(120, -40, "bottom", { min: 80, max: 600 });
  assert.equal(up, 80);
});

test("a panel that is dragged keeps the size it may have", () => {
  // The timeline may not get smaller than its header and a row of frames,
  // and it may not take the whole window.
  assert.equal(draggedHeight(90, 40, "top", { min: 84, max: 600 }), 84);
  assert.equal(draggedHeight(600, -40, "top", { min: 84, max: 600 }), 600);
});

test("the handle on the right makes a floating panel wider", () => {
  const box = { x: 10, y: 20, width: 200, height: 300 };
  const grown = resizeBox(box, "e", 50, 0, { min: MIN_FLOAT });
  assert.deepEqual(grown, { x: 10, y: 20, width: 250, height: 300 });
});

test("the handle on the left makes it wider the other way", () => {
  const box = { x: 10, y: 20, width: 200, height: 300 };
  // The handle goes to the left, so the panel grows to the left and its
  // left edge moves with it.
  const grown = resizeBox(box, "w", -50, 0, { min: MIN_FLOAT });
  assert.deepEqual(grown, { x: -40, y: 20, width: 250, height: 300 });

  // The handle goes to the right, so the panel gets smaller.
  const shrunk = resizeBox(box, "w", 50, 0, { min: MIN_FLOAT });
  assert.equal(shrunk.width, 190);
  assert.equal(shrunk.x, 20);
});

test("the handles on the top and the bottom change the height", () => {
  const box = { x: 10, y: 20, width: 200, height: 300 };
  assert.deepEqual(resizeBox(box, "s", 0, 40, { min: MIN_FLOAT }), {
    x: 10,
    y: 20,
    width: 200,
    height: 340,
  });
  assert.deepEqual(resizeBox(box, "n", 0, -40, { min: MIN_FLOAT }), {
    x: 10,
    y: -20,
    width: 200,
    height: 340,
  });
});

test("the handle in a corner does both at once", () => {
  const box = { x: 10, y: 20, width: 200, height: 300 };
  assert.deepEqual(resizeBox(box, "se", 30, 40, { min: MIN_FLOAT }), {
    x: 10,
    y: 20,
    width: 230,
    height: 340,
  });
  assert.deepEqual(resizeBox(box, "nw", -30, -40, { min: MIN_FLOAT }), {
    x: -20,
    y: -20,
    width: 230,
    height: 340,
  });
});

test("a floating panel never gets smaller than it may", () => {
  const box = { x: 10, y: 20, width: 200, height: 300 };
  const small = resizeBox(box, "se", -500, -500, { min: MIN_FLOAT });
  assert.equal(small.width, MIN_FLOAT.width);
  assert.equal(small.height, MIN_FLOAT.height);

  // The handle on the left grows the panel the other way, but it does not
  // make it smaller than it may be.
  const wide = resizeBox(box, "w", 500, 0, { min: MIN_FLOAT });
  assert.equal(wide.width, MIN_FLOAT.width);
  assert.equal(wide.x, 10 + 200 - MIN_FLOAT.width);
});
