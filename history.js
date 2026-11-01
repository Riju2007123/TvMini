/**
 * Bounded undo/redo stack. Values are opaque snapshots owned by the caller;
 * this class never mutates them.
 */
export class History {
  constructor({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("history limit must be a positive integer");
    }
    this.limit = limit;
    this.past = [];
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** Forget everything (new/open project). */
  reset() {
    this.past = [];
    this.future = [];
  }

  /**
   * Record the state *before* a change. Any redo branch is discarded,
   * because the document has moved in a new direction.
   */
  record(before) {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** Pass the current state; returns the previous one, or null. */
  undo(current) {
    if (!this.canUndo) return null;
    this.future.push(current);
    if (this.future.length > this.limit) this.future.shift();
    return this.past.pop();
  }

  /** Pass the current state; returns the next one, or null. */
  redo(current) {
    if (!this.canRedo) return null;
    this.past.push(current);
    if (this.past.length > this.limit) this.past.shift();
    return this.future.pop();
  }
}
