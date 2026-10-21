/**
 * A tiny SQLite façade with the same shape in Node and the browser.
 *
 * The `.clip` writer only needs a handful of operations, so instead of
 * depending on `node:sqlite` directly this module defines a small interface
 * and provides two implementations:
 *
 *  - `node:sqlite` under Node (fast, native);
 *  - `sql.js` (SQLite compiled to WebAssembly) in the browser.
 *
 * Both expose:
 *
 *   exec(sql)                       run one or more statements
 *   prepare(sql) -> {all, get, run} parameterised queries
 *   close()                         release the database
 *
 * `sql.js` is a real SQLite build, so the bytes it produces are the same
 * SQLite file format that Clip Studio Paint reads.
 */

/* -------------------------------------------------------------- node:sqlite */

/**
 * A database that lives in a file.
 *
 * node:sqlite opens a file, so a new database is made in a temporary file
 * and the image is read back from it when the database is closed. That is
 * also how an image that was read in is handed back.
 */
async function nodeDatabase(stage) {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtemp, rm, readFile, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await mkdtemp(path.join(os.tmpdir(), "tvmini-sqlite-"));
  const file = path.join(dir, "document.db");
  if (stage) await writeFile(file, stage);

  const database = new DatabaseSync(file);
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => database.prepare(sql),
    // node:sqlite writes through to the file, so the image is read back
    // after the database is closed.
    export: async () => {
      database.close();
      return new Uint8Array(await readFile(file));
    },
    close: async () => {
      try {
        database.close();
      } catch {
        // Already closed by export().
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function openNodeDatabase(bytes) {
  return nodeDatabase(bytes);
}

/* ----------------------------------------------------------------- sql.js */

let sqlPromise = null;

/**
 * Load the WebAssembly build of SQLite once per page.
 *
 * The published `sql-wasm.js` is a UMD script, not an ES module, so it is
 * injected as a classic script; that defines a global `initSqlJs`. It is
 * only fetched when a `.clip` is actually read or written, so a page that
 * never touches one never downloads the 660 kB runtime.
 */
function loadSqlJs() {
  if (!sqlPromise) {
    sqlPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("../vendor/sql-wasm.js", import.meta.url).href;
      script.onload = () => {
        const initSqlJs = globalThis.initSqlJs;
        if (typeof initSqlJs !== "function") {
          reject(new Error("the SQLite runtime did not load"));
          return;
        }
        resolve(
          initSqlJs({
            // The .wasm file sits next to the loader in vendor/.
            locateFile: (file) => new URL(`../vendor/${file}`, import.meta.url).href,
          }),
        );
      };
      script.onerror = () => reject(new Error("the SQLite runtime could not be loaded"));
      document.head.append(script);
    });
  }
  return sqlPromise;
}

async function openWasmDatabase(bytes) {
  const SQL = await loadSqlJs();
  const database = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();

  // sql.js uses a step/bind API rather than node:sqlite's all/get/run.
  // These helpers translate between the two.
  const query = (sql, params) => {
    const statement = database.prepare(sql);
    try {
      if (params && params.length > 0) statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  };

  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => ({
      all: (...params) => query(sql, params),
      get: (...params) => query(sql, params)[0],
      run: (...params) => {
        query(sql, params);
        return { changes: database.getRowsModified() };
      },
    }),
    close: () => database.close(),
    // sql.js keeps the whole database in memory, so the file is produced
    // directly instead of being read back from disk.
    export: () => database.export(),
  };
}

/**
 * Open a SQLite database from its raw bytes.
 *
 * Returns the façade described above. The result also carries `export()`
 * when the backend can produce the file image in memory.
 */
export async function openDatabase(bytes) {
  if (typeof process !== "undefined" && process.versions?.node) {
    return openNodeDatabase(bytes);
  }
  return openWasmDatabase(bytes);
}

/**
 * Make a new, empty SQLite database.
 *
 * This is what a writer needs: the tables are made, the rows are put in and
 * `export()` gives the file image.
 */
export async function createDatabase() {
  if (typeof process !== "undefined" && process.versions?.node) {
    return nodeDatabase(null);
  }
  return openWasmDatabase(null);
}
