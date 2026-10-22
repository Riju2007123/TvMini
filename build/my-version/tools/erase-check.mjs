/**
 * Check that the eraser takes ink away while it moves, and not only when
 * the pointer is let go.
 *
 *   node tools/erase-check.mjs
 *
 * A line is drawn, the eraser is taken in the hand and put on that line,
 * and the paper is looked at while the pointer is still down.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-erase-check");
const PORT = 9343;

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
await sleep(400);

// Wait until the stage is drawn, so the test does not measure an empty
// canvas.
for (let attempt = 0; attempt < 40; attempt += 1) {
  const ready = await devtools.run(
    '(() => { const c = document.querySelector("#canvas");' +
      " const d = c.getContext(\"2d\").getImageData(0, 0, c.width, c.height).data;" +
      " for (let i = 0; i < d.length; i += 4) if (d[i] > 200) return true;" +
      " return false; })()",
  );
  if (ready) break;
  await sleep(250);
}

const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);

/** How much ink is on the whole canvas, in the pixels of the buffer. */
const inkAt = async () =>
  Number(
    await devtools.run(
      `(() => {
         const c = document.querySelector("#canvas");
         const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
         let count = 0;
         for (let i = 0; i < data.length; i += 4) {
           // The paper is white and the ink is dark.
           if (data[i] + data[i + 1] + data[i + 2] < 600) count += 1;
         }
         return String(count);
       })()`,
    ),
  );

/** A small picture of the canvas, so what is on it can be seen. */
const picture = async () =>
  await devtools.run(
    `(() => {
       const c = document.querySelector("#canvas");
       const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
       const columns = 60;
       const rows = 20;
       let out = "";
       for (let row = 0; row < rows; row += 1) {
         for (let column = 0; column < columns; column += 1) {
           const x = Math.floor((column * c.width) / columns);
           const y = Math.floor((row * c.height) / rows);
           const i = (y * c.width + x) * 4;
           const dark = data[i] + data[i + 1] + data[i + 2] < 600;
           out += dark ? "#" : ".";
         }
         out += "\\n";
       }
       return out;
     })()`,
  );

const mouse = (type, x, y, buttons = 0) =>
  devtools.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    // The button that is pressed, or the one that is let go.
    button: "left",
    buttons,
    clickCount: 1,
  });

await devtools.run(
  `(() => {
     window.__events = [];
     const c = document.querySelector("#canvas");
     for (const type of ["pointerdown", "pointerup", "pointermove", "pointercancel", "lostpointercapture"]) {
       c.addEventListener(type, (event) => {
         window.__events.push(type + " buttons=" + event.buttons);
       });
     }
     window.addEventListener("pointerup", (event) => window.__events.push("window pointerup"));
     return true;
   })()`,
);

// A line of ink.
const y = box.y + box.h / 2;
const from = box.x + box.w * 0.3;
const to = box.x + box.w * 0.7;
await mouse("mousePressed", from, y, 1);
for (let step = 1; step <= 10; step += 1) {
  await mouse("mouseMoved", from + ((to - from) * step) / 10, y, 1);
}
await mouse("mouseReleased", to, y, 0);
await sleep(300);
console.log(`the ink on the canvas: ${await inkAt()}`);
console.log(
  `the status after the stroke: ${await devtools.run(
    'document.querySelector("#status")?.textContent ?? ""',
  )}`,
);
console.log(
  `the events: ${await devtools.run(
    'JSON.stringify((window.__events || []).slice(0, 6).concat(["..."], (window.__events || []).slice(-4)))',
  )}`,
);

// The eraser is taken in the hand and put on the line.
await devtools.run('document.querySelector("#eraserButton").click(); true');
await sleep(200);
const middle = (from + to) / 2;
await mouse("mousePressed", middle, y, 1);
await sleep(200);
console.log(`the ink while the eraser is down: ${await inkAt()}`);
await mouse("mouseMoved", middle + 20, y, 1);
await sleep(200);
console.log(`the ink after the eraser moved: ${await inkAt()}`);
await mouse("mouseReleased", middle + 20, y, 0);
await sleep(300);
console.log(`the ink when the eraser is let go: ${await inkAt()}`);
console.log(
  `the status: ${await devtools.run('document.querySelector("#status")?.textContent ?? ""')}`,
);

// How long a move of the eraser takes, and how long a move of the brush
// takes, so the two can be compared.
const timeMoves = async (tool) => {
  await devtools.run(`document.querySelector("#${tool}Button").click(); true`);
  await sleep(150);
  const start = Date.now();
  await mouse("mousePressed", box.x + box.w * 0.3, y, 1);
  for (let step = 0; step < 30; step += 1) {
    await mouse("mouseMoved", box.x + box.w * (0.3 + step * 0.01), y, 1);
  }
  await mouse("mouseReleased", box.x + box.w * 0.6, y, 0);
  return (Date.now() - start) / 30;
};
console.log(`a move of the brush takes ${(await timeMoves("brush")).toFixed(1)} milliseconds`);
console.log(`a move of the eraser takes ${(await timeMoves("eraser")).toFixed(1)} milliseconds`);

console.log(await picture());

edge.kill();
