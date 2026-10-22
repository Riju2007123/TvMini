/**
 * Check that the flow, the hardness, the thickness and the grain of a brush
 * change what is painted on the stage.
 *
 *   node tools/brush-style-check.mjs
 *
 * The program is opened in a headless browser and five lines are drawn, one
 * under the other, each with one setting changed. The ink of every line is
 * measured from the pixels of the stage, so a setting that is read but not
 * used shows up as a line that is the same as the one above it.
 *
 * The line at the top is drawn at full flow, hard, round and without grain;
 * the others change one thing each, so every number can be compared with the
 * first one.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-brush-style-check");
const PORT = 9361;
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
await devtools.run('document.querySelector("#brushButton").click()');

/** Put a value into one of the sliders of the brush. */
const setSlider = (id, value) =>
  devtools.run(
    `(() => { const e = document.querySelector("#${id}");` +
      ` e.value = "${value}";` +
      ` e.dispatchEvent(new Event("input", { bubbles: true }));` +
      ` e.dispatchEvent(new Event("change", { bubbles: true }));` +
      ` return e.value; })()`,
  );

/** The ink the stage holds in a band of rows, in the pixels of the stage. */
const inkIn = (from, to) =>
  devtools.run(
    `(() => { const c = document.querySelector("#canvas");` +
      " const ctx = c.getContext(\"2d\");" +
      " const d = ctx.getImageData(0, " + from + ", c.width, " + (to - from) + ").data;" +
      " let ink = 0, dark = 0, mid = 0;" +
      " for (let i = 0; i < d.length; i += 4) {" +
      "  const v = (d[i] + d[i + 1] + d[i + 2]) / 3;" +
      "  ink += 255 - v;" +
      "  if (v < 200) dark += 1;" +
      "  if (v >= 200 && v < 250) mid += 1;" +
      " }" +
      " return { ink: Math.round(ink), dark, mid }; })()",
  );

/** Draw one line across the stage, at a row of the stage. */
async function drawLine(row, from, to) {
  const box = await devtools.run(
    '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
      " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
  );
  const canvas = await devtools.run(
    '(() => { const c = document.querySelector("#canvas"); return { w: c.width, h: c.height }; })()',
  );
  const y = box.y + ((row + 0.5) / canvas.h) * box.h;
  const x0 = box.x + (from / canvas.w) * box.w;
  const x1 = box.x + (to / canvas.w) * box.w;
  await devtools.run(
    `(() => {
      const canvas = document.querySelector("#canvas");
      const at = (part) => ({
        clientX: ${x0} + (${x1} - ${x0}) * part,
        clientY: ${y},
      });
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        ...at(0), pointerId: 1, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: 1, bubbles: true,
      }));
      for (let step = 0; step <= 40; step += 1) {
        canvas.dispatchEvent(new PointerEvent("pointermove", {
          ...at(step / 40), pointerId: 1, pointerType: "mouse", isPrimary: true,
          button: 0, buttons: 1, bubbles: true,
        }));
      }
      canvas.dispatchEvent(new PointerEvent("pointerup", {
        ...at(1), pointerId: 1, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: 0, bubbles: true,
      }));
      return "drawn";
    })()`,
  );
  await sleep(120);
}

// A wide brush, so the settings have room to show.
await setSlider("width", 26);
const rows = [70, 170, 270, 370, 470];
const band = (row) => [row - 22, row + 22];

const plain = { flow: 100, hardness: 100, thickness: 100, grain: 0 };
const sets = [
  { name: "plain" },
  { name: "flow 12", flow: 12 },
  { name: "hardness 0", hardness: 0 },
  { name: "thickness 30", thickness: 30 },
  { name: "grain 70", grain: 70 },
];

const measured = [];
for (const [index, set] of sets.entries()) {
  // Every line is drawn from the plain brush with one setting changed, so
  // every line can be compared with the one at the top.
  const values = { ...plain, ...set };
  for (const name of ["flow", "hardness", "thickness", "grain"]) {
    await setSlider(name, values[name]);
  }
  await drawLine(rows[index], 120, 840);
  const [from, to] = band(rows[index]);
  measured.push({ ...values, name: set.name, ...(await inkIn(from, to)) });
}

