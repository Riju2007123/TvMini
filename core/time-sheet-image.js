/**
 * The layout of a drawn time sheet (an exposure sheet).
 *
 * A time sheet is a portrait A4 page: the frames run down the page, one row
 * for each frame, and the drawing layers stand as columns across it. A cell is
 * called by its number in the row where it starts, and a line runs down that
 * column for as long as the drawing is held. The page carries a header with
 * the title, the episode, the cut, the duration, the author, the date and the
 * page number, the way the sheets of a TV cut do.
 *
 * The numbers here are the units of a page printed at 150 dpi - the same grid
 * the Auto Sheet site uses (1753 x 2480 pixels for A4) - so a renderer can
 * paint the page at any multiple of that size. This module holds no canvas
 * and no DOM: it only says where every line and every number goes, which
 * makes the geometry testable on its own.
 *
 * A cut that is longer than a page is split into pages on whole seconds, and
 * a cut with more layers than a page can hold is split into groups of
 * columns. The pages are numbered across both splits, so page 1 is the top
 * of the cut and the last page is its tail.
 */
import { childrenOf } from "../timeline.js";
import { columnName, layerCells, sheetLength } from "./timesheet.js";

/** A4 portrait at 150 dpi, the page the Auto Sheet site prints on. */
export const TIME_SHEET_PAGE = {
  width: 1753,
  height: 2480,
  margin: 36,
  headerHeight: 280,
  gap: 14,
  nameStripHeight: 64,
  frameColumnWidth: 62,
  cameraColumnWidth: 140,
  rowHeight: 26.555,
  footerHeight: 46,
  /** A column narrower than this is too narrow for a drawing number. */
  minColumnWidth: 58,
  /** A column wider than this is capped rather than stretched further. */
  maxColumnWidth: 240,
  /** A printed sheet keeps at least this many drawing columns. */
  minColumns: 8,
};

/** The sizes the renderer uses for the words on the page. */
export const TIME_SHEET_TEXT = {
  headerLabel: 12,
  headerValue: 30,
  headerTitle: 40,
  letter: 22,
  layerName: 14,
  frameNumber: 14,
  cell: 19,
  camera: 13,
  footer: 13,
  nameStrip: 13,
};

const DRAWING_TYPES = new Set(["anim", "drawing", undefined, null, ""]);

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integer(value, fallback, min, max) {
  const number = Math.round(finite(value, fallback));
  return Math.min(max, Math.max(min, number));
}

/** The drawing layers a sheet can show. A folder and a guide are not cells. */
function isDrawingLayer(layer) {
  return Boolean(layer) && DRAWING_TYPES.has(layer.type ?? "");
}

/**
 * The drawing layers to put on the sheet, in the order of the layer list.
 *
 * `selection` holds layer indexes. A folder stands for every drawing layer
 * inside it, however deep, so choosing "Character" puts its eyes, mouth and
 * body on the sheet as separate rows. Without a selection every drawing layer
 * is used, which is what the sheet of a whole cut wants.
 */
export function timeSheetLayers(project, selection = null) {
  const layers = project?.layers ?? [];
  if (!Array.isArray(selection) || selection.length === 0) {
    return layers
      .map((layer, index) => ({ index, layer }))
      .filter((entry) => isDrawingLayer(entry.layer));
  }
  const wanted = new Set();
  const visit = (index, seen) => {
    const layer = layers[index];
    if (!layer || seen.has(index)) return;
    seen.add(index);
    if (layer.type === "group") {
      for (const child of childrenOf(project, index)) visit(child, seen);
    } else if (isDrawingLayer(layer)) {
      wanted.add(index);
    }
  };
  for (const index of selection) visit(Math.floor(Number(index)), new Set());
  return [...wanted]
    .sort((a, b) => a - b)
    .map((index) => ({ index, layer: layers[index] }));
}

/** `4+12` for 108 frames at 24 fps: seconds, then the frames left over. */
export function formatDuration(frameCount, fps) {
  const rate = Math.max(1, Math.round(finite(fps, 24)));
  const frames = Math.max(0, Math.round(finite(frameCount, 0)));
  return `${Math.floor(frames / rate)}+${String(frames % rate).padStart(2, "0")}`;
}

