/**
 * A selection: the part of the canvas the tools are allowed to touch.
 *
 * Flash keeps a selection as a mask, not as a list of shapes. A rectangle, an
 * oval and a lasso all end up as the same thing - a picture of the canvas
 * where a pixel is either in the selection or out of it - and every tool that
 * respects a selection tests that picture. That is why painting inside a
 * lasso works the same as painting inside a rectangle here.
 *
 * The mask is one byte per pixel, the size of the canvas. The bounds of the
 * pixels that are in it are kept beside it, so a point outside the selection
 * costs one comparison instead of one lookup per pixel.
 *
 * Nothing here touches the document or the DOM: it is arithmetic on a mask.
 */

import { sampleEllipse } from "./paint.js";

/** How a new selection is combined with the one that is there. */
export const SELECTION_MODES = ["new", "add", "subtract"];

/** A selection of nothing, the size of the canvas. */
export function emptySelection(width, height) {
  return {
    width,
    height,
    bits: new Uint8Array(width * height),
    // The box of the pixels that are in the selection, the right and the
    // bottom left out, so that an empty box reads as x1 <= x0.
    x0: width,
    y0: height,
    x1: 0,
    y1: 0,
  };
}

function mark(box, x, y) {
  if (x < box.x0) box.x0 = x;
  if (x + 1 > box.x1) box.x1 = x + 1;
  if (y < box.y0) box.y0 = y;
  if (y + 1 > box.y1) box.y1 = y + 1;
}

function setPixel(selection, x, y) {
  const { width, height, bits } = selection;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  bits[y * width + x] = 1;
  mark(selection, x, y);
}

/** The whole canvas. */
export function selectAll(width, height) {
  const selection = emptySelection(width, height);
  selection.bits.fill(1);
  selection.x0 = 0;
  selection.y0 = 0;
  selection.x1 = width;
  selection.y1 = height;
  return selection;
}

/**
 * A rectangle, dragged from one corner to the other.
 *
 * The corners are rounded outwards, so a drag of a fraction of a pixel still
 * takes the pixel the pointer passed over.
 */
export function selectionFromRect(width, height, x0, y0, x1, y1) {
  const selection = emptySelection(width, height);
  const left = Math.max(0, Math.floor(Math.min(x0, x1)));
  const right = Math.min(width, Math.ceil(Math.max(x0, x1)));
  const top = Math.max(0, Math.floor(Math.min(y0, y1)));
  const bottom = Math.min(height, Math.ceil(Math.max(y0, y1)));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) setPixel(selection, x, y);
  }
  return selection;
}

/** An oval, dragged inside the box of the drag. */
export function selectionFromEllipse(width, height, x0, y0, x1, y1) {
  const selection = emptySelection(width, height);
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const radiusX = (right - left) / 2;
  const radiusY = (bottom - top) / 2;
  if (radiusX <= 0 || radiusY <= 0) return selection;
  const centreX = (left + right) / 2;
  const centreY = (top + bottom) / 2;
  const fromX = Math.max(0, Math.floor(left));
  const toX = Math.min(width, Math.ceil(right));
  const fromY = Math.max(0, Math.floor(top));
  const toY = Math.min(height, Math.ceil(bottom));
  for (let y = fromY; y < toY; y += 1) {
    const ny = (y + 0.5 - centreY) / radiusY;
    for (let x = fromX; x < toX; x += 1) {
      const nx = (x + 0.5 - centreX) / radiusX;
      if (nx * nx + ny * ny <= 1) setPixel(selection, x, y);
    }
  }
  return selection;
}

/**
 * A lasso: the inside of the path the pointer drew.
 *
 * The path is filled the way a path is filled on the screen, so a lasso that
 * crosses itself leaves out the parts it winds round twice. The path is
 * closed for the purpose of the fill whether or not the pointer came back to
 * where it started, the way a lasso snaps shut when the button is let go.
 */
