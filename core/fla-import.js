/**
 * Import a Flash / Animate `.fla` as a TVMini project: a CS5+ ZIP/XFL package,
 * or an older binary `.fla` (see fla-binary.js).
 *
 * `fla-reader.js` reads the package into layers, frames and vector shapes;
 * this file paints those shapes into pictures and lays them out as cells:
 *
 *   - the first scene becomes the project (size, frame rate, background);
 *   - every Flash layer becomes a layer, every Flash folder a folder;
 *   - every keyframe becomes a cell of the layer, held for its length;
 *   - symbols are drawn inside the cell, and a layer whose symbols animate
 *     (or that has a motion tween) gets a cell for every frame that changes;
 *   - fills, strokes, gradients, rectangles and ovals are painted.
 *
 * Not imported (the result carries a warning for each): mask and guide
 * layers, shape tweens, bitmaps, text, sounds, filters and blend modes.
 *
 * Pure JavaScript: runs in the browser and under Node 18+.
 */
import { readFla, frameAt, stitch } from "./fla-reader.js";
import { readBinaryFla } from "./fla-binary-scan.js";
import { encodeRgbaPng } from "./png.js";
import { createGroup, createLayer, normalizeProject, MAX_FPS, MAX_PIXELS, MAX_SIZE, MIN_SIZE, MAX_HOLD } from "./model.js";

/** Cells are whole-canvas pictures, so the number of them is kept in check. */
const CELL_BUDGET = 1500;
const SS = 4; // sub-scanlines per pixel row

/* ───────────────────────── matrices ───────────────────────── */

const IDENTITY = [1, 0, 0, 1, 0, 0];
/** a∘b: apply b first, then a. */
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const det = (m) => m[0] * m[3] - m[1] * m[2];
function invert(m) {
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
const lerpMatrix = (a, b, p) => a.map((v, i) => v + (b[i] - v) * p);

/* ───────────────────────── paths -> polygons ───────────────────────── */

/** Parse the `M L Q Z` path strings of fla-reader into flattened, transformed polylines. */
function flatten(d, m) {
  const polys = [];
  let cur = null;
  let sx = 0, sy = 0, px = 0, py = 0;
  const re = /([MLQZ])|(-?\d+(?:\.\d+)?)/g;
  const tok = d.match(re) || [];
  let i = 0;
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++];
    if (c === "M") {
      px = sx = num(); py = sy = num();
      cur = [apply(m, px, py)]; polys.push({ pts: cur, closed: false });
    } else if (c === "L") {
      px = num(); py = num(); cur.push(apply(m, px, py));
    } else if (c === "Q") {
      const qx = num(), qy = num(), x = num(), y = num();
      const [ax, ay] = apply(m, px, py), [bx, by] = apply(m, qx, qy), [cx, cy] = apply(m, x, y);
      const len = Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by);
      const n = Math.max(4, Math.min(32, Math.ceil(len / 3)));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        cur.push([u * u * ax + 2 * u * t * bx + t * t * cx, u * u * ay + 2 * u * t * by + t * t * cy]);
      }
      px = x; py = y;
    } else if (c === "Z") {
      if (cur) { polys[polys.length - 1].closed = true; px = sx; py = sy; }
    }
  }
  return polys;
}

/* ───────────────────────── scanline filling ───────────────────────── */

function parseColor(hex) {
  const h = String(hex || "#000000").replace("#", "");
  const v = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padStart(6, "0");
  return [parseInt(v.slice(0, 2), 16) || 0, parseInt(v.slice(2, 4), 16) || 0, parseInt(v.slice(4, 6), 16) || 0];
}

/** Colour source for a fill/stroke style: a constant RGBA or a function of the pixel. */
function makePaint(style, m, alpha) {
  if (!style || style.type === "solid") {
    const [r, g, b] = parseColor(style?.color);
    return [r, g, b, (style?.alpha ?? 1) * alpha];
  }
  if (style.type === "linear" || style.type === "radial") {
    const inv = invert(mul(m, style.matrix));
    const stops = style.stops.map((s) => ({ ratio: s.ratio / 255, rgb: parseColor(s.color), a: s.alpha }));
    if (!inv || !stops.length) return [128, 128, 128, alpha];
    return (x, y) => {
      const [gx, gy] = apply(inv, x, y);
      let t = style.type === "linear" ? (gx + 819.2) / 1638.4 : Math.hypot(gx, gy) / 819.2;
      t = Math.min(1, Math.max(0, t));
      let k = 0;
      while (k < stops.length - 1 && t > stops[k + 1].ratio) k++;
      const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
      const span = b.ratio - a.ratio;
      const p = span > 0 ? Math.min(1, Math.max(0, (t - a.ratio) / span)) : 0;
      return [a.rgb[0] + (b.rgb[0] - a.rgb[0]) * p, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * p, a.rgb[2] + (b.rgb[2] - a.rgb[2]) * p, (a.a + (b.a - a.a) * p) * alpha];
    };
  }
  return null; // bitmap fills are not painted
}

