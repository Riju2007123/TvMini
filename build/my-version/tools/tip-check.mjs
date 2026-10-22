/**
 * Check that the shape of the brush sits under the pointer.
 *
 *   node tools/tip-check.mjs
 *
 * The program is opened in a headless browser, the pointer is put in a
 * known place on the stage, and the shape of the brush is looked for on the
 * sheet that lies on top of the stage. What is found is written down
 * together with the place the pointer is in, so the two can be compared.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-tip-check");
const PORT = 9341;

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

// The start screen is in the way of the stage, so it is put away first.
await devtools.run(
  '(() => { for (const b of document.querySelectorAll("button")) {' +
    ' if (b.textContent.trim() === "Start drawing") { b.click(); return "closed"; } }' +
    ' return "no start screen"; })()',
);
await sleep(400);

// The brush, and a width that is easy to measure.
await devtools.run('document.querySelector("#brushButton")?.click(); true');
// The start screen may still be there, and the panel comes back with the
// page, so the width is waited for.
for (let attempt = 0; attempt < 40; attempt += 1) {
  const there = await devtools.run('!!document.querySelector("#width")');
  if (there) break;
  await sleep(250);
}
await devtools.run(
  '(() => { const w = document.querySelector("#width"); w.value = "20";' +
    ' w.dispatchEvent(new Event("input", { bubbles: true })); return true; })()',
);
await sleep(300);

const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);
const info = await devtools.run(
  '(() => { const c = document.querySelector("#canvas");' +
    " return { bw: c.width, bh: c.height, doc: c.dataset.doc ?? \"\" }; })()",
);
console.log(`the stage is ${Math.round(box.w)} by ${Math.round(box.h)} pixels`);
console.log(`the buffer of the stage is ${info.bw} by ${info.bh}`);

// Three places on the stage.
const spots = [
  { name: "the middle", x: box.x + box.w / 2, y: box.y + box.h / 2 },
  { name: "a quarter", x: box.x + box.w / 4, y: box.y + box.h / 4 },
  { name: "near the edge", x: box.x + box.w * 0.8, y: box.y + box.h * 0.7 },
];

// A camera window, so the stage shows a crop of the canvas. The brush has
// to follow the pointer there as well.
await devtools.run('document.querySelector("#cameraTool")?.click(); true');
await sleep(200);
await devtools.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: box.x + box.w * 0.2,
  y: box.y + box.h * 0.2,
  button: "left",
  buttons: 1,
  clickCount: 1,
});
await devtools.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: box.x + box.w * 0.7,
  y: box.y + box.h * 0.8,
  button: "left",
  buttons: 1,
});
await devtools.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: box.x + box.w * 0.7,
  y: box.y + box.h * 0.8,
  button: "left",
  buttons: 0,
  clickCount: 1,
});
await sleep(400);
console.log(
  `after the camera: ${await devtools.run(
    'document.querySelector("#status")?.textContent ?? ""',
  )}`,
);
await devtools.run('document.querySelector("#brushButton")?.click(); true');
await sleep(300);

// The stage is zoomed in with the wheel, the way a person does it, and the
// brush is looked for again. The pointer does not move while the wheel
// turns, so this shows whether the shape of the brush keeps up.
await devtools.send("Input.dispatchMouseEvent", {
  type: "mouseWheel",
  x: box.x + box.w / 2,
  y: box.y + box.h / 2,
  deltaX: 0,
  deltaY: -120,
  button: "none",
  buttons: 0,
});
await sleep(400);

const zoomed = await devtools.run(
  '(() => { const c = document.querySelector("#canvas");' +
    ' const r = c.getBoundingClientRect();' +
    " return { zoom: document.querySelector(\"#zoomLabel\")?.textContent," +
    ` buffer: c.width + "x" + c.height, css: Math.round(r.width) + "x" + Math.round(r.height) }; })()`,
);
console.log(`after the wheel: ${JSON.stringify(zoomed)}`);

// The stage is dragged with the middle button, the way a person does it, and
// the brush is looked for again.
const panFrom = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
await devtools.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: panFrom.x,
  y: panFrom.y,
  button: "middle",
  buttons: 4,
  clickCount: 1,
});
await devtools.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: panFrom.x - 120,
  y: panFrom.y - 60,
  button: "middle",
  buttons: 4,
});
await devtools.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: panFrom.x - 120,
  y: panFrom.y - 60,
  button: "middle",
  buttons: 0,
  clickCount: 1,
});
await sleep(300);
console.log(
  `after the drag: ${await devtools.run(
    '(() => { const c = document.querySelector("#canvas");' +
      " return JSON.stringify({ transform: c.style.transform," +
      ' overlay: document.querySelector("#overlay").style.transform,' +
      ' scroll: Math.round(document.querySelector(".canvas-scroll").scrollLeft) + " by " +' +
      ' Math.round(document.querySelector(".canvas-scroll").scrollTop) }); })()',
  )}`,
);

for (const spot of spots) {
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: spot.x,
    y: spot.y,
    button: "none",
    buttons: 0,
  });
  await sleep(250);

  const found = await devtools.run(
    `(() => {
       const overlay = document.querySelector("#overlay");
       const ctx = overlay.getContext("2d");
       const { width, height } = overlay;
       const data = ctx.getImageData(0, 0, width, height).data;
       let left = width, top = height, right = -1, bottom = -1, count = 0;
       for (let y = 0; y < height; y += 1) {
         for (let x = 0; x < width; x += 1) {
           if (data[(y * width + x) * 4 + 3] > 20) {
             count += 1;
             if (x < left) left = x;
             if (x > right) right = x;
             if (y < top) top = y;
             if (y > bottom) bottom = y;
           }
         }
       }
       if (count === 0) return { count: 0 };
       const canvas = document.querySelector("#canvas");
       const rect = canvas.getBoundingClientRect();
       const sheet = overlay.getBoundingClientRect();
       const zoom = Number(
         (document.querySelector("#zoomLabel")?.textContent ?? "100%").replace("%", ""),
       ) / 100;
       const docWidth = rect.width / (zoom || 1);
       // Where the tip is on the screen: the sheet is stretched over the
       // place it covers, so the place in the buffer has to be scaled.
       const screenX = sheet.left + ((left + right) / 2) * (sheet.width / width);
       const screenY = sheet.top + ((top + bottom) / 2) * (sheet.height / height);
       return {
         count,
         left, top, right, bottom,
         screenX,
         screenY,
         scale: width / docWidth,
         overlayWidth: width,
         overlayHeight: height,
         rectWidth: rect.width,
       };
     })()`,
  );

  if (!found.count) {
    console.log(`${spot.name}: no brush shape was found on the sheet`);
    continue;
  }

  console.log(
    `${spot.name}: the pointer is at ${spot.x.toFixed(1)}, ${spot.y.toFixed(1)} on the screen,` +
      ` the brush is at ${found.screenX.toFixed(1)}, ${found.screenY.toFixed(1)}` +
      ` (off by ${(found.screenX - spot.x).toFixed(1)}, ${(found.screenY - spot.y).toFixed(1)})`,
  );
  console.log(
    `   the brush is ${found.right - found.left + 1} by ${found.bottom - found.top + 1} pixels big,` +
      ` the width is 20 and the scale is ${found.scale.toFixed(2)}`,
  );
}

// A stroke is drawn where the pointer is, and the ink is looked for.
const ink = { x: box.x + box.w * 0.3, y: box.y + box.h * 0.4 };
await devtools.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: ink.x,
  y: ink.y,
  button: "left",
  buttons: 1,
  clickCount: 1,
});
for (let step = 1; step <= 8; step += 1) {
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: ink.x + step * 12,
    y: ink.y + step * 6,
    button: "left",
    buttons: 1,
  });
}
await devtools.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: ink.x + 96,
  y: ink.y + 48,
  button: "left",
  buttons: 0,
  clickCount: 1,
});
await sleep(400);

const stroke = await devtools.run(
  `(() => {
     const c = document.querySelector("#canvas");
     const ctx = c.getContext("2d");
     const r = c.getBoundingClientRect();
     const zoom = Number(
       (document.querySelector("#zoomLabel")?.textContent ?? "100%").replace("%", ""),
     ) / 100;
     const docWidth = r.width / (zoom || 1);
     const scale = c.width / docWidth;
     // The place of the ink in the buffer, from the place of the pointer.
     const wantX = ((${ink.x} - r.left) / r.width) * c.width;
     const wantY = ((${ink.y} - r.top) / r.height) * c.height;
     // The ink that is on the canvas around that place.
     const left = Math.max(0, Math.round(wantX - 12));
     const top = Math.max(0, Math.round(wantY - 12));
     const size = 24;
     const data = ctx.getImageData(left, top, size, size).data;
     let ink = 0;
     let sumX = 0, sumY = 0;
     for (let y = 0; y < size; y += 1) {
       for (let x = 0; x < size; x += 1) {
         if (data[(y * size + x) * 4 + 3] > 20) {
           ink += 1;
           sumX += left + x;
           sumY += top + y;
         }
       }
     }
     return JSON.stringify({
       wantX, wantY,
       ink,
       centreX: ink ? sumX / ink : 0,
       centreY: ink ? sumY / ink : 0,
     });
   })()`,
);
console.log(`the stroke: ${stroke}`);

edge.kill();
