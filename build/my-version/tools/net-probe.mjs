/**
 * Ask the program, from inside the browser, for the same file information
 * over and over again, and write down what happens every time.
 *
 *   node tools/net-probe.mjs
 *
 * The exports of the file menu sometimes fail with "Failed to fetch" while
 * the server is still there. This probe asks the same question the export
 * asks, without the dialog and without the menu, so the difference shows
 * where the failure comes from.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), `tvmini-net-probe-${Date.now().toString(36)}`);
const PORT = 9600 + Math.floor(Math.random() * 300);

fs.mkdirSync(OUT, { recursive: true });

const browser = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    URL,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // The browser is not up yet.
    }
    await sleep(250);
  }
  throw new Error("the browser did not come up");
}

class Devtools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve);
      this.socket.addEventListener("error", reject);
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
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
      }, 120000);
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

// Forty questions, one after the other, with a short gap between them.
// Every question is asked together with the small reports the program writes
// down while it works, exactly as the export does it.
const answer = await devtools.run(
  `(async () => {
     const out = [];
     const report = (message) => {
       fetch("api/client-log", {
         method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ message }),
       }).catch(() => {});
     };
     for (let i = 0; i < 40; i += 1) {
       const url = "/api/stat?path=" + encodeURIComponent("C:\\\\probe\\\\file" + i + ".gif");
       report("the export has the path " + i);
       report("the export asks " + url);
       try {
         const response = await fetch(url, { cache: "no-store" });
         out.push(i + ":" + response.status);
       } catch (error) {
         out.push(i + ":ERR(" + error.message + ")");
       }
       await new Promise((resolve) => setTimeout(resolve, 60));
     }
     return out.join(" ");
   })()`,
);

console.log(answer);

browser.kill();