function blendPixel(data, o, r, g, b, a) {
  if (a <= 0) return;
  const da = data[o + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  data[o] = (r * a + data[o] * da * (1 - a)) / oa;
  data[o + 1] = (g * a + data[o + 1] * da * (1 - a)) / oa;
  data[o + 2] = (b * a + data[o + 2] * da * (1 - a)) / oa;
  data[o + 3] = oa * 255;
}

/**
 * Fill polygons into an RGBA canvas with 4× vertical / exact horizontal
 * anti-aliasing. `rule` is "evenodd" or "nonzero".
 */
function fillPolygons(cv, polygons, rule, paint) {
  if (!paint) return;
  const { w, h, data } = cv;
  let minY = Infinity, maxY = -Infinity;
  for (const p of polygons) for (const [, y] of (p.pts || p)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (!(maxY > minY)) return;
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
  if (y1 < y0) return;
  const rows = new Array((y1 - y0 + 1) * SS);
  for (const poly of polygons) {
    const pts = poly.pts || poly;
    const n = pts.length;
    if (n < 2) continue;
    const last = poly.pts && poly.closed === false ? n - 1 : n; // an open run has no closing edge
    for (let i = 0; i < last; i++) {
      let [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      if (ay === by) continue;
      let dir = 1;
      if (ay > by) { [ax, ay, bx, by] = [bx, by, ax, ay]; dir = -1; }
      const jStart = Math.max(y0 * SS, Math.ceil(ay * SS - 0.5));
      const jEnd = Math.min((y1 + 1) * SS - 1, Math.ceil(by * SS - 0.5) - 1);
      for (let j = jStart; j <= jEnd; j++) {
        const yc = (j + 0.5) / SS;
        const x = ax + ((yc - ay) * (bx - ax)) / (by - ay);
        (rows[j - y0 * SS] ||= []).push([x, dir]);
      }
    }
  }
  const cov = new Float32Array(w);
  const constant = Array.isArray(paint);
  for (let y = y0; y <= y1; y++) {
    let lo = w, hi = -1;
    for (let k = 0; k < SS; k++) {
      const list = rows[(y - y0) * SS + k];
      if (!list || list.length < 2) continue;
      list.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let i = 0; i < list.length - 1; i++) {
        wind = rule === "evenodd" ? (wind ^ 1) : wind + list[i][1];
        if (!wind) continue;
        const xa = Math.max(0, list[i][0]), xb = Math.min(w, list[i + 1][0]);
        if (xb <= xa) continue;
        const ia = Math.floor(xa), ib = Math.min(w - 1, Math.floor(xb));
        if (ia < lo) lo = ia;
        if (ib > hi) hi = ib;
        for (let x = ia; x <= ib; x++) cov[x] += (Math.min(xb, x + 1) - Math.max(xa, x)) / SS;
      }
    }
    for (let x = lo; x <= hi; x++) {
      const c = Math.min(1, cov[x]);
      cov[x] = 0;
      if (c <= 0) continue;
      const col = constant ? paint : paint(x + 0.5, y + 0.5);
      blendPixel(data, (y * w + x) * 4, col[0], col[1], col[2], col[3] * c);
    }
  }
}

/** Polygons that, filled with the non-zero rule, cover a stroked polyline. All are wound the same way. */
function strokePolygons(polys, width, round) {
  const out = [];
  const half = Math.max(width, 0.6) / 2;
  const circle = (x, y) => {
    const n = half > 6 ? 20 : 10;
    const c = [];
    for (let i = 0; i < n; i++) c.push([x + half * Math.cos((i / n) * 2 * Math.PI), y + half * Math.sin((i / n) * 2 * Math.PI)]);
    return c;
  };
  for (const { pts, closed } of polys) {
    const list = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
    for (let i = 0; i < list.length - 1; i++) {
      const [ax, ay] = list[i], [bx, by] = list[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const nx = (-(by - ay) / len) * half, ny = ((bx - ax) / len) * half;
      out.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]);
    }
    if (round && half > 1) for (const [x, y] of list) out.push(circle(x, y));
  }
  // one orientation for every piece, so overlapping pieces add up instead of cancelling
  for (const p of out) {
    let area = 0;
    for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; area += p[i][0] * q[1] - q[0] * p[i][1]; }
    if (area < 0) p.reverse();
  }
  return out;
}

