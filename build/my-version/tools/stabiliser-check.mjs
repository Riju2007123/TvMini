/**
 * Draw the same shaky line with the stabiliser at different settings and
 * show how much of the paper the line covers.
 *
 *   node tools/stabiliser-check.mjs
 *
 * A zigzag that a hand would draw is traced on the stage. The steadier the
 * line, the straighter it is and the less of the paper it covers.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-stabiliser-check");
const PORT = 9345;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, "profile")}`,
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--window-size=1600,1000",
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
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
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
await devtools.send("Page.enable");
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ready = await devtools.run(
    'document.readyState === "complete" && !!document.querySelector("#canvas")',
  );
  if (ready) break;
  await sleep(250);
}

await devtools.run(
  '(() => { for (const b of document.querySelectorAll("button")) {' +
    ' if (b.textContent.trim() === "Start drawing") { b.click(); return "closed"; } }' +
    ' return "no start screen"; })()',
);
await sleep(500);

const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);

const mouse = (type, x, y, buttons = 0) =>
  devtools.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons,
    clickCount: 1,
  });

/** The ink on the paper, and how far it strays from the line it follows. */
const measure = async () =>
  JSON.parse(
    await devtools.run(
      `(() => {
         const c = document.querySelector("#canvas");
         const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
         let count = 0;
         let top = c.height, bottom = -1;
         for (let y = 0; y < c.height; y += 1) {
           for (let x = 0; x < c.width; x += 1) {
             if (data[(y * c.width + x) * 4] + data[(y * c.width + x) * 4 + 1] +
                 data[(y * c.width + x) * 4 + 2] < 600) {
               count += 1;
               if (y < top) top = y;
               if (y > bottom) bottom = y;
             }
           }
         }
         return JSON.stringify({ count, height: bottom - top });
       })()`,
    ),
  );

/** A zigzag, the way a hand moves. */
const zigzag = async () => {
  const startX = box.x + box.w * 0.2;
  const y = box.y + box.h * 0.5;
  await mouse("mousePressed", startX, y, 1);
  for (let step = 1; step <= 24; step += 1) {
    const x = startX + step * 20;
    const up = step % 2 === 0 ? 30 : -30;
    await mouse("mouseMoved", x, y + up, 1);
  }
  await mouse("mouseReleased", startX + 24 * 20, y + 30, 0);
  await sleep(300);
};

for (const level of [0, 10, 30, 50, 100]) {
  await devtools.run(
    `(() => { const s = document.querySelector("#stabilizer");` +
      ` s.value = "${level}";` +
      ' s.dispatchEvent(new Event("input", { bubbles: true }));' +
      " return true; })()",
  );
  await sleep(100);
  await zigzag();
  const ink = await measure();
  console.log(
    `the stabiliser at ${level}: ${ink.count} pixels of ink,` +
      ` the line is ${ink.height} pixels high`,
  );
  // The line is taken back, so every setting is measured on its own.
  await devtools.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
    modifiers: 2,
  });
  await devtools.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
    modifiers: 2,
  });
  await sleep(250);
}

edge.kill();