/** Today as `2026-11-02`, the date a fresh sheet carries. */
export function todayStamp(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `TU`, `PAN`, `CW`... - what the camera does between two keys. */
export function cameraMove(previous, key) {
  if (!previous) return "FIX";
  const zoom = finite(key?.width, 1) - finite(previous.width, 1);
  const pan =
    Math.abs(finite(key?.x, 0) - finite(previous.x, 0)) > 0.5 ||
    Math.abs(finite(key?.y, 0) - finite(previous.y, 0)) > 0.5;
  const turn = finite(key?.rotation, 0) - finite(previous.rotation, 0);
  const parts = [];
  if (zoom < -0.5) parts.push("TU");
  else if (zoom > 0.5) parts.push("TB");
  if (pan) parts.push("PAN");
  if (Math.abs(turn) > 0.01) parts.push(turn > 0 ? "CW" : "CCW");
  return parts.join(" ") || "HOLD";
}

function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out.length ? out : [[]];
}

function headerCells(options, metadata, pageNumber, pageLabel) {
  const columns = [
    [
      { key: "title", label: "TITLE", value: metadata.title, share: 0.55 },
      { key: "episode", label: "EPISODE", value: metadata.episode, share: 0.2 },
      { key: "cut", label: "CUT", value: metadata.cut, share: 0.25 },
    ],
    [
      { key: "duration", label: "DURATION (SEC+FRAME)", value: metadata.duration, share: 0.25 },
      { key: "author", label: "AUTHOR", value: metadata.author, share: 0.3 },
      { key: "date", label: "DATE", value: metadata.date, share: 0.2 },
      { key: "page", label: "PAGE", value: pageLabel, share: 0.25 },
    ],
  ];
  const rowHeight = TIME_SHEET_PAGE.headerHeight / columns.length;
  const cells = [];
  columns.forEach((row, rowIndex) => {
    let x = TIME_SHEET_PAGE.margin;
    for (const cell of row) {
      const width = Math.round(TIME_SHEET_PAGE.width - TIME_SHEET_PAGE.margin * 2) * cell.share;
      cells.push({
        ...cell,
        x,
        y: TIME_SHEET_PAGE.margin + rowIndex * rowHeight,
        width,
        height: rowHeight,
        value: String(cell.value ?? ""),
        pageNumber,
      });
      x += width;
    }
  });
  return cells;
}

/**
 * Lay out the whole sheet: the header, the frame rows, one column for each
 * selected drawing layer and the camera column.
 *
 * The result holds one entry per page. Every page carries its own header
 * cells, its own frame rows and its own columns, so a renderer never has to
 * know how the sheet was split.
 */