/* ───────────────────────── frames -> draw lists ───────────────────────── */

const shapeIds = new WeakMap();
let nextShapeId = 1;
const shapeId = (s) => { if (!shapeIds.has(s)) shapeIds.set(s, nextShapeId++); return shapeIds.get(s); };

/** Elements of a frame at time t; a classic motion tween blends the matrix toward the next keyframe. */
function elementsAt(layer, fr, t) {
  if (fr.tween !== "motion") return fr.elements;
  const next = layer.frames.find((f) => f.index >= fr.index + fr.duration);
  if (!next || next.elements.length !== fr.elements.length) return fr.elements;
  const p = Math.min(1, (t - fr.index) / fr.duration);
  return fr.elements.map((el, i) => {
    const to = next.elements[i];
    return to && to.type === el.type && el.matrix && to.matrix ? { ...el, matrix: lerpMatrix(el.matrix, to.matrix, p) } : el;
  });
}

function symbolFrame(el, len, rel, t) {
  if (el.symbolType === "graphic") {
    if (el.loop === "play once") return Math.min(len - 1, el.firstFrame + rel);
    if (el.loop === "single frame") return Math.min(len - 1, el.firstFrame);
    return (el.firstFrame + rel) % len;
  }
  return t % len; // movie clips and buttons run on their own
}

function layerVisible(l) {
  return l.visible && l.type !== "guide" && l.type !== "folder" && l.type !== "mask";
}

/** Flatten what a set of elements shows at time `t` into [{shape, m, alpha}] in painting order. */
function collect(doc, layer, fr, t, m, alpha, out, ctx, depth, elements = elementsAt(layer, fr, t)) {
  if (depth > 12) { ctx.warn("symbols nested more than 12 deep were cut off"); return; }
  const rel = t - fr.index;
  for (const el of elements) {
    switch (el.type) {
      case "shape": out.push({ shape: el, m: mul(m, el.matrix), alpha }); break;
      case "group": collect(doc, layer, fr, t, mul(m, el.matrix), alpha, out, ctx, depth + 1, el.children); break;
      case "symbol": {
        const sym = doc.symbols[el.name];
        if (!sym) { ctx.warn(`symbol "${el.name}" is missing from the library`); break; }
        const tl = sym.timeline;
        const ft = symbolFrame(el, tl.length, rel, t);
        const mm = mul(m, el.matrix);
        for (let i = tl.layers.length - 1; i >= 0; i--) {
          const L = tl.layers[i];
          if (!layerVisible(L)) continue;
          const f = frameAt(L, ft);
          if (f) collect(doc, L, f, ft, mm, alpha * el.alpha, out, ctx, depth + 1);
        }
        break;
      }
      case "bitmap": ctx.warn("bitmaps were not imported"); break;
      case "text": ctx.warn("text was not imported"); break;
      default: ctx.warn(`${el.tag || el.type} objects were not imported`);
    }
  }
}

const matrixKey = (m) => m.map((v) => Math.round(v * 1000)).join(",");
const keyOf = (items) => items.map((i) => `${shapeId(i.shape)}:${matrixKey(i.m)}:${Math.round(i.alpha * 100)}`).join("|");

function rasterize(items, w, h, root) {
  const cv = { w, h, data: new Uint8ClampedArray(w * h * 4) };
  for (const { shape, m: local, alpha } of items) {
    const m = mul(root, local);
    for (const fl of shape.fills) {
      // every edge has its fill on one side, so contours wind consistently: the non-zero rule unites overlaps and keeps holes
      fillPolygons(cv, flatten(fl.d, m).map((p) => p.pts), "nonzero", makePaint(fl.style, m, alpha));
    }
    const scale = Math.sqrt(Math.abs(det(m)));
    for (const sk of shape.strokes) {
      const paint = makePaint(sk.style.paint, m, alpha);
      fillPolygons(cv, strokePolygons(flatten(sk.d, m), sk.style.weight * scale, sk.style.caps !== "none"), "nonzero", paint);
    }
  }
  return cv.data;
}

