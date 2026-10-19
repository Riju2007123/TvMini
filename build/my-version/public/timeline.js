/**
 * Shared, DOM-free timeline logic.
 *
 * A layer owns drawings. Each drawing starts at an absolute frame number and
 * is exposed for `hold` frames (TVPaint calls this an exposure). Frames that
 * are inside a drawing's exposure but not at its start are "held" cells.
 *
 * This module is imported by the browser UI, the PNG renderer and the tests.
 */

export const BEHAVIORS = ["none", "hold", "repeat", "pingpong"];

export function isBehavior(value) {
  return BEHAVIORS.includes(value);
}

function drawingsOf(layer) {
  return Array.isArray(layer.drawings) ? layer.drawings : [];
}

/** Index of the drawing whose exposure contains `frame`, or -1. */
export function drawingIndexAt(layer, frame) {
  const drawings = drawingsOf(layer);
  for (let index = 0; index < drawings.length; index += 1) {
    const drawing = drawings[index];
    if (frame >= drawing.at && frame < drawing.at + drawing.hold) return index;
  }
  return -1;
}

export function drawingAt(layer, frame) {
  const index = drawingIndexAt(layer, frame);
  return index === -1 ? null : drawingsOf(layer)[index];
}

/** First and last exposed frame of a layer, or null for an empty layer. */
export function layerBounds(layer) {
  const drawings = drawingsOf(layer);
  if (drawings.length === 0) return null;

  let first = Infinity;
  let last = -Infinity;
  for (const drawing of drawings) {
    first = Math.min(first, drawing.at);
    last = Math.max(last, drawing.at + drawing.hold - 1);
  }
  return { first, last };
}

function mapVirtualFrame(frame, first, last, behavior) {
  if (behavior === "none") return null;
  if (behavior === "hold") return frame < first ? first : last;

  const length = last - first + 1;
  if (length <= 0) return null;

  if (behavior === "repeat") {
    const offset = ((frame - first) % length + length) % length;
    return first + offset;
  }

  if (behavior === "pingpong") {
    if (length === 1) return first;
    const period = length * 2 - 2;
    let offset = ((frame - first) % period + period) % period;
    if (offset >= length) offset = period - offset;
    return first + offset;
  }

  return null;
}

/**
 * Resolve a timeline frame to a drawing, applying pre/post behaviour when the
 * frame is outside the layer's exposed range. Returns null for empty frames.
 */
export function resolveDrawing(layer, frame) {
  const bounds = layerBounds(layer);
  if (!bounds) return null;

  if (frame >= bounds.first && frame <= bounds.last) {
    const index = drawingIndexAt(layer, frame);
    if (index === -1) return null;
    return {
      drawing: drawingsOf(layer)[index],
      index,
      sourceFrame: frame,
      virtual: false,
    };
  }

  const behavior = frame < bounds.first ? layer.preBehavior : layer.postBehavior;
  const sourceFrame = mapVirtualFrame(frame, bounds.first, bounds.last, behavior);
  if (sourceFrame === null) return null;

  const index = drawingIndexAt(layer, sourceFrame);
  if (index === -1) return null;

  return {
    drawing: drawingsOf(layer)[index],
    index,
    sourceFrame,
    virtual: true,
  };
}

/** Describe what a timeline cell shows: head, hold, virtual or empty. */
export function exposureInfo(layer, frame) {
  const index = drawingIndexAt(layer, frame);
  if (index !== -1) {
    const drawing = drawingsOf(layer)[index];
    return {
      kind: frame === drawing.at ? "head" : "hold",
      count: drawing.hold,
      remaining: drawing.at + drawing.hold - frame,
      drawing,
      index,
    };
  }

  const resolved = resolveDrawing(layer, frame);
  if (resolved) {
    return {
      kind: "virtual",
      count: resolved.drawing.hold,
      remaining: null,
      drawing: resolved.drawing,
      index: resolved.index,
      sourceFrame: resolved.sourceFrame,
    };
  }

  return { kind: "empty", count: 0, remaining: 0, drawing: null, index: -1 };
}

/** Highest exposed frame in the document, or startFrame - 1 when empty. */
export function contentEnd(project) {
  let end = project.startFrame - 1;
  for (const layer of project.layers) {
    for (const drawing of drawingsOf(layer)) {
      end = Math.max(end, drawing.at + drawing.hold - 1);
    }
  }
  return end;
}

