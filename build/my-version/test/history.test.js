import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../public/history.js";

test("a new history has nothing to undo or redo", () => {
  const history = new History();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo("s0"), null);
  assert.equal(history.redo("s0"), null);
});

test("undo and redo walk the recorded states", () => {
  const history = new History();
  history.record("s0"); // s0 -> s1
  history.record("s1"); // s1 -> s2
  history.record("s2"); // s2 -> s3

  assert.equal(history.undo("s3"), "s2");
  assert.equal(history.undo("s2"), "s1");
  assert.equal(history.undo("s1"), "s0");
  assert.equal(history.undo("s0"), null);

  assert.equal(history.redo("s0"), "s1");
  assert.equal(history.redo("s1"), "s2");
  assert.equal(history.redo("s2"), "s3");
  assert.equal(history.redo("s3"), null);
});

test("a new change discards the redo branch", () => {
  const history = new History();
  history.record("s0");
  history.record("s1");

  assert.equal(history.undo("s2"), "s1");
  assert.equal(history.canRedo, true);

  history.record("s1"); // user drew instead of redoing
  assert.equal(history.canRedo, false);
  assert.equal(history.redo("s1b"), null);
});

test("history is bounded and drops the oldest state", () => {
  const history = new History({ limit: 2 });
  history.record("s0");
  history.record("s1");
  history.record("s2");

  assert.equal(history.undo("s3"), "s2");
  assert.equal(history.undo("s2"), "s1");
  assert.equal(history.undo("s1"), null);
});

test("reset clears both directions", () => {
  const history = new History();
  history.record("s0");
  history.undo("s1");
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);

  history.reset();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test("limit must be a positive integer", () => {
  assert.throws(() => new History({ limit: 0 }), /positive integer/);
  assert.throws(() => new History({ limit: 1.5 }), /positive integer/);
});
