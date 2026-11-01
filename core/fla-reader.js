/**
 * fla-reader.js — clean-room reader for Adobe Flash / Animate .fla (XFL) files.
 * ES module, no dependencies. Works in browsers and Node 18+ (needs DecompressionStream).
 *
 * Supported input:
 *   - .fla saved by Flash CS5+ / Animate  (a ZIP that contains DOMDocument.xml)  ✔
 *   - .xfl                                (same ZIP, or a folder: use readXflFolder) ✔
 *   - old binary .fla (CS4 and earlier, OLE "D0 CF 11 E0" header)                 ✘ -> clear error
 *     (Umoupen has the same limit: it asks you to re-save as XFL in Animate.)
 *
 * (No DOMParser needed: a small XML parser is built in, so it also runs under Node.)
 *
 * Usage:
 *   import { readFla, renderFrameSVG } from './fla-reader.js';
 *   const doc = await readFla(await file.arrayBuffer());
 *   // doc.width, doc.height, doc.frameRate, doc.timelines[0].layers[i].frames[j].elements ...
 *   const svg = renderFrameSVG(doc, 0, 12);   // timeline 0, frame 12 -> SVG string
 */

/* ───────────────────────── ZIP ───────────────────────── */

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (end-of-central-directory not found).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    entries.set(name, { method, csize, lho, utf8: !!(flags & 0x800) });
    p += 46 + nameLen + extraLen + commLen;
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) throw new Error('Missing file in package: ' + name);
      const q = e.lho;
      const start = q + 30 + dv.getUint16(q + 26, true) + dv.getUint16(q + 28, true);
      const raw = u8.subarray(start, start + e.csize);
      if (e.method === 0) return raw;
      if (e.method === 8) return inflateRaw(raw);
      throw new Error('Unsupported ZIP compression method ' + e.method);
    },
    async text(name) { return dec.decode(await this.read(name)); },
  };
}

/** Wrap a folder (Map<path, Uint8Array|string> or object) so it looks like a zip. */
export function readXflFolder(files) {
  const map = files instanceof Map ? files : new Map(Object.entries(files));
  const enc = new TextEncoder(), dec = new TextDecoder();
  return {
    names: [...map.keys()],
    has: (n) => map.has(n),
    async read(n) { const v = map.get(n); if (v == null) throw new Error('Missing: ' + n); return typeof v === 'string' ? enc.encode(v) : v; },
    async text(n) { const v = map.get(n); if (v == null) throw new Error('Missing: ' + n); return typeof v === 'string' ? v : dec.decode(v); },
  };
}

/* ───────────────────────── XML helpers ───────────────────────── */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : (ENT[e] ?? m))));

class XEl {
  constructor(name, attrs) {
    this.localName = name.includes(':') ? name.split(':').pop() : name;
    this.attrs = attrs; this.children = []; this.textContent = '';
  }
  hasAttribute(a) { return Object.prototype.hasOwnProperty.call(this.attrs, a); }
  getAttribute(a) { return this.hasAttribute(a) ? this.attrs[a] : null; }
  get firstElementChild() { return this.children[0] || null; }
}

/** Tiny XML parser (elements, attributes, text, CDATA, entities). Returns the root element. */
export function parseXml(src) {
  const top = { children: [] };
  const stack = [top];
  const tag = /<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const cur = stack[stack.length - 1];
    if (lt > i && cur instanceof XEl) cur.textContent += unesc(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e < 0) throw new Error('Malformed XML'); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); if (e < 0) throw new Error('Malformed XML'); if (cur instanceof XEl) cur.textContent += src.slice(lt + 9, e); i = e + 3; continue; }
    if (src[lt + 1] === '?') { const e = src.indexOf('?>', lt); if (e < 0) throw new Error('Malformed XML'); i = e + 2; continue; }
    if (src[lt + 1] === '!') { const e = src.indexOf('>', lt); if (e < 0) throw new Error('Malformed XML'); i = e + 1; continue; }
    if (src[lt + 1] === '/') { const e = src.indexOf('>', lt); if (e < 0 || stack.length < 2) throw new Error('Malformed XML'); stack.pop(); i = e + 1; continue; }
    tag.lastIndex = lt;
    const m = tag.exec(src);
    if (!m) throw new Error('Malformed XML near offset ' + lt);
    const attrs = {};
    for (const a of m[2].matchAll(attr)) attrs[a[1]] = unesc(a[2] ?? a[3] ?? '');
    const el = new XEl(m[1], attrs);
    cur.children.push(el);
    if (!m[3]) stack.push(el);
    i = tag.lastIndex;
  }
  if (stack.length !== 1 || !top.children[0]) throw new Error('Malformed XML');
  return top.children[0];
}
const defaultParse = (s) => ({ documentElement: parseXml(s) });
const kids = (el, name) => el ? [...el.children].filter((c) => c.localName === name) : [];
const kid = (el, name) => kids(el, name)[0] || null;
const num = (el, a, d = 0) => (el && el.hasAttribute(a) ? parseFloat(el.getAttribute(a)) : d);
const str = (el, a, d = '') => (el && el.hasAttribute(a) ? el.getAttribute(a) : d);

