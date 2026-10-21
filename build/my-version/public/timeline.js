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

/* ------------------------------------------------------------------- layers */

/** The kinds of layer a project can hold. */
export const LAYER_TYPES = ["anim", "group"];

/** A folder holds other layers; a drawing layer holds cells. */
export function isGroup(layer) {
  return layer?.type === "group";
}

/**
 * The layers that are children of `parent`.
 *
 * `-1` asks for the layers at the top level. The children come back in the
 * order they sit in the layer list, so a folder's children are always the
 * rows that follow it.
 */
export function childrenOf(project, parent) {
  const children = [];
  const layers = project?.layers ?? [];
  for (let index = 0; index < layers.length; index += 1) {
    const parentIndex = layers[index].parent ?? -1;
    if (parentIndex === parent) children.push(index);
  }
  return children;
}

/** The chain of folders above `index`, closest first. */
export function ancestorsOf(project, index) {
  const chain = [];
  const layers = project?.layers ?? [];
  let parent = layers[index]?.parent ?? -1;
  const seen = new Set();
  while (parent >= 0 && parent < layers.length && !seen.has(parent)) {
    seen.add(parent);
    chain.push(parent);
    parent = layers[parent].parent ?? -1;
  }
  return chain;
}

/** How deep a layer sits in the tree; the top level is 0. */
export function layerDepth(project, index) {
  return ancestorsOf(project, index).length;
}

/**
 * Every layer of the project, folders and their children together.
 *
 * The list is depth first and follows the layer list, so a folder is
 * followed by the layers it holds.
 */
export function layerTree(project) {
  const layers = project?.layers ?? [];
  const out = [];
  const walk = (parent) => {
    for (const child of childrenOf(project, parent)) {
      out.push(child);
      walk(child);
    }
  };
  walk(-1);
  // A layer whose parent points at a folder that is not there would be lost,
  // so anything the walk did not reach is appended at the end.
  if (out.length !== layers.length) {
    const seen = new Set(out);
    for (let index = 0; index < layers.length; index += 1) {
      if (!seen.has(index)) out.push(index);
    }
  }
  return out;
}

/** The opacity a layer is painted with: its own times every folder's. */
export function effectiveOpacity(project, index) {
  const layers = project?.layers ?? [];
  let opacity = layers[index]?.opacity ?? 1;
  for (const parent of ancestorsOf(project, index)) {
    opacity *= layers[parent]?.opacity ?? 1;
  }
  return opacity;
}

/** Whether a layer is painted: it and every folder above it are on. */
export function layerIsVisible(project, index) {
  const layers = project?.layers ?? [];
  if (layers[index]?.visible === false) return false;
  return ancestorsOf(project, index).every((parent) => layers[parent]?.visible !== false);
}

/**
 * The layer a clipped layer is cut by: the drawing layer right below it,
 * the way Clip Studio Paint clips to the layer underneath.
 *
 * A folder has no picture of its own, so it is skipped and the layers
 * inside it are looked at instead.
 */
export function clipSourceOf(project, index) {
  const layers = project?.layers ?? [];
  for (let next = index + 1; next < layers.length; next += 1) {
    if (isGroup(layers[next])) continue;
    return next;
  }
  return -1;
}

/* ------------------------------------------------------------------- cells */

/**
 * Whether a layer sits inside another one.
 *
 * A folder holds its children, and a folder inside a folder holds its
 * children in turn, so the answer is found by walking up the folders.
 */
export function isInside(project, ancestor, index) {
  const layers = project?.layers ?? [];
  const seen = new Set();
  let parent = layers[index]?.parent ?? -1;
  while (parent !== -1 && !seen.has(parent)) {
    if (parent === ancestor) return true;
    seen.add(parent);
    parent = layers[parent]?.parent ?? -1;
  }
  return false;
}

/**
 * How many layers a folder holds, itself and everything under it.
 *
 * The layers of a folder sit right after it, so the folder and its children
 * are one block of the list.
 */
export function blockSize(project, index) {
  const layers = project?.layers ?? [];
  let count = 1;
  for (let next = index + 1; next < layers.length; next += 1) {
    if (!isInside(project, index, next)) break;
    count += 1;
  }
  return count;
}