/* ───────────────────────── project building ───────────────────────── */

/**
 * @param {Uint8Array|ArrayBuffer} bytes  the .fla / .xfl file
 * @param {object} [options={}]  import options
 * @param {boolean} [options.keepVectors=false]  store strokes instead of rasterizing to PNG
 * @returns {Promise<{project: object, warnings: string[]}>}
 */
export async function importFlaBytes(bytes, options = {}) {
  const { keepVectors = false } = options;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const warnings = new Set();
  let doc;
  if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) {
    // an older binary .fla (Flash 5 - CS4)
    const binary = readBinaryFla(u8, stitch);
    doc = binary.doc;
    for (const w of binary.warnings) warnings.add(w);
  } else {
    doc = await readFla(u8);
  }
  const ctx = { warn: (m) => warnings.add(m) };

  if (doc.timelines.length === 0) throw new Error("This Flash file has no timeline.");
  if (doc.timelines.length > 1) warnings.add(`only the first of ${doc.timelines.length} scenes was imported`);
  const tl = doc.timelines[0];

  // the canvas, kept inside the limits of the project
  let scale = 1;
  const big = Math.max(doc.width, doc.height);
  if (big * scale > MAX_SIZE) scale = MAX_SIZE / big;
  if (doc.width * doc.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (doc.width * doc.height));
  const width = Math.max(MIN_SIZE, Math.floor(doc.width * scale));
  const height = Math.max(MIN_SIZE, Math.floor(doc.height * scale));
  if (scale < 1) warnings.add(`the stage was scaled to ${width}x${height}`);
  const root = [scale, 0, 0, scale, 0, 0];

  const fps = Math.min(MAX_FPS, Math.max(1, Math.round(doc.frameRate) || 12));
  const animated = (layer) => layer.frames.some((fr) => fr.tween === "motion" || fr.elements.some((e) => hasMotion(doc, e, 0)));

  /** Work out the cells a layer needs: [{at, hold, items, name}] — pictures come later. */
  const planLayer = (layer, perFrame) => {
    const cells = [];
    for (const fr of layer.frames) {
      if (fr.tween && fr.tween !== "motion") ctx.warn(`${fr.tween} tweens were held as keyframes`);
      const stepped = perFrame && animated(layer);
      const last = fr.index + fr.duration;
      for (let t = fr.index; t < last; t += stepped ? 1 : fr.duration) {
        const items = [];
        collect(doc, layer, fr, t, IDENTITY, 1, items, ctx, 0);
        const span = stepped ? 1 : fr.duration;
        const key = items.length ? keyOf(items) : "";
        const prev = cells[cells.length - 1];
        if (prev && prev.key === key && prev.at + prev.hold === t + 1 && prev.hold + span <= MAX_HOLD) { prev.hold += span; continue; }
        cells.push({ at: t + 1, hold: Math.min(span, MAX_HOLD), items, key, name: t === fr.index ? fr.label : null });
      }
    }
    return cells.filter((c) => c.items.length);
  };

  const sourceLayers = tl.layers;
  let plans = sourceLayers.map((l) => (l.type === "normal" ? planLayer(l, true) : []));
  if (plans.reduce((n, p) => n + p.length, 0) > CELL_BUDGET) {
    warnings.add("the file is long, so animated symbols and tweens were imported as keyframes only");
    plans = sourceLayers.map((l) => (l.type === "normal" ? planLayer(l, false) : []));
  }

  const layers = [];
  const indexOf = new Map(); // flash layer index -> project layer index
  const pictures = new Map(); // cell key -> base64 png (identical cells share one picture)
  sourceLayers.forEach((src, i) => {
    if (src.type === "guide") { warnings.add("guide layers were left out"); return; }
    if (src.type === "mask") { warnings.add("mask layers were left out (the layers they cut are shown whole)"); return; }
    const layer = src.type === "folder" ? createGroup(src.name || "Folder") : createLayer(src.name || `Layer ${i + 1}`);
    layer.visible = src.visible;
    layer.locked = src.locked;
    layer.preBehavior = "none";
    layer.postBehavior = src.type === "folder" ? "hold" : "none";
    const parent = src.parentLayerIndex;
    if (parent !== null && indexOf.has(parent) && layers[indexOf.get(parent)].type === "group") layer.parent = indexOf.get(parent);
    indexOf.set(i, layers.length);
    for (const cell of plans[i]) {
      if (keepVectors) {
        // Store strokes directly — convert items to TVMini stroke format
        const strokes = cell.items.map((item) => {
          if (item.shape && item.shape.fills) {
            // Apply the composed matrix to path coordinates
            const m = item.m;
            const applyMatrix = (pts) => pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

            // Convert shape fills to path strokes
            const shapeStrokes = [];
            for (const fl of item.shape.fills) {
              if (fl.d) {
                const paths = fl.d.split("Z").filter(Boolean).map((p) => applyMatrix(parseSvgPath(p + "Z")));
                shapeStrokes.push({
                  kind: "paths",
                  color: fl.style?.color || "#000000",
                  width: 1,
                  paths,
                  opacity: fl.style?.alpha || 1,
                  blend: "normal",
                });
              }
            }
            for (const sk of item.shape.strokes || []) {
              if (sk.d) {
                shapeStrokes.push({
                  color: sk.style?.paint?.color || "#000000",
                  width: sk.style?.weight || 1,
                  points: applyMatrix(parseSvgPath(sk.d)),
                  opacity: sk.style?.paint?.alpha || 1,
                  blend: "normal",
                });
              }
            }
            return shapeStrokes;
          }
          return [];
        }).flat();

        layer.drawings.push({
          at: cell.at, hold: cell.hold, strokes,
          ...(cell.name ? { name: String(cell.name).slice(0, 80) } : {}),
        });
      } else {
        let data = pictures.get(cell.key);
        if (!data) {
          data = encodeRgbaPng(width, height, rasterize(cell.items, width, height, root)).toString("base64");
          pictures.set(cell.key, data);
        }
        layer.drawings.push({
          at: cell.at, hold: cell.hold, strokes: [],
          ...(cell.name ? { name: String(cell.name).slice(0, 80) } : {}),
          image: { data, width, height },
        });
      }
    }
    layers.push(layer);
  });
  if (!layers.length) layers.push(createLayer("Layer 1"));

  const project = normalizeProject({
    format: "tvmini", version: 3, width, height,
    background: /^#[0-9a-f]{6}$/i.test(doc.background) ? doc.background : "#ffffff",
    image: null, fps, startFrame: 1, currentLayer: 0, currentFrame: 1, loop: true, layers,
  });
  return { project, warnings: [...warnings] };
}

