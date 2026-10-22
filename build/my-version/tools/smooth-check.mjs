/**
 * Measure how much the smoothing takes the tremble out of a line.
 *
 *   node tools/smooth-check.mjs
 *
 * The same shaky line is drawn on the stage with the smoothing off and
 * with it on, and the thickness of the line is measured. A line that is
 * smooth is thinner, because the tremble of the hand is gone.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-smooth-check");
const PORT = 9351;

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

/** The ink on the paper, and how far the line wanders up and down. */
const measure = async () =>
  JSON.parse(
    await devtools.run(
      `(() => {
         const c = document.querySelector("#canvas");
         const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
         let count = 0;
         const centres = [];
         for (let x = 0; x < c.width; x += 1) {
           let sum = 0, n = 0;
           for (let y = 0; y < c.height; y += 1) {
             const i = (y * c.width + x) * 4;
             if (data[i] + data[i + 1] + data[i + 2] < 600) {
               count += 1; sum += y; n += 1;
             }
           }
           if (n) centres.push(sum / n);
         }
         const wander = centres.length
           ? Math.max(...centres) - Math.min(...centres) : 0;
         return JSON.stringify({ count, wander });
       })()`,
    ),
  );

/** A line with a tremble in it, the way a hand moves. */
const shaky = async () => {
  const startX = box.x + box.w * 0.2;
  const y = box.y + box.h * 0.5;
  await mouse("mousePressed", startX, y, 1);
  // The points are near each other, the way the samples of a pen are.
  for (let step = 1; step <= 120; step += 1) {
    const tremble = step % 2 === 0 ? 1.2 : -1.2;
    await mouse("mouseMoved", startX + step * 3, y + tremble, 1);
  }
  await mouse("mouseReleased", startX + 120 * 3, y, 0);
  await sleep(300);
};

const setSmooth = async (value) => {
  await devtools.run(
    `(() => { const s = document.querySelector("#smooth");` +
      ` s.value = "${value}";` +
      ' s.dispatchEvent(new Event("input", { bubbles: true })); return true; })()',
  );
  await sleep(100);
};

const undo = async () => {
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
};

for (const level of [0, 20, 50, 100]) {
  await setSmooth(level);
  await shaky();
  const ink = await measure();
  console.log(
    `the smoothing at ${level}: the line wanders ${ink.wander.toFixed(2)} pixels,` +
      ` ${ink.count} pixels of ink`,
  );
  await undo();
}

edge.kill();
