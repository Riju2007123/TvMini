/**
 * Open the file dialog of an export, close it, and ask the server the same
 * question the export asks. Written down is whether the question is answered.
 *
 *   node tools/dialog-probe.mjs
 *
 * The exports of the file menu sometimes fail with "Failed to fetch" while
 * the server is there and answers everything else. This probe opens the
 * dialog and closes it the way the program does, and asks the question
 * afterwards, so the dialog shows up as the cause or as not the cause.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), `tvmini-dialog-probe-${Date.now().toString(36)}`);
const PORT = 9700 + Math.floor(Math.random() * 200);

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
      }, 60000);
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
if (!process.env.TVMINI_NO_NETWORK) await devtools.send("Network.enable");

for (let attempt = 0; attempt < 60; attempt += 1) {
  const ready = await devtools.run('document.readyState === "complete"');
  if (ready) break;
  await sleep(250);
}

const folder = path.join(OUT, "files");
fs.mkdirSync(folder, { recursive: true });

for (let round = 0; round < 8; round += 1) {
  // The menu, the entry, the dialog, Save.
  await devtools.run('document.querySelector("#fileButton").click(); true');
  await sleep(120);
  await devtools.run(
    '(() => { const b = document.querySelector(\'#fileMenu [data-action="exportGif"]\');' +
      " if (b) b.click(); return true; })()",
  );
  await sleep(400);
  await devtools.run(
    `(() => { const dir = document.querySelector("#dirInput");
       dir.value = ${JSON.stringify(folder)};
       document.querySelector("#goButton").click();
       return true; })()`,
  );
  await sleep(500);
  await devtools.run(
    `(() => { const input = document.querySelector("#nameInput");
       input.value = ${JSON.stringify(`probe-${round}.gif`)};
       input.dispatchEvent(new Event("input", { bubbles: true }));
       document.querySelector("#confirmButton").click();
       return true; })()`,
  );
  await sleep(1500);

  // Now the same question, asked from the page by hand.
  const answer = await devtools.run(
    `(async () => {
       const url = "/api/stat?path=" + encodeURIComponent(${JSON.stringify(folder)} + "\\\\byhand.gif");
       try {
         const response = await fetch(url, { cache: "no-store" });
         return "status " + response.status;
       } catch (error) {
         return "FAILED: " + error.message;
       }
     })()`,
  );
  console.log(`round ${round}: ${answer}`);
}

browser.kill();
