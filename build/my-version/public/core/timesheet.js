/**
 * Exposure sheets (timesheets) for the timeline.
 *
 * Two outputs:
 *
 *  - XDTS, the Toei Digital Timesheet exchange format read by Clip Studio
 *    Paint and OpenToonz: a header line followed by JSON, one track per
 *    drawing layer, cells written only where they change;
 *  - CSV: one row per frame, one column per drawing layer.
 *
 * Both list the drawing layers in the project's order (the top layer is the
 * first column). Folders have no cells and are skipped. A cell is called by
 * its own name when it has one, otherwise by its position on the layer.
 */
import { contentLength } from "../timeline.js";

export const XDTS_HEADER = "exchangeDigitalTimeSheet Save Data";
const NULL_CELL = "SYMBOL_NULL_CELL";

/** The drawing layers that go on a sheet, in order. */
export function sheetLayers(project) {
  return project.layers.filter((layer) => layer.type !== "group");
}

/** Column letters: A..Z, AA, AB... */
export function columnName(index) {
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * The cell shown at every frame of a layer, as `[name | null, ...]`
 * with one entry per frame of the sheet (frame 0 is the project's start).
 */
export function layerCells(project, layer, length) {
  const cells = new Array(length).fill(null);
  const drawings = [...layer.drawings].sort((a, b) => a.at - b.at);
  drawings.forEach((drawing, position) => {
    const name = drawing.name || String(position + 1);
    for (let k = 0; k < drawing.hold; k += 1) {
      const frame = drawing.at - project.startFrame + k;
      if (frame >= 0 && frame < length) cells[frame] = name;
    }
  });
  return cells;
}

/** The number of frames on the sheet. */
export function sheetLength(project) {
  return Math.max(1, contentLength(project));
}

/** Build the XDTS document as text. */
export function createXdtsText(project, { cut = "1", scene = "1", name = "Timesheet" } = {}) {
  const layers = sheetLayers(project);
  const duration = sheetLength(project);

  const tracks = layers.map((layer, trackNo) => {
    const cells = layerCells(project, layer, duration);
    const frames = [];
    let previous;
    for (let frame = 0; frame < duration; frame += 1) {
      const cell = cells[frame];
      if (cell === previous) continue; // a held cell is written once
      previous = cell;
      frames.push({ frame, data: [{ id: 0, values: [cell ?? NULL_CELL] }] });
    }
    // A sheet that ends on a cell closes it, so the hold has an end.
    if (previous !== null && previous !== undefined) {
      frames.push({ frame: duration, data: [{ id: 0, values: [NULL_CELL] }] });
    }
    return { trackNo, frames };
  });

  const document = {
    version: 5,
    header: { cut: String(cut), scene: String(scene) },
    timeTables: [
      {
        duration,
        name,
        fields: [{ fieldId: 0, tracks }],
        timeTableHeaders: [{ fieldId: 0, names: layers.map((layer) => layer.name) }],
      },
    ],
  };
  return `${XDTS_HEADER}\n${JSON.stringify(document)}`;
}

/** Read an XDTS text back into `{ duration, names, tracks: [[cell|null per frame]] }`. */
export function parseXdtsText(text) {
  const start = text.indexOf("{");
  if (!text.startsWith(XDTS_HEADER) || start < 0) {
    throw new Error("not an XDTS timesheet");
  }
  const document = JSON.parse(text.slice(start));
  const table = document.timeTables?.[0];
  if (!table) throw new Error("the timesheet has no time table");
  const duration = table.duration;
  const names = table.timeTableHeaders?.find((h) => h.fieldId === 0)?.names ?? [];
  const field = table.fields?.find((f) => f.fieldId === 0);
  const tracks = (field?.tracks ?? []).map((track) => {
    const cells = new Array(duration).fill(null);
    const frames = [...track.frames].sort((a, b) => a.frame - b.frame);
    let current = null;
    let cursor = 0;
    for (const entry of frames) {
      for (; cursor < Math.min(entry.frame, duration); cursor += 1) cells[cursor] = current;
      const value = entry.data?.[0]?.values?.[0];
      current = value === NULL_CELL || value === undefined ? null : value;
    }
    for (; cursor < duration; cursor += 1) cells[cursor] = current;
    return cells;
  });
  return { duration, names, tracks };
}

function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Build a CSV timesheet: a Frame column, then one column per layer. */
export function createTimesheetCsv(project) {
  const layers = sheetLayers(project);
  const duration = sheetLength(project);
  const columns = layers.map((layer) => layerCells(project, layer, duration));
  const lines = [["Frame", ...layers.map((layer) => layer.name)].map(csvField).join(",")];
  for (let frame = 0; frame < duration; frame += 1) {
    const row = [project.startFrame + frame, ...columns.map((cells) => cells[frame] ?? "")];
    lines.push(row.map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