/**
 * Put the layers in order: a folder is followed by the layers it holds.
 *
 * The list is drawn top first and the children of a folder are indented
 * under it, so they have to sit right after it. The numbers that say which
 * folder holds a layer are indexes into this list, so they follow it.
 */
export function packLayers(project) {
  const order = [];
  const walk = (parent) => {
    for (const child of childrenOf(project, parent)) {
      order.push(child);
      walk(child);
    }
  };
  walk(-1);
  const seen = new Set(order);
  for (let index = 0; index < project.layers.length; index += 1) {
    if (!seen.has(index)) order.push(index);
  }

  const mapping = new Map();
  order.forEach((oldIndex, newIndex) => mapping.set(oldIndex, newIndex));

  const layers = order.map((oldIndex) => project.layers[oldIndex]);
  for (const layer of layers) {
    if (layer.parent === -1) continue;
    layer.parent = mapping.get(layer.parent) ?? -1;
  }
  project.layers = layers;
  return mapping;
}

/**
 * Put a layer into the list.
 *
 * `parent` is the index of the folder that will hold it, or -1 for the top
 * level. The numbers that say which folder holds a layer move with the list.
 */
export function insertLayer(project, index, layer, parent = -1) {
  const old = project.layers;
  const mapping = new Map();
  for (let i = 0; i < old.length; i += 1) mapping.set(i, i < index ? i : i + 1);
  old.splice(index, 0, layer);
  for (const item of old) {
    if (item === layer || item.parent === -1) continue;
    item.parent = mapping.get(item.parent) ?? -1;
  }
  layer.parent = parent === -1 ? -1 : (mapping.get(parent) ?? -1);
  return mapping;
}

/**
 * Take layers out of the list.
 *
 * The numbers that say which folder holds a layer move with the list, and a
 * layer whose folder is gone ends up at the top level.
 */
export function removeLayers(project, indices) {
  const removed = new Set(indices);
  const old = project.layers;
  const kept = old.filter((_, index) => !removed.has(index));
  const mapping = new Map();
  let next = 0;
  for (let index = 0; index < old.length; index += 1) {
    if (removed.has(index)) continue;
    mapping.set(index, next);
    next += 1;
  }
  for (const layer of kept) {
    if (layer.parent === -1) continue;
    layer.parent = mapping.has(layer.parent) ? mapping.get(layer.parent) : -1;
  }
  project.layers = kept;
  return mapping;
}

/**
 * Move a block of layers to another place in the list.
 *
 * A folder and the layers inside it are one block, so they move together.
 * `to` is the place the block ends up at, counted in the list that is left
 * once the block has been taken out.
 */
export function moveBlock(project, from, count, to) {
  if (from === to) return null;
  if (from < 0 || from >= project.layers.length) return null;
  if (count < 1) return null;

  const old = project.layers;
  // Remember which folder each layer is in by the folder itself, so the
  // numbers can be worked out again after the move.
  const parentOf = new Map();
  old.forEach((layer) => parentOf.set(layer, layer.parent === -1 ? null : old[layer.parent] ?? null));

  const block = old.splice(from, count);
  const target = Math.max(0, Math.min(to, old.length));
  old.splice(target, 0, ...block);

  const indexOf = new Map();
  old.forEach((layer, index) => indexOf.set(layer, index));
  for (const layer of old) {
    const parent = parentOf.get(layer);
    layer.parent = parent ? (indexOf.get(parent) ?? -1) : -1;
  }
  return indexOf;
}

/**
 * The name a new cell gets, the way Clip Studio Paint names its cells.
 *
 * A cell is named after the frame it sits on, and a second cell on the same
 * frame gets a letter: `1`, `1a`, `1b`, then `2`, `2a` and so on. The name
 * is for the cell that is about to be added, so the cells that are already
 * on the frame decide the letter.
 */
export function cellName(layer, frame) {
  const sameFrame = drawingsOf(layer).filter((drawing) => drawing.at === frame);
  const base = String(frame);
  const ordinal = sameFrame.length + 1;
  if (ordinal <= 1) return base;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const index = ordinal - 2;
  return index < letters.length ? `${base}${letters[index]}` : `${base}${index + 2}`;
}

/**
 * The frame a cell name stands for.
 *
 * Clip Studio Paint names a cell after the frame it is on, so `2a` is the
 * second cell on frame 2. A name that is not a frame number has no frame.
 */
