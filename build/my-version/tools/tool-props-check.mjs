/**
 * Check the property of each tool, and that a stroke keeps its own brush.
 *
 *   node tools/tool-props-check.mjs
 *
 * The program is opened in a headless browser. Every tool is taken in the
 * hand and the section of the property panel is looked at. Then a stroke is
 * drawn with one brush, another brush is picked, and the ink of the first
 * stroke is looked at again: it must not have changed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSutBrush } from "../public/core/sut-write.js";
import { encodeRgbaPng } from "../src/png.js";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-tool-props-check");
const PORT = 9357;

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
await devtools.send("DOM.enable");

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

/* ------------------------------------------------- a section for every tool */

const TOOLS = [
  ["brushButton", "Brush"],
  ["pencilButton", "Pencil"],
  ["eraserButton", "Eraser"],
  ["lineTool", "Line"],
  ["rectTool", "Rectangle"],
  ["ellipseTool", "Ellipse"],
  ["fillTool", "Fill"],
  ["pickButton", "Pick a colour"],
  ["cameraTool", "Camera"],
];

for (const [button, title] of TOOLS) {
  await devtools.run(`document.querySelector("#${button}")?.click(); true`);
  await sleep(120);
  const panel = await devtools.run(
    '(() => ({ title: document.querySelector("#toolPropsTitle")?.textContent,' +
      ' width: document.querySelector("#width")?.value,' +
      ' rows: [...document.querySelectorAll(".tool-props > *")].filter((row) => !row.hidden).length,' +
      ' note: document.querySelector("#toolNote")?.hidden ? "" : document.querySelector("#toolNote")?.textContent }))()',
  );
  const right = panel.title === title ? "yes" : `no (it says ${panel.title})`;
  console.log(
    `${title}: the section says "${panel.title}" — ${right};` +
      ` ${panel.rows} settings shown; the width is ${panel.width}`,
  );
}

/* ------------------------------------------- the tools keep their own width */

await devtools.run('document.querySelector("#brushButton")?.click(); true');
await sleep(150);
const brushWidth = await devtools.run('document.querySelector("#width")?.value');
await devtools.run('document.querySelector("#pencilButton")?.click(); true');
await sleep(150);
const pencilWidth = await devtools.run('document.querySelector("#width")?.value');
await devtools.run(
  '(() => { const w = document.querySelector("#width"); w.value = "40";' +
    ' w.dispatchEvent(new Event("input", { bubbles: true })); return true; })()',
);
await sleep(150);
await devtools.run('document.querySelector("#brushButton")?.click(); true');
await sleep(150);
const brushWidthAgain = await devtools.run('document.querySelector("#width")?.value');
console.log(
  `the brush is ${brushWidth} wide, the pencil is ${pencilWidth} wide and was set to 40;` +
    ` the brush is ${brushWidthAgain} wide again`,
);

/* ------------------------------- a stroke keeps the brush it was drawn with */

await devtools.run('document.querySelector("#brushButton")?.click(); true');
await sleep(150);
const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);

/** Draw a stroke on the stage and say how much ink it left. */
async function drawStroke(atY = 120) {
  const start = { x: box.x + 120, y: box.y + atY };
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 10; step += 1) {
    await devtools.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + step * 14,
      y: start.y + step * 4,
      button: "left",
      buttons: 1,
    });
  }
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: start.x + 140,
    y: start.y + 40,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(400);
  return devtools.run(
    '(() => { const canvas = document.querySelector("#canvas");' +
      " const ctx = canvas.getContext(\"2d\");" +
      " const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;" +
      " let ink = 0;" +
      " for (let index = 0; index < data.length; index += 4) {" +
      "   if (data[index] < 250) ink += 1;" +
      " }" +
      ' return { ink, status: document.querySelector("#status")?.textContent ?? "" }; })()',
  );
}

const first = await drawStroke();
console.log(`a stroke with the round tip: ${JSON.stringify(first)}`);

// A brush with a picture, brought in from a file.
const png = encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, 255));
const brushFile = path.join(OUT, "a-brush.sut");
fs.writeFileSync(
  brushFile,
  await writeSutBrush({ name: "a brush with a tip", size: 20, texture: { data: png.toString("base64") } }),
);

await devtools.run('document.querySelector("#brushPanelButton")?.click(); true');
await sleep(300);
const document_ = await devtools.send("DOM.getDocument", { depth: -1 });
const inputNode = await devtools.send("DOM.querySelector", {
  nodeId: document_.root.nodeId,
  selector: "#brushDropInput",
});
await devtools.send("DOM.setFileInputFiles", { files: [brushFile], nodeId: inputNode.nodeId });
await sleep(300);
await devtools.run(
  '(() => { const input = document.querySelector("#brushDropInput");' +
    " input.dispatchEvent(new Event(\"change\", { bubbles: true })); return true; })()",
);
await sleep(700);
await devtools.run(
  '(() => { const close = document.querySelector("#brushDialog .overlay-close");' +
    " if (close) close.click(); return true; })()",
);
await sleep(300);

const afterChange = await devtools.run(
  '(() => { const canvas = document.querySelector("#canvas");' +
    " const ctx = canvas.getContext(\"2d\");" +
    " const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;" +
    " let ink = 0;" +
    " for (let index = 0; index < data.length; index += 4) {" +
    "   if (data[index] < 250) ink += 1;" +
    " }" +
    ' return { ink, brush: document.querySelector("#brushImageName")?.textContent }; })()',
);
console.log(
  `after the brush was changed: ${JSON.stringify(afterChange)}` +
    (afterChange.ink === first.ink
      ? " — the ink of the first stroke has not changed"
      : ` — the ink of the first stroke HAS changed (${first.ink} -> ${afterChange.ink})`),
);

const second = await drawStroke(220);
console.log(`a stroke with the new brush: ${JSON.stringify(second)}`);

// A picture of the panel, with the pencil in the hand.
await devtools.run('document.querySelector("#pencilButton")?.click(); true');
await sleep(300);
const shot = await devtools.send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(OUT, "panel.png"), Buffer.from(shot.data, "base64"));
console.log(`a picture of the panel: ${path.join(OUT, "panel.png")}`);

edge.kill();