// The first line must not have changed when the settings of the others were
// made: a stroke keeps the settings it was drawn with.
const again = await inkIn(...band(rows[0]));

// Binarize is a hard edge: the same soft brush is drawn twice on a clean
// stage, once with its fade and once with every pixel of the tip made paint
// or paper.
const setBinarize = (on) =>
  devtools.run(
    '(() => { const box = document.querySelector("#binarize");' +
      ` box.checked = ${on};` +
      " box.dispatchEvent(new Event(\"change\", { bubbles: true })); return box.checked; })()",
  );

await devtools.run(
  '(() => { window.confirm = () => true;' +
    ' document.querySelector("#clearButton")?.click(); return true; })()',
);
await sleep(250);
await setSlider("hardness", 30);
await setSlider("grain", 0);
await setBinarize(false);
await drawLine(200, 120, 840);
const softEdge = await inkIn(178, 222);
await setBinarize(true);
await drawLine(350, 120, 840);
const hardEdge = await inkIn(328, 372);
console.log(`a soft edge: ${JSON.stringify(softEdge)}`);
console.log(`the same brush binarized: ${JSON.stringify(hardEdge)}`);
await setBinarize(false);
console.log(`the first line again: ${JSON.stringify(again)}`);

const first = measured[0];
console.log(`the stage is ${await devtools.run('document.querySelector("#canvas").width')} pixels wide`);
for (const line of measured) {
  const share = first.ink ? (line.ink / first.ink).toFixed(2) : "0";
  console.log(
    `${line.name.padEnd(12)} ink ${String(line.ink).padStart(7)} (${share} of the plain line) ` +
      `dark ${String(line.dark).padStart(6)} half ${String(line.mid).padStart(5)}`,
  );
}

const checks = [
  ["the flow leaves less paint", measured[1].ink < first.ink * 0.9],
  ["the hardness softens the edge", measured[2].mid > first.mid],
  ["the thickness makes a thinner line", measured[3].ink < first.ink * 0.8],
  ["the grain takes paint out", measured[4].ink < first.ink * 0.95],
  ["binarize takes the fade of the edge away", hardEdge.mid < softEdge.mid * 0.5],
  ["the first line kept the way it was drawn", again.ink === first.ink],
];

let failed = 0;

// A brush from Clip Studio Paint brings the paper it was made on. The brush
// on this machine is brought in through the page itself, and the same line is
// drawn twice: once with the paper the brush brought and once with the paper
// turned off.
const brushFile = [
  process.env.TVMINI_BRUSH,
  "C:\\Users\\MK\\Documents\\rough pen 3.sut",
  "C:\\Users\\MK\\Documents\\Thick Paint One.sut",
].filter(Boolean).find((candidate) => fs.existsSync(candidate));

