import test from "node:test";
import assert from "node:assert/strict";
import { createGroup, createLayer, createProject } from "../src/model.js";
import {
  columnName,
  createTimesheetCsv,
  createXdtsText,
  layerCells,
  parseXdtsText,
  XDTS_HEADER,
} from "../public/core/timesheet.js";

function sample() {
  const project = createProject(64, 48);
  const folder = createGroup("Folder");
  const a = createLayer("A");
  const b = createLayer('B "ink"');
  a.parent = 0;
  project.layers = [folder, a, b];
  a.drawings = [
    { at: 1, hold: 2, strokes: [] },
    { at: 3, hold: 1, strokes: [], name: "2a" },
    { at: 5, hold: 2, strokes: [] },
  ];
  b.drawings = [{ at: 2, hold: 3, strokes: [] }];
  return project;
}

test("column names run A..Z, AA", () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(27), "AB");
});

test("cells follow the exposures, and a named cell keeps its name", () => {
  const project = sample();
  assert.deepEqual(layerCells(project, project.layers[1], 7), ["1", "1", "2a", null, "3", "3", null]);
  assert.deepEqual(layerCells(project, project.layers[2], 7), [null, "1", "1", "1", null, null, null]);
});

test("XDTS has the header line and writes cells only where they change", () => {
  const text = createXdtsText(sample());
  assert.ok(text.startsWith(`${XDTS_HEADER}\n{`));
  const document = JSON.parse(text.slice(text.indexOf("{")));
  const table = document.timeTables[0];
  assert.equal(table.duration, 6);
  assert.deepEqual(table.timeTableHeaders[0].names, ["A", 'B "ink"']);
  const first = table.fields[0].tracks[0].frames.map((f) => [f.frame, f.data[0].values[0]]);
  assert.deepEqual(first, [
    [0, "1"],
    [2, "2a"],
    [3, "SYMBOL_NULL_CELL"],
    [4, "3"],
    [6, "SYMBOL_NULL_CELL"],
  ]);
});

test("XDTS reads back to the same cells", () => {
  const project = sample();
  const read = parseXdtsText(createXdtsText(project));
  assert.equal(read.duration, 6);
  assert.deepEqual(read.tracks[0], ["1", "1", "2a", null, "3", "3"]);
  assert.deepEqual(read.tracks[1], [null, "1", "1", "1", null, null]);
  assert.throws(() => parseXdtsText("{}"), /not an XDTS/);
});

test("CSV has a header row, one row per frame and quotes fields", () => {
  const rows = createTimesheetCsv(sample()).trim().split("\r\n");
  assert.equal(rows[0], 'Frame,A,"B ""ink"""');
  assert.equal(rows.length, 7);
  assert.equal(rows[1], "1,1,");
  assert.equal(rows[3], "3,2a,1");
});