export function selectionFromPolygon(width, height, points) {
  const selection = emptySelection(width, height);
  const path = (points ?? []).filter(
    (point) => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]),
  );
  if (path.length < 3) return selection;

  let top = Infinity;
  let bottom = -Infinity;
  for (const point of path) {
    top = Math.min(top, point[1]);
    bottom = Math.max(bottom, point[1]);
  }
  const fromY = Math.max(0, Math.floor(top));
  const toY = Math.min(height, Math.ceil(bottom));
  let lowest = 0;
  let highest = 0;
  for (let y = fromY; y < toY; y += 1) {
    const at = y + 0.5;
    const crossings = [];
    for (let index = 0; index < path.length; index += 1) {
      const a = path[index];
      const b = path[(index + 1) % path.length];
      // A crossing counts when the row passes between the two ends of the
      // side, the top end counting and the bottom end not, so that a corner
      // is not counted twice.
      if (a[1] <= at === b[1] <= at) continue;
      crossings.push(a[0] + ((at - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    crossings.sort((left, right) => left - right);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const fromX = Math.max(0, Math.ceil(crossings[index] - 0.5));
      const toX = Math.min(width, Math.ceil(crossings[index + 1] - 0.5));
      lowest = Math.min(lowest, fromX);
      highest = Math.max(highest, toX);
      for (let x = fromX; x < toX; x += 1) setPixel(selection, x, y);
    }
  }
  return selection;
}

/** Whether the selection holds no pixel at all. */
export function selectionIsEmpty(selection) {
  return !selection || selection.x1 <= selection.x0 || selection.y1 <= selection.y0;
}

/** The box of the selected pixels, or null when there are none. */
export function selectionBounds(selection) {
  if (selectionIsEmpty(selection)) return null;
  const { x0, y0, x1, y1 } = selection;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** How many pixels are in the selection. */
export function selectionArea(selection) {
  if (selectionIsEmpty(selection)) return 0;
  const { width, bits } = selection;
  let count = 0;
  for (let y = selection.y0; y < selection.y1; y += 1) {
    const row = y * width;
    for (let x = selection.x0; x < selection.x1; x += 1) {
      if (bits[row + x]) count += 1;
    }
  }
  return count;
}

/** Whether a point of the canvas is inside the selection. */
export function selectionContains(selection, x, y) {
  if (selectionIsEmpty(selection)) return false;
  const px = Math.floor(x);
  const py = Math.floor(y);
  const { width, height, bits } = selection;
  if (px < 0 || py < 0 || px >= width || py >= height) return false;
  if (px < selection.x0 || py < selection.y0 || px >= selection.x1 || py >= selection.y1) {
    return false;
  }
  return bits[py * width + px] === 1;
}

/**
 * The selection as runs of pixels, one list of runs per row.
 *
 * A fill has to hold on to the part of the canvas it is allowed to paint, and
 * a run of pixels is the smallest way to say that: a rectangle is one run per
 * row and a lasso is a handful. The runs are stored with the fill, so the
 * window and the export put the paint in the same pixels.
 */
export function selectionSpans(selection) {
  if (selectionIsEmpty(selection)) return [];
  const spans = [];
  const { width, bits } = selection;
  for (let y = selection.y0; y < selection.y1; y += 1) {
    const row = y * width;
    let start = -1;
    for (let x = selection.x0; x < selection.x1; x += 1) {
      if (bits[row + x]) {
        if (start < 0) start = x;
        continue;
      }
      if (start >= 0) {
        spans.push([y, start, x]);
        start = -1;
      }
    }
    if (start >= 0) spans.push([y, start, selection.x1]);
  }
  return spans;
}

/**
 * Put two selections together.
 *
 * `new` takes the newer one alone (the way a drag with no key down starts a
 * selection over), `add` keeps every pixel of both (Shift), and `subtract`
 * takes the newer one away from the older (Alt).
 */
export function combineSelections(base, next, mode = "new") {
  if (!next) return base ?? null;
  if (mode === "new" || !base) return next;

  const width = Math.max(base.width, next.width);
  const height = Math.max(base.height, next.height);
  const result = emptySelection(width, height);

  // The two are the size of the same canvas; a mask of another size is taken
  // to mean nothing rather than shifting the pixels of the other.
  if (base.width !== next.width || base.height !== next.height) return next;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const inBase = base.bits[row + x] === 1;
      const inNext = next.bits[row + x] === 1;
      const keep = mode === "subtract" ? inBase && !inNext : inBase || inNext;
      if (!keep) continue;
      result.bits[row + x] = 1;
      mark(result, x, y);
    }
  }
  return result;
}

/** Everything that is not in the selection. */
export function invertSelection(selection) {
  const width = selection.width;
  const height = selection.height;
  const result = emptySelection(width, height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (selection.bits[row + x] === 1) continue;
      result.bits[row + x] = 1;
      mark(result, x, y);
    }
  }
  return result;
}

/** Move the selection itself, so that it travels with the ink it holds. */
export function shiftSelection(selection, dx, dy) {
  const { width, height, bits } = selection;
  const shiftX = Math.round(dx);
  const shiftY = Math.round(dy);
  if (shiftX === 0 && shiftY === 0) return selection;
  const result = emptySelection(width, height);
  for (let y = selection.y0; y < selection.y1; y += 1) {
    const row = y * width;
    const toY = y + shiftY;
    for (let x = selection.x0; x < selection.x1; x += 1) {
      if (!bits[row + x]) continue;
      setPixel(result, x + shiftX, toY);
    }
  }
  return result;
}

/**
 * The edge of the selection, as the lines the marching ants are drawn with.
 *
 * Every pixel of the selection that has a neighbour outside it gives the side
 * that faces that neighbour. The sides of a row are then run together, so a
 * rectangle is four lines and not one line per pixel.
 */