/* ───────────────────────── Edge decoding ───────────────────────── */
// Edge strings are paths in twips (1/20 px):  !x y = moveTo, |x y or /x y = lineTo,
// [cx cy x y (or ]) = quadratic curve. Numbers may be decimal or "#IIIIII.FF" (signed 24.8 fixed).

const TOKEN = /[!|/[\]]|S\d+|#[0-9A-Fa-f]+(?:\.[0-9A-Fa-f]+)?|-?\d+(?:\.\d+)?/g;

function parseNum(t) {
  if (t[0] === '#') {
    const [i, f = '0'] = t.slice(1).split('.');
    const v = (parseInt(i, 16) * 256 + parseInt(f.padEnd(2, '0').slice(0, 2), 16)) | 0;
    return v / 256 / 20;
  }
  return parseFloat(t) / 20;
}

export function decodeEdges(s) {
  const toks = s.match(TOKEN) || [];
  const segs = [];
  let i = 0, cx = 0, cy = 0;
  const n = () => parseNum(toks[i++]);
  while (i < toks.length) {
    const t = toks[i++];
    if (t === '!') { cx = n(); cy = n(); }
    else if (t === '|' || t === '/') { const x = n(), y = n(); segs.push({ x1: cx, y1: cy, x2: x, y2: y }); cx = x; cy = y; }
    else if (t === '[' || t === ']') { const qx = n(), qy = n(), x = n(), y = n(); segs.push({ x1: cx, y1: cy, qx, qy, x2: x, y2: y }); cx = x; cy = y; }
    // "S<n>" selection markers and anything else are ignored
  }
  return segs;
}

export const rev = (s) => (s.qx !== undefined
  ? { x1: s.x2, y1: s.y2, qx: s.qx, qy: s.qy, x2: s.x1, y2: s.y1 }
  : { x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1 });
const key = (x, y) => x.toFixed(2) + ',' + y.toFixed(2);
export const f = (v) => +v.toFixed(2);
const segTo = (s) => (s.qx !== undefined ? `Q${f(s.qx)} ${f(s.qy)} ${f(s.x2)} ${f(s.y2)}` : `L${f(s.x2)} ${f(s.y2)}`);

/** Chain loose segments into sub-paths (closing when they return to the start). */
export function stitch(segs, close) {
  const byStart = new Map();
  for (const s of segs) { const k = key(s.x1, s.y1); (byStart.get(k) || byStart.set(k, []).get(k)).push(s); }
  const used = new Set();
  let d = '';
  for (const first of segs) {
    if (used.has(first)) continue;
    used.add(first);
    let cur = first;
    d += `M${f(cur.x1)} ${f(cur.y1)}${segTo(cur)}`;
    const startKey = key(cur.x1, cur.y1);
    for (;;) {
      const k = key(cur.x2, cur.y2);
      if (close && k === startKey) { d += 'Z'; break; }
      const next = (byStart.get(k) || []).find((c) => !used.has(c));
      if (!next) break;
      used.add(next); d += segTo(next); cur = next;
    }
  }
  return d;
}

/* ───────────────────────── Element parsing ───────────────────────── */

function parseMatrix(el) {
  const m = kid(kid(el, 'matrix'), 'Matrix');
  return [num(m, 'a', 1), num(m, 'b', 0), num(m, 'c', 0), num(m, 'd', 1), num(m, 'tx', 0), num(m, 'ty', 0)];
}

function parseColorish(el) {
  const sc = kid(el, 'SolidColor');
  if (sc) return { type: 'solid', color: str(sc, 'color', '#000000'), alpha: num(sc, 'alpha', 1) };
  for (const [tag, type] of [['LinearGradient', 'linear'], ['RadialGradient', 'radial']]) {
    const g = kid(el, tag);
    if (g) return {
      type, matrix: parseMatrix(g),
      stops: kids(g, 'GradientEntry').map((e) => ({ color: str(e, 'color', '#000000'), alpha: num(e, 'alpha', 1), ratio: num(e, 'ratio', 0) })),
    };
  }
  const bf = kid(el, 'BitmapFill');
  if (bf) return { type: 'bitmap', bitmap: str(bf, 'bitmapPath'), matrix: parseMatrix(bf) };
  return { type: 'solid', color: '#000000', alpha: 1 };
}

