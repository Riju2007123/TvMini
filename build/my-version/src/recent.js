import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_RECENT = 50;

export function defaultRecentFile() {
  return path.join(os.homedir(), ".tvmini", "recent.json");
}

function keyOf(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Persistent most-recently-used list of project paths.
 *
 * Rules (SPEC FR-6):
 *  - newest first
 *  - at most `max` entries
 *  - re-adding an existing path moves it to the front
 *  - missing files are dropped on read
 */
export class RecentStore {
  constructor(file = defaultRecentFile(), { max = MAX_RECENT } = {}) {
    this.file = file;
    this.max = max;
    this.entries = [];
  }

  async load() {
    let raw;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        this.entries = [];
        return this.list();
      }
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt recent list must never stop the app from starting.
      this.entries = [];
      return this.list();
    }

    const list = Array.isArray(parsed) ? parsed : parsed?.entries;
    const seen = new Set();
    const cleaned = [];

    for (const item of Array.isArray(list) ? list : []) {
      const value = typeof item === "string" ? item : item?.path;
      if (typeof value !== "string" || value.trim() === "") continue;
      const absolute = path.resolve(value);
      const key = keyOf(absolute);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!fs.existsSync(absolute)) continue;
      cleaned.push(absolute);
      if (cleaned.length >= this.max) break;
    }

    this.entries = cleaned;
    return this.list();
  }

  list() {
    return this.entries.map((entry) => ({
      path: entry,
      name: path.basename(entry),
      exists: fs.existsSync(entry),
    }));
  }

  async add(filePath) {
    const absolute = path.resolve(filePath);
    const key = keyOf(absolute);
    this.entries = [absolute, ...this.entries.filter((entry) => keyOf(entry) !== key)];
    if (this.entries.length > this.max) this.entries.length = this.max;
    await this.save();
    return this.list();
  }

  async remove(filePath) {
    const key = keyOf(path.resolve(filePath));
    this.entries = this.entries.filter((entry) => keyOf(entry) !== key);
    await this.save();
    return this.list();
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      await fsp.writeFile(temp, JSON.stringify({ version: 1, entries: this.entries }, null, 2), "utf8");
      await fsp.rename(temp, this.file);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}
