/**
 * Drive the export menu of the program in a real browser.
 *
 *   node tools/clip-browser-check.mjs
 *
 * The program is opened in a headless browser, every export in the file menu
 * is picked, the file dialog is filled in and Save is pressed, and what the
 * program says afterwards is written down together with the file that was
 * written. It is the test of the whole way through: the menu, the dialog,
 * the backend and the server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
// A folder of its own for every run: a browser that is still shutting down
// keeps a lock on the old one.
const OUT = path.join(
  os.tmpdir(),
  `tvmini-browser-check-${Date.now().toString(36)}`,
);
const PORT = 9300 + Math.floor(Math.random() * 300);

fs.mkdirSync(OUT, { recursive: true });

const profile = path.join(OUT, "profile");
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1680,1050",
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

/** A tiny DevTools client: send a command, wait for its answer. */
class Devtools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.console = [];
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
        return;
      }
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ");
        this.console.push(`${message.params.type}: ${text}`);
      }
      if (message.method === "Network.loadingFailed") {
        this.console.push(
          `network: ${message.params.errorText} (${message.params.type ?? "?"})`,
        );
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        this.console.push(`exception: ${details?.exception?.description ?? details?.text}`);
      }
      if (message.method === "Page.javascriptDialogOpening") {
        this.console.push(
          `dialog: ${message.params.type} ${message.params.message ?? ""}`,
        );
        // A dialog that nobody answers stops the whole page.
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
      if (message.method === "Page.frameNavigated") {
        this.console.push(`navigated: ${message.params.frame.url}`);
      }
      if (message.method === "Page.loadEventFired") {
        this.console.push("the page loaded again");
      }
      if (message.method === "Runtime.executionContextCreated") {
        this.console.push("a new script started");
      }
      if (message.method === "Network.loadingFailed") {
        const p = message.params;
        this.console.push(
          `request ${p.requestId} failed: ${p.errorText} type=${p.type ?? ""} ` +
            `blocked=${p.blockedReason ?? "-"} canceled=${p.canceled ?? "-"} ` +
            `cors=${p.corsErrorStatus ?? "-"}`,
        );
      }
      if (message.method === "Network.requestWillBeSent") {
        const p = message.params;
        this.console.push(
          `request ${p.requestId} ${p.request.method} ${p.request.url.slice(0, 120)}`,
        );
      }
      if (message.method === "Network.responseReceived") {
        this.console.push(`request ${message.params.requestId} -> ${message.params.response.status} ${message.params.response.url.slice(0, 120)}`);
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
      }, 30000);
    });
  }

  /** Run a piece of code in the page and hand back its value. */
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
await devtools.send("Network.enable");
await devtools.send("Page.enable");

// Wait for the program to be there.
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ready = await devtools.run(
    'document.readyState === "complete" && !!document.querySelector("#fileButton")',
  );
  if (ready) break;
  await sleep(250);
}

/** The exports of the file menu, and the name each one writes. */
const EXPORTS = [
  ["export", "png"],
  ["exportClip", "clip"],
  ["exportTvpp", "tvpp"],
  ["exportPsd", "psd"],
  ["exportGif", "gif"],
  ["exportSheet", "png"],
  ["exportSequence", "zip"],
  ["exportXdts", "xdts"],
  ["exportCsv", "csv"],
];

const folder = path.join(OUT, "files");
fs.mkdirSync(folder, { recursive: true });

const results = [];
for (const [action, extension] of EXPORTS) {
  const name = `check-${action}.${extension}`;
  const target = path.join(folder, name);
  devtools.console.length = 0;

  // The menu, then the entry.
  await devtools.run('document.querySelector("#fileButton").click(); true');
  await sleep(120);
  const selector = JSON.stringify(`#fileMenu [data-action="${action}"]`);
  const picked = await devtools.run(
    `(() => { const button = document.querySelector(${selector});` +
      ` if (!button) return false; button.click(); return true; })()`,
  );
  if (!picked) {
    results.push({ action, state: "the menu has no such entry" });
    continue;
  }

  // The file dialog: the folder, the name, Save.
  await sleep(400);
  const dialog = await devtools.run(
    `(() => { const modal = document.querySelector("#modal");
       if (!modal || modal.hidden) return "no dialog";
       const dir = document.querySelector("#dirInput");
       dir.value = ${JSON.stringify(folder)};
       document.querySelector("#goButton").click();
       return "ok"; })()`,
  );
  await sleep(500);
  await devtools.run(
    `(() => { const input = document.querySelector("#nameInput");
       input.value = ${JSON.stringify(name)};
       input.dispatchEvent(new Event("input", { bubbles: true }));
       document.querySelector("#confirmButton").click();
       return true; })()`,
  );

  // Wait for the file to appear, or for the status to settle. The wait is
  // long on purpose: the exports are picked one after the other, and the
  // gap is what brought the failure out before.
  let status = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(200);
    status = await devtools.run(
      'document.querySelector("#status")?.textContent ?? document.querySelector("#statusBar")?.textContent ?? ""',
    );
    if (fs.existsSync(target)) break;
    if (/Exported|cancelled|failed/i.test(status)) break;
  }
  await sleep(6000);
  const written = fs.existsSync(target) ? fs.statSync(target).size : 0;
  results.push({
    action,
    dialog,
    status,
    written,
    console: devtools.console.filter((line) => !line.startsWith("log:")),
  });
}

console.log("\n=== the exports of the file menu ===");
for (const result of results) {
  const size = result.written ? `${result.written} bytes` : "NO FILE";
  console.log(`\n${result.action}: ${size}`);
  console.log(`   status: ${result.status}`);
  for (const line of result.console) console.log(`   ${line}`);
}

browser.kill();
console.log(`\nfiles: ${folder}`);