/** Number of frames that contain content, measured from startFrame. */
export function contentLength(project) {
  return Math.max(0, contentEnd(project) - project.startFrame + 1);
}

/**
 * Number of timeline columns to show. Extra empty columns make it easy to
 * draw beyond the current content.
 */
export function timelineColumns(project, minimum = 12) {
  const current = project.currentFrame - project.startFrame + 1;
  return Math.max(minimum, contentLength(project) + 4, current + 2);
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function sortDrawings(layer) {
  layer.drawings.sort((a, b) => a.at - b.at);
}

/**
 * Insert a blank drawing at `frame`.
 *
 * - At an empty frame: the drawing is added without moving anything else.
 * - At the head of an existing drawing: that drawing and all later drawings
 *   move one frame to the right.
 * - Inside an exposure: the exposure is split in two and a blank drawing is
 *   inserted between the halves.
 */
export function insertDrawing(layer, frame) {
  const drawings = drawingsOf(layer);
  const index = drawingIndexAt(layer, frame);

  if (index === -1) {
    const drawing = { at: frame, hold: 1, strokes: [] };
    drawings.push(drawing);
    sortDrawings(layer);
    return drawing;
  }

  const current = drawings[index];
  const end = current.at + current.hold;
  let right = null;

  if (current.at === frame) {
    for (const drawing of drawings) {
      if (drawing.at >= frame) drawing.at += 1;
    }
  } else {
    right = {
      at: frame + 1,
      hold: end - frame,
      strokes: clone(current.strokes),
    };
    current.hold = frame - current.at;
    for (const drawing of drawings) {
      if (drawing.at >= end) drawing.at += 1;
    }
  }

  const inserted = { at: frame, hold: 1, strokes: [] };
  drawings.push(inserted);
  if (right) drawings.push(right);
  sortDrawings(layer);
  return inserted;
}

/**
 * Remove the drawing that owns `frame` and close the gap by moving later
 * drawings left by its exposure length. Returns the removed drawing or null.
 */
export function deleteDrawing(layer, frame) {
  const drawings = drawingsOf(layer);
  const index = drawingIndexAt(layer, frame);
  if (index === -1) return null;

  const [removed] = drawings.splice(index, 1);
  for (const drawing of drawings) {
    if (drawing.at >= removed.at + removed.hold) drawing.at -= removed.hold;
  }
  sortDrawings(layer);
  return removed;
}

/** Duplicate the drawing at `frame`, placing the copy directly after it. */
export function duplicateDrawing(layer, frame) {
  const drawings = drawingsOf(layer);
  const index = drawingIndexAt(layer, frame);
  if (index === -1) return null;

  const source = drawings[index];
  const end = source.at + source.hold;
  for (const drawing of drawings) {
    if (drawing.at >= end) drawing.at += source.hold;
  }

  const copy = {
    at: end,
    hold: source.hold,
    strokes: clone(source.strokes),
  };
  drawings.push(copy);
  sortDrawings(layer);
  return copy;
}

/**
 * Change the exposure of the drawing that owns `frame`, moving later drawings
 * by the same delta so they keep their order without overlapping.
 */
export function setExposure(layer, frame, hold) {
  const drawings = drawingsOf(layer);
  const index = drawingIndexAt(layer, frame);
  if (index === -1) return null;

  const drawing = drawings[index];
  if (!Number.isInteger(hold) || hold < 1) return null;

  const oldEnd = drawing.at + drawing.hold;
  const delta = hold - drawing.hold;
  for (const other of drawings) {
    if (other.at >= oldEnd) other.at += delta;
  }
  drawing.hold = hold;
  return drawing;
}

/** Extend the exposure of the drawing that owns `frame` by one frame. */
export function holdDrawing(layer, frame) {
  const drawing = drawingAt(layer, frame);
  if (!drawing) return null;
  return setExposure(layer, frame, drawing.hold + 1);
}

/**
 * Move the timeline's first frame number. Drawings and the current frame move
 * with it, so the same artwork stays at the same relative position.
 */
export function shiftStartFrame(project, newStart) {
  if (!Number.isInteger(newStart) || newStart < 1) return false;
  const delta = newStart - project.startFrame;
  if (delta === 0) return true;

  for (const layer of project.layers) {
    for (const drawing of drawingsOf(layer)) drawing.at += delta;
  }
  project.startFrame = newStart;
  project.currentFrame += delta;
  return true;
}