/** Parse a simplified SVG path string (M L Q Z) to [[x,y],...] points. */
function parseSvgPath(d) {
  const points = [];
  const re = /([MLQZ])|(-?\d+(?:\.\d+)?)/g;
  const tok = d.match(re) || [];
  let i = 0;
  const num = () => parseFloat(tok[i++]);
  let px = 0, py = 0;
  while (i < tok.length) {
    const c = tok[i++];
    if (c === "M") { px = num(); py = num(); points.push([px, py]); }
    else if (c === "L") { px = num(); py = num(); points.push([px, py]); }
    else if (c === "Q") {
      const qx = num(), qy = num(), x = num(), y = num();
      const len = Math.hypot(qx - px, qy - py) + Math.hypot(x - qx, y - qy);
      const n = Math.max(4, Math.min(32, Math.ceil(len / 3)));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        points.push([u * u * px + 2 * u * t * qx + t * t * x, u * u * py + 2 * u * t * qy + t * t * y]);
      }
      px = x; py = y;
    }
    else if (c === "Z") break;
  }
  return points;
}

/** Does this element contain a symbol whose own timeline moves? */
function hasMotion(doc, el, depth) {
  if (depth > 8) return false;
  if (el.type === "group") return el.children.some((c) => hasMotion(doc, c, depth + 1));
  if (el.type !== "symbol") return false;
  const sym = doc.symbols[el.name];
  if (!sym) return false;
  if (el.symbolType !== "graphic" || el.loop !== "single frame") {
    if (sym.timeline.length > 1) return true;
  }
  return sym.timeline.layers.some((L) => L.frames.some((fr) => fr.tween === "motion" || fr.elements.some((e) => hasMotion(doc, e, depth + 1))));
}