export function buildTimeSheetLayout(project, options = {}) {
  const fps = integer(options.fps ?? project?.fps, 24, 1, 240);
  const projectStart = integer(project?.startFrame, 1, 0, Number.MAX_SAFE_INTEGER);
  const contentFrames = sheetLength(project);
  const contentEnd = projectStart + contentFrames - 1;
  const from = integer(options.from ?? projectStart, projectStart, projectStart, contentEnd);
  const to = integer(options.to ?? contentEnd, contentEnd, from, Math.max(from, contentEnd));
  const frameCount = Math.max(1, to - from + 1);

  const selected = timeSheetLayers(project, options.layers);
  const notes = String(options.notes ?? "").trim();
  const title = String(options.title ?? "").trim() || String(options.name ?? "").trim() || "Untitled";
  const metadata = {
    title,
    episode: String(options.episode ?? "").trim(),
    cut: String(options.cut ?? "").trim(),
    author: String(options.author ?? "").trim(),
    date: String(options.date ?? "").trim() || todayStamp(options.now),
    duration: formatDuration(frameCount, fps),
    fps,
    notes,
  };

  const pageWidth = TIME_SHEET_PAGE.width;
  const pageHeight = TIME_SHEET_PAGE.height;
  const margin = TIME_SHEET_PAGE.margin;
  const contentWidth = pageWidth - margin * 2;
  const bodyTop =
    margin + TIME_SHEET_PAGE.headerHeight + TIME_SHEET_PAGE.gap + TIME_SHEET_PAGE.nameStripHeight;
  const bodyBottom = pageHeight - margin - TIME_SHEET_PAGE.footerHeight;
  const bodyMaxHeight = bodyBottom - bodyTop;
  const rowsFit = Math.max(1, Math.floor(bodyMaxHeight / TIME_SHEET_PAGE.rowHeight));
  // Pages break on whole seconds where a second fits at all. At 24 fps that
  // is 72 frames on a page - three seconds, the length of a TV sheet.
  const framesPerPage =
    rowsFit >= fps ? Math.max(fps, Math.floor(rowsFit / fps) * fps) : rowsFit;

  const cameraOn = options.camera === true;
  const frameColumnWidth = TIME_SHEET_PAGE.frameColumnWidth;
  const cameraWidth = cameraOn ? TIME_SHEET_PAGE.cameraColumnWidth : 0;
  const columnsWidth = contentWidth - frameColumnWidth - cameraWidth;
  const maxColumns = Math.max(1, Math.floor(columnsWidth / TIME_SHEET_PAGE.minColumnWidth));
  const entries = selected.map((entry, position) => ({
    ...entry,
    letter: columnName(position),
  }));
  // Spread the layers evenly over the pages instead of filling each page to
  // the brim and leaving the last one with a handful: 26 layers make two
  // pages of 13, not a full page and a nearly empty one.
  const groupCount = Math.max(1, Math.ceil(entries.length / maxColumns));
  const perGroup = Math.max(1, Math.ceil(entries.length / groupCount));
  const columnGroups = chunk(entries, perGroup);
  // A page keeps its full block of rows even when the cut ends early, the way
  // a printed sheet has every frame of the page numbered: the columns then run
  // to the bottom of the paper instead of stopping halfway down.
  const pageBlocks = [];
  for (let start = from; start <= to; start += framesPerPage) {
    pageBlocks.push({
      start,
      contentFrom: start,
      contentTo: Math.min(to, start + framesPerPage - 1),
      rowCount: framesPerPage,
    });
  }
  const pageCount = pageBlocks.length * columnGroups.length;

  const cameraKeys = Array.isArray(project?.camera?.keys)
    ? [...project.camera.keys].sort((a, b) => a.frame - b.frame)
    : [];

  const pages = [];
  pageBlocks.forEach((block) => {
    columnGroups.forEach((group, groupIndex) => {
      const pageNumber = pages.length + 1;
      const pageLabel = pageCount > 1 ? `${pageNumber} / ${pageCount}` : "1";
      const pageFrom = block.contentFrom;
      const pageTo = block.contentTo;
      const gridHeight = block.rowCount * TIME_SHEET_PAGE.rowHeight;
      // A printed sheet keeps a fixed set of drawing columns. A cut with two
      // layers still gets eight, the rest left blank, so the sheet looks like
      // a sheet instead of two wide columns floating in the middle.
      const slotCount = Math.max(TIME_SHEET_PAGE.minColumns, group.length);
      const columnWidth = Math.min(
        TIME_SHEET_PAGE.maxColumnWidth,
        columnsWidth / slotCount,
      );
      const groupStart = groupIndex * perGroup;

      const columns = group.map((entry, slotIndex) => {
        const layer = entry.layer;
        const cells = layerCells(project, layer, Math.max(1, to - projectStart + 1));
        const columnCells = [];
        let index = pageFrom - projectStart;
        while (index <= pageTo - projectStart) {
          const label = cells[index] ?? null;
          if (label === null) {
            index += 1;
            continue;
          }
          const previous = index > 0 ? cells[index - 1] : null;
          const continues = index === pageFrom - projectStart && previous === label;
          if (!continues && label === previous) {
            index += 1;
            continue;
          }
          let end = index;
          while (end + 1 <= pageTo - projectStart && cells[end + 1] === label) end += 1;
          const row = index - (pageFrom - projectStart);
          columnCells.push({
            row,
            label,
            continues,
            holdRows: end - index,
          });
          index = end + 1;
        }
        return {
          index: entry.index,
          letter: entry.letter,
          name: String(layer.name ?? `Layer ${entry.index + 1}`),
          x: margin + frameColumnWidth + slotIndex * columnWidth,
          y: bodyTop,
          width: columnWidth,
          height: gridHeight,
          header: {
            x: margin + frameColumnWidth + slotIndex * columnWidth,
            y: bodyTop - TIME_SHEET_PAGE.nameStripHeight,
            width: columnWidth,
            height: TIME_SHEET_PAGE.nameStripHeight,
          },
          cells: columnCells,
        };
      });

      const slots = Array.from({ length: slotCount }, (_, slotIndex) => {
        const entry = group[slotIndex];
        const x = margin + frameColumnWidth + slotIndex * columnWidth;
        return {
          letter: entry ? entry.letter : columnName(groupStart + slotIndex),
          name: entry ? String(entry.layer.name ?? `Layer ${entry.index + 1}`) : "",
          x,
          y: bodyTop,
          width: columnWidth,
          height: gridHeight,
          header: {
            x,
            y: bodyTop - TIME_SHEET_PAGE.nameStripHeight,
            width: columnWidth,
            height: TIME_SHEET_PAGE.nameStripHeight,
          },
          empty: !entry,
        };
      });

      const rows = Array.from({ length: block.rowCount }, (_, index) => {
        const frame = block.start + index;
        return {
          index,
          frame,
          y: bodyTop + index * TIME_SHEET_PAGE.rowHeight,
          height: TIME_SHEET_PAGE.rowHeight,
          second: (frame - projectStart) % fps === 0,
          major: (frame - projectStart) % Math.max(1, Math.round(fps / 4)) === 0,
        };
      });

      const camera = cameraOn
        ? {
            x: margin + contentWidth - cameraWidth,
            y: bodyTop,
            width: cameraWidth,
            height: gridHeight,
            header: {
              x: margin + contentWidth - cameraWidth,
              y: bodyTop - TIME_SHEET_PAGE.nameStripHeight,
              width: cameraWidth,
              height: TIME_SHEET_PAGE.nameStripHeight,
            },
            label: "CAMERA",
            keys: [],
            continues: false,
          }
        : null;

      if (camera) {
        const visible = cameraKeys.filter((key) => key.frame >= pageFrom && key.frame <= pageTo);
        const earlier = cameraKeys.filter((key) => key.frame < pageFrom);
        camera.continues = visible.length > 0 && visible[0].frame > pageFrom && earlier.length > 0;
        camera.keys = visible.map((key, index) => {
          const position = cameraKeys.indexOf(key);
          const previous = position > 0 ? cameraKeys[position - 1] : null;
          return {
            row: key.frame - pageFrom,
            frame: key.frame,
            label: cameraMove(previous, key),
            first: index === 0,
          };
        });
        // A key that sits exactly on the page start continues the movement
        // of an earlier key, so the line still runs in from the top.
        if (camera.keys.length && camera.keys[0].row === 0 && earlier.length) {
          camera.continues = true;
        }
      }

      pages.push({
        index: pages.length,
        number: pageNumber,
        count: pageCount,
        fromFrame: pageFrom,
        toFrame: pageTo,
        frameCount: pageTo - pageFrom + 1,
        rowCount: block.rowCount,
        header: {
          x: margin,
          y: margin,
          width: contentWidth,
          height: TIME_SHEET_PAGE.headerHeight,
          rowHeight: TIME_SHEET_PAGE.headerHeight / 2,
          cells: headerCells(options, metadata, pageNumber, pageLabel),
        },
        body: {
          x: margin,
          y: bodyTop,
          width: contentWidth,
          height: gridHeight,
        },
        frameColumn: {
          x: margin,
          y: bodyTop,
          width: frameColumnWidth,
          height: gridHeight,
          header: {
            x: margin,
            y: bodyTop - TIME_SHEET_PAGE.nameStripHeight,
            width: frameColumnWidth,
            height: TIME_SHEET_PAGE.nameStripHeight,
          },
          label: "FRAME",
        },
        columns,
        slots,
        camera,
        rows,
        footer: {
          x: margin,
          y: bodyBottom,
          width: contentWidth,
          height: TIME_SHEET_PAGE.footerHeight,
          left: notes,
          right: `${fps} fps · frames ${pageFrom}–${pageTo} · page ${pageLabel}`,
        },
      });
    });
  });

  return {
    page: { width: pageWidth, height: pageHeight, margin },
    style: TIME_SHEET_TEXT,
    fps,
    startFrame: from,
    endFrame: to,
    frameCount,
    layerCount: selected.length,
    pageCount,
    duration: metadata.duration,
    meta: metadata,
    pages,
  };
}