function parseShape(el) {
  const fills = new Map(), strokes = new Map();
  for (const fs of kids(kid(el, 'fills'), 'FillStyle')) fills.set(str(fs, 'index'), parseColorish(fs));
  for (const ss of kids(kid(el, 'strokes'), 'StrokeStyle')) {
    const s = kid(ss, 'SolidStroke') || kid(ss, 'DashedStroke') || kid(ss, 'RaggedStroke') || ss.firstElementChild;
    strokes.set(str(ss, 'index'), {
      weight: num(s, 'weight', 1), caps: str(s, 'caps', 'round'), joints: str(s, 'joints', 'round'),
      paint: parseColorish(kid(s, 'fill') || s),
    });
  }
  const fillSegs = new Map(), strokeSegs = new Map();
  for (const e of kids(kid(el, 'edges'), 'Edge')) {
    const segs = decodeEdges(str(e, 'edges'));
    const f0 = str(e, 'fillStyle0'), f1 = str(e, 'fillStyle1'), st = str(e, 'strokeStyle');
    const push = (m, k, s) => (m.get(k) || m.set(k, []).get(k)).push(...s);
    if (f1) push(fillSegs, f1, segs);
    if (f0) push(fillSegs, f0, segs.map(rev).reverse());
    if (st) push(strokeSegs, st, segs);
  }
  return {
    type: 'shape',
    matrix: parseMatrix(el),
    fills: [...fillSegs].map(([idx, segs]) => ({ style: fills.get(idx) || { type: 'solid', color: '#000000', alpha: 1 }, d: stitch(segs, true) })),
    strokes: [...strokeSegs].map(([idx, segs]) => ({ style: strokes.get(idx) || { weight: 1, paint: { type: 'solid', color: '#000000', alpha: 1 } }, d: stitch(segs, false) })),
  };
}


/** Rectangle and oval "object drawing" primitives -> a shape with one fill and one stroke. */
function parsePrimitive(el) {
  const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'objectWidth'), h = num(el, 'objectHeight');
  let d;
  if (el.localName === 'DOMRectangleObject') {
    const r = Math.min(num(el, 'topLeftRadius'), w / 2, h / 2);
    d = r > 0
      ? `M${f(x + r)} ${f(y)}L${f(x + w - r)} ${f(y)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}L${f(x + w)} ${f(y + h - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}L${f(x + r)} ${f(y + h)}Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - r)}L${f(x)} ${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Z`
      : `M${f(x)} ${f(y)}L${f(x + w)} ${f(y)}L${f(x + w)} ${f(y + h)}L${f(x)} ${f(y + h)}Z`;
  } else {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, N = 16;
    d = '';
    for (let i = 0; i < N; i++) { // 16 quadratic pieces approximate the ellipse closely
      const a0 = (i / N) * 2 * Math.PI, a1 = ((i + 1) / N) * 2 * Math.PI, am = (a0 + a1) / 2, k = 1 / Math.cos(Math.PI / N);
      if (!i) d += `M${f(cx + rx * Math.cos(a0))} ${f(cy + ry * Math.sin(a0))}`;
      d += `Q${f(cx + rx * k * Math.cos(am))} ${f(cy + ry * k * Math.sin(am))} ${f(cx + rx * Math.cos(a1))} ${f(cy + ry * Math.sin(a1))}`;
    }
    d += 'Z';
  }
  const fillEl = kid(kid(el, 'fill'), 'FillStyle');
  const strokeEl = kid(kid(el, 'stroke'), 'StrokeStyle');
  const ss = strokeEl && (kid(strokeEl, 'SolidStroke') || strokeEl.firstElementChild);
  return {
    type: 'shape', matrix: parseMatrix(el),
    fills: fillEl ? [{ style: parseColorish(fillEl), d }] : [],
    strokes: ss ? [{ style: { weight: num(ss, 'weight', 1), caps: str(ss, 'caps', 'round'), joints: str(ss, 'joints', 'round'), paint: parseColorish(kid(ss, 'fill') || ss) }, d }] : [],
  };
}

