/**
 * Ask the running program, in a real browser, how long a call to the server
 * takes and whether it fails.
 *
 *   node tools/server-probe.mjs
 *
 * The exports go wrong after a few of them, and the log says the call to the
 * server failed. This measures the call from inside the page, so the browser
 * is the one that says it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-server-probe");
const PORT = 9337;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const profile = path.join(OUT, "profile");
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  URL,
]);
edge.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

async function target() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // The browser is still starting.
    }
    await sleep(250);
  }
  throw new Error("the browser did not come up");
}

class Devtools {
  constructor(url) {
    this.next = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve);
      this.socket.addEventListener("error", reject);
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      entry.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  async run(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "the page threw");
    }
    return result.result?.value;
  }
}

const page = await target();
const devtools = new Devtools(page.webSocketDebuggerUrl);
await devtools.send("Runtime.enable");
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ready = await devtools.run('document.readyState === "complete"');
  if (ready) break;
  await sleep(250);
}

const call = `
  (async () => {
    const started = Date.now();
    try {
      const response = await fetch("/api/stat?path=C%3A%5CUsers%5CMK%5CAppData");
      return { ok: response.ok, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: String(error) };
    }
  })()
`;

console.log("call after the page has been idle:");
await sleep(1000);
console.log(" ", JSON.stringify(await devtools.run(call)));

console.log("call after six seconds of nothing (the server closes the connection):");
await sleep(6000);
console.log(" ", JSON.stringify(await devtools.run(call)));

console.log("five calls in a row:");
for (let index = 0; index < 5; index += 1) {
  console.log(" ", JSON.stringify(await devtools.run(call)));
}

edge.kill();