export function selectionOutline(selection) {
  if (selectionIsEmpty(selection)) return [];
  // The outline of a selection is asked for on every frame of a drag, and a
  // selection is replaced rather than changed, so the answer is kept on it.
  if (selection.outline) return selection.outline;

  const { width, height, bits } = selection;
  const inSelection = (x, y) =>
    x >= 0 && y >= 0 && x < width && y < height && bits[y * width + x] === 1;

  const horizontal = new Map();
  const vertical = new Map();
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  for (let y = selection.y0; y < selection.y1; y += 1) {
    for (let x = selection.x0; x < selection.x1; x += 1) {
      if (!inSelection(x, y)) continue;
      if (!inSelection(x, y - 1)) push(horizontal, y, x);
      if (!inSelection(x, y + 1)) push(horizontal, y + 1, x);
      if (!inSelection(x - 1, y)) push(vertical, x, y);
      if (!inSelection(x + 1, y)) push(vertical, x + 1, y);
    }
  }

  const segments = [];
  for (const [y, xs] of horizontal) {
    for (const [from, to] of runTogether(xs)) segments.push([from, y, to, y]);
  }
  for (const [x, ys] of vertical) {
    for (const [from, to] of runTogether(ys)) segments.push([x, from, x, to]);
  }
  selection.outline = segments;
  return segments;
}

/** The numbers in order, with the ones that touch run together. */
function runTogether(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const runs = [];
  let from = sorted[0];
  let to = sorted[0] + 1;
  for (let index = 1; index < sorted.length; index += 1) {
    const value = sorted[index];
    if (value <= to) {
      to = Math.max(to, value + 1);
      continue;
    }
    runs.push([from, to]);
    from = value;
    to = value + 1;
  }
  runs.push([from, to]);
  return runs;
}

/**
 * The parts of a line that lie inside the selection.
 *
 * The line is followed point by point and cut where it leaves the selection,
 * so a stroke that starts outside, crosses the selection and ends outside
 * comes back as the one run that was inside. A run of a single point is not
 * kept: a line that only touches the selection has not painted in it.
 */
export function clipPolyline(selection, points, minimum = 2) {
  if (selectionIsEmpty(selection)) return points?.length ? [points] : [];
  const runs = [];
  let run = null;
  for (const point of points ?? []) {
    if (selectionContains(selection, point[0], point[1])) {
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push(point);
      continue;
    }
    run = null;
  }
  return runs.filter((part) => part.length >= minimum);
}

/** The points a stroke is drawn along, and whether the path closes on itself. */
function strokePath(stroke, sampleEllipsePoint) {
  const points = stroke.points ?? [];
  if (points.length === 0) return null;

  if (stroke.kind === "line") {
    return { points: points.slice(0, 2), closed: false };
  }
  if (stroke.kind === "rect") {
    const [x0, y0] = points[0];
    const [x1, y1] = points[1] ?? points[0];
    return {
      points: [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
      closed: true,
    };
  }
  if (stroke.kind === "ellipse") {
    const [x0, y0] = points[0];
    const [x1, y1] = points[1] ?? points[0];
    const outline = sampleEllipsePoint(x0, y0, x1, y1);
    if (!outline) return null;
    return { points: [...outline, outline[0]], closed: true };
  }
  return { points, closed: false };
}

/**
 * Cut a stroke to the selection.
 *
 * A stroke that is inside the selection is handed back untouched, so that a
 * line, a rectangle or an oval keeps its kind. A stroke that leaves the
 * selection is cut at the edge: the part inside comes back, and the part
 * outside is gone. A shape that is cut becomes a line of its own points,
 * because what is left is no longer a rectangle.
 *
 * A fill is not a line and is not cut here; the caller decides what a fill
 * does when a selection is up.
 */
export function clipStroke(selection, stroke) {
  if (!stroke || selectionIsEmpty(selection)) return stroke ? [stroke] : [];
  if (stroke.kind === "fill") return [stroke];

  const path = strokePath(stroke, sampleEllipse);
  if (!path) return [stroke];

  let runs = clipPolyline(selection, path.points, 2);
  if (runs.length === 0) return [];

  // A shape closes on itself, so a run that leaves at the end of the path
  // and a run that comes back in at its start are one run, not two.
  if (path.closed && runs.length > 1) {
    const first = path.points[0];
    const last = path.points[path.points.length - 1];
    if (
      selectionContains(selection, first[0], first[1]) &&
      selectionContains(selection, last[0], last[1])
    ) {
      const joined = [...runs[runs.length - 1], ...runs[0]];
      runs = [joined, ...runs.slice(1, -1)];
    }
  }

  const inside = runs.length === 1 && runs[0].length === path.points.length;
  if (inside) return [stroke];

  return runs.map((run) => {
    const copy = { ...stroke, points: run };
    // The shape of a rectangle or an oval is gone: what is left is the piece
    // of its outline that was inside the selection.
    delete copy.kind;
    return copy;
  });
}

/** Move a stroke, keeping everything else about it. */
export function translateStroke(stroke, dx, dy) {
  if (!stroke || (dx === 0 && dy === 0)) return stroke;
  return {
    ...stroke,
    points: stroke.points.map((point) => [
      point[0] + dx,
      point[1] + dy,
      ...point.slice(2),
    ]),
  };
}