export function frameOfCellName(name) {
  if (typeof name !== "string") return null;
  const match = /^(\d+)([a-z]*)$/.exec(name.trim());
  if (!match) return null;
  const frame = Number(match[1]);
  return Number.isInteger(frame) && frame > 0 ? frame : null;
}

/**
 * Every frame that holds a key: a cell's first frame, or a camera key.
 *
 * The timeline uses this list for the "previous key" and "next key" buttons.
 */
export function keyframes(project) {
  const frames = new Set();
  for (const layer of project?.layers ?? []) {
    for (const drawing of drawingsOf(layer)) frames.add(drawing.at);
  }
  for (const key of project?.camera?.keys ?? []) frames.add(key.frame);
  const start = project?.startFrame ?? 1;
  return [...frames].filter((frame) => frame >= start).sort((a, b) => a - b);
}

/** The key before `frame`, or null when there is none. */
export function previousKeyframe(project, frame) {
  let found = null;
  for (const key of keyframes(project)) {
    if (key < frame) found = key;
  }
  return found;
}

/** The key after `frame`, or null when there is none. */
export function nextKeyframe(project, frame) {
  for (const key of keyframes(project)) {
    if (key > frame) return key;
  }
  return null;
}

/* ------------------------------------------------------------------ camera */

/** How the camera travels from one keyframe to the next. */
export const CAMERA_INTERP = ["linear", "ease", "hold"];

/**
 * The easing curve of a camera key.
 *
 * "hold" keeps the first key until the next one arrives, "ease" is a
 * smoothstep and "linear" moves at a constant speed.
 */
export function cameraInterpT(interp, t) {
  if (interp === "hold") return t >= 1 ? 1 : 0;
  if (interp === "ease") return t * t * (3 - 2 * t);
  return t;
}

/** The shortest way round from one angle to another, in degrees. */
function shortestAngle(from, to) {
  let difference = (to - from) % 360;
  if (difference > 180) difference -= 360;
  if (difference < -180) difference += 360;
  return difference;
}

/**
 * The camera window in effect at `frame`.
 *
 * A camera track is a list of keyframes, each one a window over the canvas.
 * The camera holds its last key until the next one arrives and travels
 * between two keys with the first key's easing. Before the first key the
 * first key is already in effect, and after the last key it stays there.
 */
export function cameraAt(camera, frame) {
  const keys = Array.isArray(camera?.keys) ? camera.keys : [];
  if (keys.length === 0) return null;
  if (keys.length === 1) return { ...keys[0] };

  let previous = null;
  let next = null;
  for (const key of keys) {
    if (key.frame <= frame) previous = key;
    if (!next && key.frame >= frame) next = key;
  }
  if (!previous) previous = next;
  if (!next) next = previous;
  if (!previous || !next) return null;
  if (previous === next || previous.frame === next.frame) return { ...previous };

  const span = Math.max(1, next.frame - previous.frame);
  const t = cameraInterpT(
    previous.interp,
    Math.min(1, Math.max(0, (frame - previous.frame) / span)),
  );

  return {
    frame: previous.frame,
    x: previous.x + (next.x - previous.x) * t,
    y: previous.y + (next.y - previous.y) * t,
    width: previous.width + (next.width - previous.width) * t,
    height: previous.height + (next.height - previous.height) * t,
    rotation: previous.rotation + shortestAngle(previous.rotation, next.rotation) * t,
    interp: previous.interp,
  };
}

/** The camera key on `frame` exactly, or null. */
export function cameraKeyAt(camera, frame) {
  if (!camera || !Array.isArray(camera.keys)) return null;
  return camera.keys.find((key) => key.frame === frame) ?? null;
}

/** Insert or replace a camera key, keeping the list sorted by frame. */
export function setCameraKey(camera, key) {
  const keys = Array.isArray(camera?.keys) ? camera.keys.filter((k) => k.frame !== key.frame) : [];
  // Every key carries the full set of fields, so the maths never meets a
  // missing number.
  keys.push({
    frame: key.frame,
    x: Number(key.x) || 0,
    y: Number(key.y) || 0,
    width: Number(key.width) || 1,
    height: Number(key.height) || 1,
    rotation: Number(key.rotation) || 0,
    interp: CAMERA_INTERP.includes(key.interp) ? key.interp : "linear",
  });
  keys.sort((a, b) => a.frame - b.frame);
  return { keys };
}