function parseElement(el) {
  switch (el.localName) {
    case 'DOMShape': return parseShape(el);
    case 'DOMSymbolInstance': return {
      type: 'symbol', name: str(el, 'libraryItemName'), instanceName: str(el, 'name'),
      symbolType: str(el, 'symbolType', 'graphic'), firstFrame: num(el, 'firstFrame', 0),
      loop: str(el, 'loop', 'loop'), matrix: parseMatrix(el),
      alpha: num(kid(kid(el, 'color'), 'Color'), 'alphaMultiplier', 1),
    };
    case 'DOMBitmapInstance': return { type: 'bitmap', name: str(el, 'libraryItemName'), matrix: parseMatrix(el) };
    case 'DOMGroup': return { type: 'group', children: [...(kid(el, 'members')?.children || [])].map(parseElement), matrix: parseMatrix(el) };
    case 'DOMRectangleObject': case 'DOMOvalObject': return parsePrimitive(el);
    case 'DOMStaticText': case 'DOMDynamicText': case 'DOMInputText': return {
      type: 'text', matrix: parseMatrix(el), left: num(el, 'left'), width: num(el, 'width'), height: num(el, 'height'),
      runs: kids(kid(el, 'textRuns'), 'DOMTextRun').map((r) => {
        const a = kid(r, 'textAttrs')?.firstElementChild;
        return { text: kid(r, 'characters')?.textContent || '', size: num(a, 'size', 12), color: str(a, 'fillColor', '#000000'), face: str(a, 'face', 'sans-serif') };
      }),
    };
    default: return { type: 'unsupported', tag: el.localName };
  }
}

function parseTimeline(tl) {
  const layers = kids(kid(tl, 'layers'), 'DOMLayer').map((l) => ({
    name: str(l, 'name'), color: str(l, 'color'), type: str(l, 'layerType', 'normal'),
    visible: str(l, 'visible', 'true') !== 'false', locked: str(l, 'locked') === 'true',
    parentLayerIndex: l.hasAttribute('parentLayerIndex') ? num(l, 'parentLayerIndex') : null,
    frames: kids(kid(l, 'frames'), 'DOMFrame').map((fr) => ({
      index: num(fr, 'index'), duration: num(fr, 'duration', 1), keyMode: num(fr, 'keyMode'),
      tween: str(fr, 'tweenType') || null, label: str(fr, 'name') || null,
      elements: [...(kid(fr, 'elements')?.children || [])].map(parseElement),
    })),
  }));
  const length = Math.max(1, ...layers.flatMap((l) => l.frames.map((fr) => fr.index + fr.duration)));
  return { name: str(tl, 'name'), layers, length };
}

/* ───────────────────────── Main entry ───────────────────────── */

export async function readFla(buffer, { parseXML = defaultParse } = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0)
    throw new Error('Binary FLA (Flash CS4 or older) is not supported. Open it in Adobe Animate and save as a CS5+ .fla or .xfl first.');
  const pkg = (u8[0] === 0x50 && u8[1] === 0x4B) ? await readZip(u8) : null;
  if (!pkg) throw new Error('Not an XFL/Animate package (expected a ZIP with DOMDocument.xml).');
  return readPackage(pkg, parseXML);
}

export async function readPackage(pkg, parseXML = defaultParse) {
  if (!pkg.has('DOMDocument.xml')) throw new Error('DOMDocument.xml not found in package.');
  const root = parseXML(await pkg.text('DOMDocument.xml')).documentElement;
  const doc = {
    width: num(root, 'width', 550), height: num(root, 'height', 400),
    frameRate: num(root, 'frameRate', 24), background: str(root, 'backgroundColor', '#FFFFFF'),
    timelines: kids(kid(root, 'timelines'), 'DOMTimeline').map(parseTimeline),
    symbols: {}, bitmaps: {},
  };
  for (const inc of kids(kid(root, 'symbols'), 'Include')) {
    const href = str(inc, 'href');
    const path = 'LIBRARY/' + href;
    if (!pkg.has(path)) continue;
    const sym = parseXML(await pkg.text(path)).documentElement;
    const name = str(sym, 'name') || href.replace(/\.xml$/, '');
    doc.symbols[name] = { name, type: str(sym, 'symbolType', 'graphic'), timeline: parseTimeline(kid(kid(sym, 'timeline'), 'DOMTimeline')) };
  }
  for (const b of kids(kid(root, 'media'), 'DOMBitmapItem')) {
    const name = str(b, 'name');
    // Embedded pixel data is stored in LIBRARY/<href> (png/jpg) or bin/*.dat (Animate's own container).
    const href = str(b, 'href'), dat = str(b, 'bitmapDataHRef');
    const file = href && pkg.has('LIBRARY/' + href) ? 'LIBRARY/' + href : dat && pkg.has('bin/' + dat) ? 'bin/' + dat : null;
    doc.bitmaps[name] = { name, width: num(b, 'frameRight') / 20, height: num(b, 'frameBottom') / 20, file, read: file ? () => pkg.read(file) : null };
  }
  return doc;
}

