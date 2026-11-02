/**
 * Draw a laid-out time sheet on a canvas.
 *
 * The layout in `core/time-sheet-image.js` says where everything goes; this
 * module only paints it: white paper, black rules, a light band behind the
 * column names, the frame numbers down the left side, the drawing numbers
 * with their hold lines, and the camera column.
 *
 * The page is painted at `scale` times the 150 dpi grid of the layout, so the
 * default 2 gives an A4 page of 3506 x 4960 pixels (300 dpi): lines and
 * numbers stay sharp when the image is zoomed or printed.
 */
import { TIME_SHEET_TEXT } from "./core/time-sheet-image.js";

const INK = "#111111";
const MID = "#909090";
const SOFT = "#d4d4d4";
const LABEL = "#555555";
const BAND = "#f3f3f3";

function fontOf(size, weight = 600) {
  return `${weight} ${size}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
}

function stroke(ctx, x1, y1, x2, y2, width = 1, color = INK) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function box(ctx, x, y, width, height, lineWidth = 1, color = INK, fill = null) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, width, height);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(x, y, width, height);
}

/** The text and the size that fit `maxWidth`, shrinking once then cutting. */
function fitText(ctx, value, maxWidth, size, weight = 600, floor = 8) {
  const text = String(value ?? "");
  ctx.font = fontOf(size, weight);
  if (!maxWidth || ctx.measureText(text).width <= maxWidth) return { text, size };
  const smaller = Math.max(floor, Math.floor((size * maxWidth) / Math.max(1, ctx.measureText(text).width)));
  ctx.font = fontOf(smaller, weight);
  if (ctx.measureText(text).width <= maxWidth) return { text, size: smaller };
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return { text: cut ? `${cut}…` : "", size: smaller };
}

function drawText(ctx, value, x, y, options = {}) {
  const {
    size = 14,
    weight = 600,
    align = "center",
    baseline = "middle",
    color = INK,
    maxWidth = 0,
  } = options;
  if (value === null || value === undefined || value === "") return;
  const fitted = fitText(ctx, value, maxWidth, size, weight);
  if (!fitted.text) return;
  ctx.font = fontOf(fitted.size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(fitted.text, x, y);
}

/* ------------------------------------------------------------------ header */

function drawHeader(ctx, page) {
  const header = page.header;
  box(ctx, header.x, header.y, header.width, header.height, 1.6, INK, "#ffffff");

  // The first row of fields is separated from the second one.
  stroke(ctx, header.x, header.y + header.rowHeight, header.x + header.width, header.y + header.rowHeight, 1.2);

  const rows = new Map();
  for (const cell of header.cells) {
    const row = Math.round((cell.y - header.y) / header.rowHeight);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(cell);
  }
  for (const cells of rows.values()) {
    for (const cell of cells.slice(1)) {
      stroke(ctx, cell.x, cell.y, cell.x, cell.y + cell.height, 1.2);
    }
  }

  for (const cell of header.cells) {
    drawText(ctx, cell.label, cell.x + 14, cell.y + 20, {
      size: TIME_SHEET_TEXT.headerLabel,
      weight: 600,
      align: "left",
      color: LABEL,
    });
    const size = cell.key === "title" ? TIME_SHEET_TEXT.headerTitle : TIME_SHEET_TEXT.headerValue;
    drawText(ctx, cell.value, cell.x + 14, cell.y + cell.height / 2 + 22, {
      size,
      weight: 700,
      align: "left",
      maxWidth: cell.width - 28,
    });
  }
}

/* -------------------------------------------------------------- name strip */

function drawNameStrip(ctx, page) {
  const strip = {
    x: page.frameColumn.x,
    y: page.frameColumn.header.y,
    width: page.body.width,
    height: page.frameColumn.header.height,
  };
  box(ctx, strip.x, strip.y, strip.width, strip.height, 1.4, INK, BAND);

  drawText(ctx, page.frameColumn.label, page.frameColumn.header.x + page.frameColumn.width / 2, strip.y + 26, {
    size: TIME_SHEET_TEXT.nameStrip,
    weight: 700,
    color: LABEL,
  });
  stroke(ctx, page.frameColumn.x + page.frameColumn.width, strip.y, page.frameColumn.x + page.frameColumn.width, strip.y + strip.height, 1.2);

  for (const slot of page.slots) {
    stroke(ctx, slot.x + slot.width, strip.y, slot.x + slot.width, strip.y + strip.height, 1.2);
    drawText(ctx, slot.letter, slot.x + slot.width / 2, strip.y + 22, {
      size: TIME_SHEET_TEXT.letter,
      weight: 700,
      maxWidth: slot.width - 8,
    });
    drawText(ctx, slot.name, slot.x + slot.width / 2, strip.y + 47, {
      size: TIME_SHEET_TEXT.layerName,
      weight: 500,
      color: LABEL,
      maxWidth: slot.width - 8,
    });
  }

  if (page.camera) {
    stroke(ctx, page.camera.x, strip.y, page.camera.x, strip.y + strip.height, 1.4);
    drawText(ctx, page.camera.label, page.camera.x + page.camera.width / 2, strip.y + 26, {
      size: TIME_SHEET_TEXT.nameStrip,
      weight: 700,
      color: LABEL,
    });
  }
}

/* ------------------------------------------------------------------- rows */

function drawRows(ctx, page) {
  const body = page.body;

  for (const row of page.rows) {
    const width = row.second ? 1.5 : row.major ? 0.9 : 0.55;
    const color = row.second ? INK : row.major ? MID : SOFT;
    stroke(ctx, body.x, row.y, body.x + body.width, row.y, width, color);
  }
  const last = page.rows[page.rows.length - 1];
  stroke(ctx, body.x, last.y + last.height, body.x + body.width, last.y + last.height, 1.5);

  // The columns stand on every page, from the strip to the last row.
  const bottom = last.y + last.height;
  stroke(ctx, body.x, body.y, body.x, bottom, 1.6);
  stroke(ctx, page.frameColumn.x + page.frameColumn.width, body.y, page.frameColumn.x + page.frameColumn.width, bottom, 1.4);
  for (const slot of page.slots) {
    stroke(ctx, slot.x + slot.width, body.y, slot.x + slot.width, bottom, 1.1);
  }
  if (page.camera) {
    stroke(ctx, page.camera.x, body.y, page.camera.x, bottom, 1.4);
  }
  stroke(ctx, body.x + body.width, body.y, body.x + body.width, bottom, 1.6);

  // The frame number of every row, with the first frame of each second in
  // bold so the eye can find the beat.
  for (const row of page.rows) {
    drawText(ctx, row.frame, page.frameColumn.x + page.frameColumn.width / 2, row.y + row.height / 2, {
      size: TIME_SHEET_TEXT.frameNumber,
      weight: row.second ? 700 : 500,
      color: row.second ? INK : LABEL,
      maxWidth: page.frameColumn.width - 8,
    });
  }
}

/* ------------------------------------------------------------------ cells */

function drawCells(ctx, page) {
  const rowHeight = page.body.height / Math.max(1, page.rows.length);
  for (const column of page.columns) {
    const center = column.x + column.width / 2;
    for (const cell of column.cells) {
      const top = column.y + cell.row * rowHeight;
      drawText(ctx, cell.label, center, top + rowHeight / 2, {
        size: TIME_SHEET_TEXT.cell,
        weight: 700,
        maxWidth: column.width - 6,
      });
      if (cell.holdRows > 0) {
        const from = top + rowHeight - 1;
        const to = column.y + (cell.row + cell.holdRows + 1) * rowHeight - 2;
        if (to > from) stroke(ctx, center, from, center, to, 1.5);
      }
    }
  }
}

/* ----------------------------------------------------------------- camera */

function drawCamera(ctx, page) {
  if (!page.camera) return;
  const camera = page.camera;
  stroke(ctx, camera.x, camera.y, camera.x, camera.y + camera.height, 1.4);

  const rowHeight = page.body.height / Math.max(1, page.rows.length);
  const guide = camera.x + 18;
  const keys = camera.keys;
  if (!keys.length) return;

  const yOf = (key) => camera.y + key.row * rowHeight + rowHeight / 2;
  const firstY = yOf(keys[0]);
  const lastY = yOf(keys[keys.length - 1]);
  if (camera.continues) stroke(ctx, guide, camera.y, guide, firstY, 1.2);
  if (keys.length > 1) stroke(ctx, guide, firstY, guide, lastY, 1.2);

  for (const key of keys) {
    const y = yOf(key);
    ctx.beginPath();
    ctx.fillStyle = INK;
    ctx.arc(guide, y, 3, 0, Math.PI * 2);
    ctx.fill();
    drawText(ctx, key.label, guide + 12, y, {
      size: TIME_SHEET_TEXT.camera,
      weight: 600,
      align: "left",
      maxWidth: camera.width - 34,
    });
  }
}

/* ----------------------------------------------------------------- footer */

function drawFooter(ctx, page, layout) {
  const footer = page.footer;
  stroke(ctx, footer.x, footer.y, footer.x + footer.width, footer.y, 1.4);
  drawText(ctx, footer.left || "TVMini time sheet", footer.x + 6, footer.y + footer.height / 2 + 2, {
    size: TIME_SHEET_TEXT.footer,
    weight: 500,
    align: "left",
    color: LABEL,
    maxWidth: footer.width - 360,
  });
  drawText(ctx, footer.right, footer.x + footer.width - 6, footer.y + footer.height / 2 + 2, {
    size: TIME_SHEET_TEXT.footer,
    weight: 600,
    align: "right",
    color: LABEL,
  });
}

/* ------------------------------------------------------------------ paint */

export function renderTimeSheetPage(layout, pageIndex = 0, options = {}) {
  const page = layout.pages[pageIndex];
  if (!page) throw new Error(`the time sheet has no page ${pageIndex + 1}`);
  const scale = Math.max(0.25, Number(options.scale) || 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(layout.page.width * scale);
  canvas.height = Math.round(layout.page.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser cannot draw the time sheet");

  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineJoin = "miter";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, layout.page.width, layout.page.height);

  drawHeader(ctx, page);
  drawNameStrip(ctx, page);
  drawRows(ctx, page);
  drawCells(ctx, page);
  drawCamera(ctx, page);
  drawFooter(ctx, page, layout);

  // The page as a whole, so the sheet has one clear edge.
  box(ctx, layout.page.margin, layout.page.margin, layout.page.width - layout.page.margin * 2, layout.page.height - layout.page.margin * 2, 1.6);
  ctx.restore();
  return canvas;
}

/** Every page of the sheet, ready to be turned into PNG bytes. */
export function renderTimeSheet(layout, options = {}) {
  return layout.pages.map((_, index) => renderTimeSheetPage(layout, index, options));
}

/** The PNG bytes of one painted page. */
export function timeSheetPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("the time sheet could not be turned into a PNG"));
        return;
      }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png");
  });
}
