/**
 * One entry point for the exports that are not the project's own formats.
 *
 * Both backends call `buildExport`, so the server and the browser build
 * produce byte-identical files. A kind returns the main file and, for the
 * sprite sheet, a companion JSON that is written next to it.
 */
import { createSequenceZip, createSpriteSheet, createGifBuffer, safeFileName } from "./exporters.js";
import { createPsdBuffer } from "./psd.js";
import { createTimesheetCsv, createXdtsText } from "./timesheet.js";

export const EXPORT_KINDS = {
  psd: { label: "Layered PSD (current frame)", ext: "psd" },
  xdts: { label: "Timesheet XDTS (Clip Studio / OpenToonz)", ext: "xdts" },
  csv: { label: "Timesheet CSV", ext: "csv" },
  gif: { label: "Animated GIF", ext: "gif" },
  sheet: { label: "Sprite sheet PNG + JSON", ext: "png" },
  sequence: { label: "Image sequence (ZIP)", ext: "zip" },
};

export const DEFAULT_PRESET = Object.freeze({
  range: "all",
  pattern: "{name}_{frame:4}",
  format: "png",
  columns: 0,
});

/** Merge saved options over the defaults and drop what is not valid. */
export function cleanOptions(options = {}) {
  const out = { ...DEFAULT_PRESET };
  if (options.range === "current" || options.range === "all") out.range = options.range;
  else if (options.range && Number.isInteger(options.range.from) && Number.isInteger(options.range.to)) {
    out.range = { from: options.range.from, to: options.range.to };
  }
  if (typeof options.pattern === "string" && options.pattern.trim()) out.pattern = options.pattern.slice(0, 120);
  if (options.format === "tga" || options.format === "png") out.format = options.format;
  if (Number.isInteger(options.columns) && options.columns >= 0 && options.columns <= 256) {
    out.columns = options.columns;
  }
  return out;
}

/**
 * @param {keyof typeof EXPORT_KINDS} kind
 * @returns {{ext: string, bytes: Uint8Array, extra: {ext: string, bytes: Uint8Array}[], summary: string}}
 */
export function buildExport(kind, project, stem, rawOptions = {}) {
  const options = cleanOptions(rawOptions);
  const name = safeFileName(stem);
  const encode = (text) => new TextEncoder().encode(text);

  switch (kind) {
    case "psd": {
      const psd = createPsdBuffer(project, project.currentFrame);
      return {
        ext: "psd",
        bytes: psd.buffer,
        extra: [],
        summary: `${psd.layers} layer record${psd.layers === 1 ? "" : "s"}, ${psd.width}×${psd.height}, frame ${project.currentFrame}`,
      };
    }
    case "xdts":
      return { ext: "xdts", bytes: encode(createXdtsText(project, { name })), extra: [], summary: "timesheet" };
    case "csv":
      return { ext: "csv", bytes: encode(createTimesheetCsv(project)), extra: [], summary: "timesheet" };
    case "gif": {
      const gif = createGifBuffer(project, { range: options.range });
      return {
        ext: "gif",
        bytes: gif.buffer,
        extra: [],
        summary: `${gif.frames} frame${gif.frames === 1 ? "" : "s"}, ${gif.width}×${gif.height}`,
      };
    }
    case "sheet": {
      const sheet = createSpriteSheet(project, { range: options.range, columns: options.columns, name });
      return {
        ext: "png",
        bytes: sheet.png,
        extra: [{ ext: "json", bytes: encode(sheet.json) }],
        summary: `${sheet.frames} frames in ${sheet.columns}×${sheet.rows}, ${sheet.width}×${sheet.height}`,
      };
    }
    case "sequence": {
      const zip = createSequenceZip(project, { range: options.range, pattern: options.pattern, name, format: options.format });
      return {
        ext: "zip",
        bytes: zip.buffer,
        extra: [],
        summary: `${zip.frames} ${options.format.toUpperCase()} file${zip.frames === 1 ? "" : "s"}, ${zip.width}×${zip.height}`,
      };
    }
    default:
      throw new Error(`unknown export kind: ${kind}`);
  }
}
