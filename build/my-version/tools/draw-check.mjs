/**
 * Measure how the stage keeps up with the pointer.
 *
 *   node tools/draw-check.mjs [moves]
 *
 * The program is opened in a headless browser, the pointer is moved over the
 * stage and then dragged across it, and the time each move takes is written
 * down. It is the test of the thing that made the stage lag: a document that
 * is drawn again for every move of the pointer.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-draw-check");
const PORT = 9339;
const MOVES = Number(process.argv[2] ?? 60);
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

const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);
console.log(`the stage is ${Math.round(box.w)} by ${Math.round(box.h)} pixels`);
console.log(
  `the sheet on top: ${await devtools.run(
    '(() => { const o = document.querySelector("#overlay"); if (!o) return "missing";' +
      ' const s = getComputedStyle(o);' +
      " return o.width + 'x' + o.height + ', pointer-events: ' + s.pointerEvents; })()",
  )}`,
);
console.log(
  `the pane scrolls: ${await devtools.run(
    '(() => { const w = document.querySelector(".canvas-wrap");' +
      ' return w.scrollWidth + " wide in " + w.clientWidth + ", " + w.scrollHeight + " high in " + w.clientHeight +' +
      ' ", bars: " + (w.offsetWidth - w.clientWidth) + " by " + (w.offsetHeight - w.clientHeight); })()',
  )}`,
);

// Does scrolling the pane move the canvas? The zoom makes the document larger
// than the pane, so there is something to scroll in both directions.
const scrolled = await devtools.run(
  '(() => { const canvas = document.querySelector("#canvas");' +
    " const r = canvas.getBoundingClientRect();" +
    ' for (let i = 0; i < 4; i += 1) canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -240,' +
    " clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));" +
    ' const w = document.querySelector(".canvas-wrap");' +
    ' const before = canvas.getBoundingClientRect();' +
    " w.scrollLeft = 300; w.scrollTop = 60;" +
    ' const after = canvas.getBoundingClientRect();' +
    ' return "the stage is " + Math.round(after.width) + " wide, left " + Math.round(before.left) +' +
    ' " -> " + Math.round(after.left) + ", top " + Math.round(before.top) + " -> " + Math.round(after.top) +' +
    ' " (scrollLeft " + w.scrollLeft + ", scrollTop " + w.scrollTop + ")"; })()',
);
console.log(`scrolling the pane: ${scrolled}`);

const mouse = (type, x, y, button = "none", buttons = 0) =>
  devtools.send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button,
    buttons,
    clickCount: type === "mousePressed" ? 1 : 0,
    pointerType: "mouse",
  });

const middleX = box.x + box.w / 2;
const middleY = box.y + box.h / 2;

// The pointer moving over the stage without a button down. The moves are
// made inside the page, so the time is the time of the program and not the
// time of the test.
const hover = await devtools.run(
  `(() => {
    const canvas = document.querySelector("#canvas");
    const r = canvas.getBoundingClientRect();
    const moves = ${MOVES};
    const started = performance.now();
    for (let index = 0; index < moves; index += 1) {
      canvas.dispatchEvent(new PointerEvent("pointermove", {
        clientX: r.left + r.width / 2 + Math.sin(index / 3) * (r.width / 4),
        clientY: r.top + r.height / 2 + Math.cos(index / 5) * (r.height / 4),
        pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true,
      }));
    }
    return performance.now() - started;
  })()`,
);
console.log(`${MOVES} moves over the stage: ${hover.toFixed(0)} ms (${(hover / MOVES).toFixed(2)} ms each)`);

// The pointer drawing a stroke.
const stroke = await devtools.run(
  `(() => {
    const canvas = document.querySelector("#canvas");
    const r = canvas.getBoundingClientRect();
    const moves = ${MOVES};
    const at = (index) => ({
      clientX: r.left + r.width / 4 + (index / moves) * (r.width / 2),
      clientY: r.top + r.height / 2 + Math.sin(index / 4) * (r.height / 6),
    });
    const started = performance.now();
    canvas.dispatchEvent(new PointerEvent("pointerdown", {
      ...at(0), pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, bubbles: true,
    }));
    for (let index = 0; index < moves; index += 1) {
      canvas.dispatchEvent(new PointerEvent("pointermove", {
        ...at(index), pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, bubbles: true,
      }));
    }
    const last = at(moves);
    canvas.dispatchEvent(new PointerEvent("pointerup", {
      ...last, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0, bubbles: true,
    }));
    return performance.now() - started;
  })()`,
);
console.log(`${MOVES} moves of a stroke: ${stroke.toFixed(0)} ms (${(stroke / MOVES).toFixed(2)} ms each)`);

// Is there ink on the stage?
const ink = await devtools.run(
  '(() => { const c = document.querySelector("#canvas"); const d = c.getContext("2d")' +
    ".getImageData(0, 0, c.width, c.height).data;" +
    " let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200) n++;" +
    " return n; })()",
);
console.log(`dark pixels on the stage: ${ink}`);
console.log(`the status bar says: ${await devtools.run('document.querySelector("#status")?.textContent ?? ""')}`);

// A picture of the stage, so the drawing can be looked at.
const shot = await devtools.send("Page.captureScreenshot", { format: "png" });
const file = path.join(OUT, "stage.png");
fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
console.log(`a picture of the stage: ${file}`);

edge.kill();
