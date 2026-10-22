/**
 * Measure how sharp a line is on the stage.
 *
 *   node tools/sharpness-check.mjs
 *
 * A line is drawn while the stage is magnified, and the pixels that cross
 * it are read. A line that is drawn in the pixels of the screen has one
 * hard edge; a line that is drawn in the pixels of the document and then
 * made bigger has a soft edge, and many shades of grey in between.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-sharpness-check");
const PORT = 9349;

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
    // The button that is pressed, or the one that is let go.
    button: "left",
    buttons,
    clickCount: 1,
  });

// Magnify the stage, the way a person does.
await mouse("mouseMoved", box.x + box.w / 2, box.y + box.h / 2);
for (let step = 0; step < 6; step += 1) {
  // The stage grows under the pointer, so the place of the wheel is read
  // again every time.
  const spot = await devtools.run(
    '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
      " return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
  );
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: spot.x,
    y: spot.y,
    deltaX: 0,
    deltaY: -120,
    button: "none",
    buttons: 0,
  });
  await sleep(80);
}
await sleep(400);
const zoom = await devtools.run('document.querySelector("#zoomLabel")?.textContent ?? ""');
const sizes = await devtools.run(
  '(() => { const c = document.querySelector("#canvas");' +
    ' const r = c.getBoundingClientRect();' +
    " return c.width + \"x\" + c.height + \" in \" + Math.round(r.width) + \"x\" + Math.round(r.height); })()",
);
console.log(`the stage is at ${zoom} (${sizes})`);

// A line across the stage, drawn with a pen that presses harder and harder.
const line = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);
const y = line.y + line.h / 2;
await mouse("mousePressed", line.x + line.w * 0.3, y, 1);
for (let step = 1; step <= 10; step += 1) {
  await mouse("mouseMoved", line.x + line.w * (0.3 + step * 0.04), y, 1);
}
await mouse("mouseReleased", line.x + line.w * 0.7, y, 0);
await sleep(400);

/** The ink on a canvas, and how wide its soft edge is. */
const shades = async (which) =>
  JSON.parse(
    await devtools.run(
      `(() => {
         const el = document.querySelector(${JSON.stringify(which)});
         const c = el.getContext("2d");
         const width = el.width;
         const height = el.height;
         if (!width || !height) return JSON.stringify({ error: "the canvas is empty" });
         const data = c.getImageData(0, 0, width, height).data;
         const at = (x, y) => {
           const i = (y * width + x) * 4;
           return data[i + 3] < 20 ? -1 : data[i] + data[i + 1] + data[i + 2];
         };
         // The place of the ink.
         let left = width, right = -1, top = height, bottom = -1;
         for (let y = 0; y < height; y += 1) {
           for (let x = 0; x < width; x += 1) {
             if (at(x, y) >= 0 && at(x, y) < 300) {
               if (x < left) left = x;
               if (x > right) right = x;
               if (y < top) top = y;
               if (y > bottom) bottom = y;
             }
           }
         }
         if (right < 0) return JSON.stringify({ error: "there is no ink" });
         // A column through the middle of the ink: the shades from the top
         // of the line to the bottom of it.
         const x = Math.round((left + right) / 2);
         const column = [];
         for (let y = top - 3; y <= bottom + 3; y += 1) {
           if (y < 0 || y >= height) continue;
           column.push(at(x, y));
         }
         const soft = column.filter((v) => v > 300 && v < 700).length;
         return JSON.stringify({ left, right, top, bottom, column, soft });
       })()`,
    ),
  );

const report = (name, values) => {
  if (!values || values.error) {
    console.log(`${name}: ${JSON.stringify(values)}`);
    return;
  }
  console.log(
    `${name}: the line is ${values.bottom - values.top + 1} pixels high,` +
      ` ${values.soft} of them are a soft edge`,
  );
  console.log(`   the shades: ${values.column.join(" ")}`);
};

report("the sheet on top of the stage", await shades("#overlay"));
report("the stage itself", await shades("#canvas"));
console.log(
  `the way the layer was drawn: ${await devtools.run("window.__tvPath ?? \"none\"")}`,
);

edge.kill();