if (!brushFile) {
  console.log("no brush of Clip Studio Paint was found, so the paper of a brush was not checked");
} else {
  const bytes = fs.readFileSync(brushFile);
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "access-control-allow-origin": "*",
    });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(9362, "127.0.0.1", resolve));

  // A new page, so that the lines above are not in the way.
  await devtools.send("Page.reload");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    const ready = await devtools.run(
      'document.readyState === "complete" && !!document.querySelector("#canvas")',
    );
    if (ready) break;
  }
  await sleep(400);
  await devtools.run(
    '(() => { for (const b of document.querySelectorAll("button")) {' +
      ' if (b.textContent.trim() === "Start drawing") { b.click(); return "closed"; } }' +
      ' return "no start screen"; })()',
  );
  await sleep(400);

  await devtools.run(
    `(async () => {
      const response = await fetch("http://127.0.0.1:9362/brush.sut");
      const file = new File([await response.blob()], "brush.sut");
      const input = document.querySelector("#brushDropInput");
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
      return "sent";
    })()`,
  );
  await sleep(2500);

  const card = await devtools.run(
    `(() => {
      const cards = [...document.querySelectorAll("#brushImported .brush-card-item")];
      const last = cards[cards.length - 1];
      if (!last) return null;
      const text = last.textContent;
      const use = [...last.querySelectorAll("button")].find((b) => b.textContent.trim() === "Use");
      if (use) use.click();
      return text;
    })()`,
  );
  await sleep(500);
  const inHand = await devtools.run(
    '(() => ({ width: document.querySelector("#width").value,' +
      ' grain: document.querySelector("#grain").value,' +
      ' flow: document.querySelector("#flow").value,' +
      ' thickness: document.querySelector("#thickness").value }))()',
  );
  console.log(`the brush brought in: ${String(card).replace(/\\s+/g, " ").trim()}`);
  console.log(`the panel now says: ${JSON.stringify(inHand)}`);

  const bigBand = (row) => [row - 50, row + 50];
  await drawLine(300, 120, 840);
  const withPaper = await inkIn(...bigBand(300));

  await setSlider("grain", 0);
  await drawLine(450, 120, 840);
  const withoutPaper = await inkIn(...bigBand(450));
  console.log(`the brush on its own paper: ${JSON.stringify(withPaper)}`);
  console.log(`the same brush on plain paper: ${JSON.stringify(withoutPaper)}`);

  checks.push([
    "a brush from Clip Studio Paint brings its paper",
    Boolean(card && /paper/.test(card)) && inHand.grain !== "0",
  ]);
  checks.push([
    "the paper of the brush takes paint out of the line",
    withPaper.ink < withoutPaper.ink * 0.98,
  ]);

  server.close();
}

for (const [name, ok] of checks) {
  console.log(`${ok ? "yes" : "NO "}  ${name}`);
  if (!ok) failed += 1;
}

// A line drawn with a grain is painted through a sheet of its own, so it is
// timed here: a brush that is slow to draw with is not a brush that feels
// like a brush. The lines are timed with the round tip of this program, so
// the numbers can be compared with the ones in the notes.
await devtools.run(
  '(() => { const card = document.querySelector("#brushBuiltins .brush-card-item");' +
    ' const use = card && [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Use");' +
    ' if (use) use.click(); return use ? "round tip" : "no round tip"; })()',
);
await sleep(300);
const timeStroke = async (width, row) => {
  await setSlider("width", width);
  const time = await devtools.run(
    `(() => {
      const canvas = document.querySelector("#canvas");
      const r = canvas.getBoundingClientRect();
      const moves = 60;
      const at = (index) => ({
        clientX: r.left + r.width / 4 + (index / moves) * (r.width / 2),
        clientY: r.top + r.height * ${row},
      });
      const started = performance.now();
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        ...at(0), pointerId: 1, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: 1, bubbles: true,
      }));
      for (let index = 0; index <= moves; index += 1) {
        canvas.dispatchEvent(new PointerEvent("pointermove", {
          ...at(index), pointerId: 1, pointerType: "mouse", isPrimary: true,
          button: 0, buttons: 1, bubbles: true,
        }));
      }
      canvas.dispatchEvent(new PointerEvent("pointerup", {
        ...at(moves), pointerId: 1, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: 0, bubbles: true,
      }));
      return performance.now() - started;
    })()`,
  );
  return time;
};
// The same line, timed in the three ways a brush can be painted: as one
// shape, as one shape on paper, and dab by dab on paper.
const timings = [
  { name: "one shape, no paper", flow: 100, grain: 0 },
  { name: "one shape on paper", flow: 100, grain: 60 },
  { name: "dab by dab on paper", flow: 40, grain: 60 },
];
for (const timing of timings) {
  await setSlider("flow", timing.flow);
  await setSlider("grain", timing.grain);
  for (const [width, row] of [[6, 0.55], [80, 0.7]]) {
    const time = await timeStroke(width, row);
    console.log(
      `${timing.name}, width ${String(width).padStart(2)}: ` +
        `60 moves ${time.toFixed(0).padStart(4)} ms (${(time / 60).toFixed(2)} ms each)`,
    );
  }
}

const shot = await devtools.send("Page.captureScreenshot", { format: "png" });
const file = path.join(OUT, "brush-style.png");
fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
console.log(`a picture of the stage: ${file}`);

edge.kill();
process.exit(failed ? 1 : 0);
