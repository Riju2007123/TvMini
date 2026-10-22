/**
 * Draw a line with a pen that presses harder and harder, and look at the
 * width of the line along the way.
 *
 *   node tools/pressure-check.mjs
 *
 * The width of the line should follow the pressure of the pen, and it
 * should follow it smoothly: the line is one shape, so the width changes
 * a little at a time and the edge of the line is one clean edge.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-pressure-check");
const PORT = 9353;

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

// A wide brush, so the width of the line is easy to see.
await devtools.run(
  '(() => { const w = document.querySelector("#width"); w.value = "30";' +
    ' w.dispatchEvent(new Event("input", { bubbles: true })); return true; })()',
);
await sleep(200);

const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);

/** The pen, pressed harder and harder. */
const pen = (type, x, y, buttons, force) =>
  devtools.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons,
    clickCount: 1,
    pointerType: "pen",
    force,
  });

const y = box.y + box.h / 2;
const x0 = box.x + box.w * 0.15;
await pen("mousePressed", x0, y, 1, 0.05);
for (let step = 1; step <= 40; step += 1) {
  await pen("mouseMoved", x0 + step * 12, y, 1, 0.05 + (step / 40) * 0.95);
}
await pen("mouseReleased", x0 + 40 * 12, y, 0, 1);
await sleep(400);

/** The width of the line in every column of it. */
const widths = await devtools.run(
  `(() => {
     const c = document.querySelector("#canvas");
     const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
     const out = [];
     for (let x = 0; x < c.width; x += 1) {
       let n = 0;
       for (let yy = 0; yy < c.height; yy += 1) {
         const i = (yy * c.width + x) * 4;
         if (data[i] + data[i + 1] + data[i + 2] < 600) n += 1;
       }
       if (n) out.push(n);
     }
     return JSON.stringify(out);
   })()`,
);

const profile = JSON.parse(widths);
if (!profile.length) {
  console.log("there is no line on the paper");
} else {
  const first = profile[0];
  const middle = profile[Math.floor(profile.length / 2)];
  const last = profile[profile.length - 1];
  let biggest = 0;
  let where = 0;
  for (let i = 1; i < profile.length; i += 1) {
    if (Math.abs(profile[i] - profile[i - 1]) > biggest) {
      biggest = Math.abs(profile[i] - profile[i - 1]);
      where = i;
    }
  }
  console.log(
    `the line is ${first} pixels wide at the start, ${middle} in the middle and ${last} at the end`,
  );
  console.log(
    `the width changes by at most ${biggest} pixel from one column to the next` +
      ` (the line is ${profile.length} columns long, the biggest step is at ${where})`,
  );
  console.log(`the widths: ${profile.slice(0, 12).join(" ")} ... ${profile.slice(-12).join(" ")}`);
}

edge.kill();