/* ───────────────────────── Frame lookup + SVG renderer ───────────────────────── */

export const frameAt = (layer, t) => layer.frames.find((fr) => t >= fr.index && t < fr.index + fr.duration) || null;

const mtx = (m) => `matrix(${m.map((v) => +v.toFixed(5)).join(' ')})`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function paint(p, defs, id) {
  if (p.type === 'solid') return { fill: p.color, opacity: p.alpha };
  if (p.type === 'linear' || p.type === 'radial') {
    const stops = p.stops.map((s) => `<stop offset="${s.ratio / 255}" stop-color="${s.color}" stop-opacity="${s.alpha}"/>`).join('');
    const gid = 'g' + id;
    // Flash gradient space is a 1638.4-unit box centred on the origin, mapped by the fill matrix.
    defs.push(p.type === 'linear'
      ? `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="-819.2" x2="819.2" gradientTransform="${mtx(p.matrix)}">${stops}</linearGradient>`
      : `<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" r="819.2" gradientTransform="${mtx(p.matrix)}">${stops}</radialGradient>`);
    return { fill: `url(#${gid})`, opacity: 1 };
  }
  return { fill: '#888', opacity: 1 }; // bitmap fills: placeholder
}

function renderElement(doc, el, t, defs, ctr, depth, rel = t) {
  if (depth > 12) return '';
  switch (el.type) {
    case 'shape': {
      const out = [];
      for (const fl of el.fills) { const p = paint(fl.style, defs, ctr.n++); out.push(`<path d="${fl.d}" fill="${p.fill}" fill-opacity="${p.opacity}" fill-rule="evenodd"/>`); }
      for (const sk of el.strokes) { const p = paint(sk.style.paint, defs, ctr.n++); out.push(`<path d="${sk.d}" fill="none" stroke="${p.fill}" stroke-opacity="${p.opacity}" stroke-width="${sk.style.weight}" stroke-linecap="${sk.style.caps === 'none' ? 'butt' : sk.style.caps}" stroke-linejoin="${sk.style.joints || 'round'}"/>`); }
      return `<g transform="${mtx(el.matrix)}">${out.join('')}</g>`;
    }
    case 'group': return `<g transform="${mtx(el.matrix)}">${el.children.map((c) => renderElement(doc, c, t, defs, ctr, depth + 1)).join('')}</g>`;
    case 'symbol': {
      const sym = doc.symbols[el.name];
      if (!sym) return '';
      const len = sym.timeline.length;
      const ft = el.symbolType === 'graphic'
        ? (el.loop === 'play once' ? Math.min(len - 1, el.firstFrame + rel) : el.loop === 'single frame' ? el.firstFrame : (el.firstFrame + rel) % len)
        : t % len;
      return `<g transform="${mtx(el.matrix)}" opacity="${el.alpha}">${renderTimeline(doc, sym.timeline, ft, defs, ctr, depth + 1)}</g>`;
    }
    case 'text': return `<g transform="${mtx(el.matrix)}">${el.runs.map((r, i) => `<text x="${el.left}" y="${r.size * (i + 1)}" font-size="${r.size}" font-family="${esc(r.face)}" fill="${r.color}">${esc(r.text)}</text>`).join('')}</g>`;
    default: return '';
  }
}

function renderTimeline(doc, tl, t, defs, ctr, depth) {
  const out = [];
  for (let i = tl.layers.length - 1; i >= 0; i--) { // first layer in XML is the top one
    const L = tl.layers[i];
    if (!L.visible || L.type === 'guide' || L.type === 'folder' || L.type === 'mask') continue;
    const fr = frameAt(L, t);
    if (fr) for (const el of fr.elements) out.push(renderElement(doc, el, t, defs, ctr, depth, t - fr.index));
  }
  return out.join('');
}

export function renderFrameSVG(doc, timelineIndex = 0, t = 0, { background = true } = {}) {
  const defs = [], ctr = { n: 0 };
  const body = renderTimeline(doc, doc.timelines[timelineIndex], t, defs, ctr, 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '')
    + (background ? `<rect width="100%" height="100%" fill="${doc.background}"/>` : '') + body + '</svg>';
}