/** Remove the camera key on `frame` (if any). */
export function deleteCameraKey(camera, frame) {
  if (!camera || !Array.isArray(camera.keys)) return { keys: [] };
  return { keys: camera.keys.filter((key) => key.frame !== frame) };
}

/**
 * The view transform for a camera window inside a canvas of `width` x
 * `height`: the window is scaled to fit and centred, so the rest of the
 * canvas is covered by the letterbox area.
 */
export function cameraView(camera, frame, width, height) {
  const window = cameraAt(camera, frame);
  if (!window) return null;
  const scale = Math.min(width / window.width, height / window.height);
  return {
    camera: window,
    scale,
    offsetX: (width - window.width * scale) / 2,
    offsetY: (height - window.height * scale) / 2,
  };
}

/** The four corners of a camera window, in canvas coordinates. */
export function cameraCorners(window) {
  const rotation = ((Number(window.rotation) || 0) * Math.PI) / 180;
  const centreX = window.x + window.width / 2;
  const centreY = window.y + window.height / 2;
  const halfWidth = window.width / 2;
  const halfHeight = window.height / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([dx, dy]) => ({
    x: centreX + dx * cos - dy * sin,
    y: centreY + dx * sin + dy * cos,
  }));
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
  // A camera key counts as content: the shot moves on that frame.
  if (project.camera && Array.isArray(project.camera.keys)) {
    for (const key of project.camera.keys) {
      end = Math.max(end, key.frame);
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

/* ------------------------------------------------------------- new papers */

/**
 * The paper sizes, in millimetres.
 *
 * A paper of A4 is 297 by 210 millimetres, so at 150 dots an inch it is
 * 1754 by 1240 pixels - the size Clip Studio Paint writes into a document.
 * The longer side comes first, the way Clip Studio shows it.
 */
export const PAPER_MM = {
  A3: [420, 297],
  A4: [297, 210],
  A5: [210, 148],
  B4: [353, 250],
  B5: [250, 176],
  Letter: [279.4, 215.9],
  Legal: [355.6, 215.9],
  Tabloid: [431.8, 279.4],
};

/** The camera shapes a document can be given. */
export const CAMERA_RATIOS = [
  ["4:3", 4 / 3],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["1:1", 1],
  ["2.39:1", 2.39],
  ["1.85:1", 1.85],
  ["1.66:1", 1.66],
];

/**
 * The size of a paper of a standard size, in pixels.
 *
 * The size is given in millimetres and the number of dots an inch turns it
 * into pixels, the way Clip Studio Paint does it: A4 at 150 dots an inch is
 * 1754 by 1240.
 */
export function paperPixels(name, dpi) {
  const millimetres = PAPER_MM[name];
  const dots = Math.max(1, Math.round(Number(dpi) || 0));
  if (!millimetres) return null;
  return millimetres.map((side) => Math.round((side / 25.4) * dots));
}

/**
 * The camera of a new document, in the pixels of its paper.
 *
 * The frame is always centred horizontally, the way Clip Studio Paint holds
 * it, and it never reaches outside the paper.
 */
export function cameraWindow(paper, camera) {
  const width = Math.max(16, Math.min(paper.width, Math.round(camera.width)));
  const height = Math.max(16, Math.min(paper.height, Math.round(camera.height)));
  const x = Math.max(
    0,
    Math.min(paper.width - width, Math.round((paper.width - width) / 2)),
  );
  const y = Math.max(0, Math.min(paper.height - height, Math.round(camera.y)));
  return { x, y, width, height };
}

/**
 * The camera of a given shape, in the middle of the paper.
 *
 * The frame takes 85 percent of the width of the paper, and the height
 * follows the shape. A camera that is "the same as the paper" is the paper.
 */
export function cameraOfRatio(paper, ratio) {
  if (ratio === "paper") {
    return { x: 0, y: 0, width: paper.width, height: paper.height };
  }
  const found = CAMERA_RATIOS.find(([name]) => name === ratio);
  const shape = found ? found[1] : 16 / 9;
  let width = Math.round(paper.width * 0.85);
  let height = Math.max(16, Math.round(width / shape));
  if (height > paper.height) {
    height = paper.height;
    width = Math.max(16, Math.round(height * shape));
  }
  return { x: Math.round((paper.width - width) / 2), y: Math.round((paper.height - height) / 2), width, height };
}