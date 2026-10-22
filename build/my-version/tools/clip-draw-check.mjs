/**
 * Open a .clip file, draw on the frames that carry artwork, and see whether
 * the drawing shows up.
 *
 *   node tools/clip-draw-check.mjs [file]
 *
 * The file is opened the way a person opens it: the file menu, the entry
 * that imports a .clip, the path, and Open. Then a line is drawn with a pen
 * that presses harder and harder, on a frame that has imported artwork and
 * on a frame that has none. The paper is compared before and after, so only
 * the new ink is counted.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const FILE = process.argv[2] ?? "C:\\Users\\MK\\Documents\\Animation3.clip";
const OUT = path.join(os.tmpdir(), "tvmini-clip-draw-check");
const PORT = 9355;

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
    this.errors = [];
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve);
      this.socket.addEventListener("error", reject);
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      // A dialog that nobody answers stops the whole page.
      if (message.method === "Page.javascriptDialogOpening") {
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        this.errors.push(details?.exception?.description ?? details?.text ?? "an error");
        return;
      }
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ");
        this.errors.push(`${message.params.type}: ${text}`);
        return;
      }
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

// The file menu, and the entry that imports a .clip.
await devtools.run('document.querySelector("#fileButton").click(); true');
await sleep(200);
await devtools.run(
  '(() => { const b = document.querySelector(\'#fileMenu [data-action="importClip"]\');' +
    " if (b) { b.click(); return true; } return false; })()",
);
await sleep(600);

// The path of the file, and Open.
await devtools.run(
  `(() => {
     const dir = document.querySelector("#dirInput");
     const name = document.querySelector("#nameInput");
     dir.value = ${JSON.stringify(path.dirname(FILE))};
     name.value = ${JSON.stringify(path.basename(FILE))};
     document.querySelector("#goButton").click();
     return true;
   })()`,
);
await sleep(500);
await devtools.run(
  `(() => {
     const name = document.querySelector("#nameInput");
     name.value = ${JSON.stringify(path.basename(FILE))};
     name.dispatchEvent(new Event("input", { bubbles: true }));
     document.querySelector("#confirmButton").click();
     return true;
   })()`,
);
await sleep(20000);

const state = await devtools.run(
  '(() => {' +
    ' const label = document.querySelector("#frameLabel")?.textContent ?? "";' +
    " return JSON.stringify({" +
    '   status: document.querySelector("#status")?.textContent,' +
    "   frame: label," +
    " }); })()",
);
console.log(`after the import: ${state}`);

const frame = () =>
  devtools.run('document.querySelector("#frameLabel")?.textContent ?? ""');

/** A copy of the paper, so the ink before and after can be compared. */
const snapshot = async () =>
  devtools.run(
    '(() => {' +
      ' const c = document.querySelector("#canvas");' +
      ' const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;' +
      " return Array.from(data); })()",
  );

/** How many pixels are different between two copies of the paper. */
const changed = (before, after) => {
  let count = 0;
  for (let index = 0; index < before.length; index += 4) {
    if (
      before[index] !== after[index] ||
      before[index + 1] !== after[index + 1] ||
      before[index + 2] !== after[index + 2]
    ) {
      count += 1;
    }
  }
  return count;
};

const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);

const mouse = (type, x, y, buttons = 0, force = 0) =>
  devtools.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons,
    clickCount: 1,
    pointerType: force ? "pen" : "mouse",
    force,
  });

/** A line across the stage, drawn with a pen that presses harder and harder. */
async function drawLine() {
  const y = box.y + box.h / 2;
  await mouse("mousePressed", box.x + box.w * 0.3, y, 1, 0.2);
  for (let step = 1; step <= 10; step += 1) {
    await mouse("mouseMoved", box.x + box.w * (0.3 + step * 0.04), y, 1, 0.2 + step * 0.07);
  }
  await mouse("mouseReleased", box.x + box.w * 0.7, y, 0, 0.9);
  await sleep(900);
}

const key = async (name, code, virtual) => {
  await devtools.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: name,
    code,
    windowsVirtualKeyCode: virtual,
  });
  await devtools.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: name,
    code,
    windowsVirtualKeyCode: virtual,
  });
};

// 1. Draw on the frame the import left on. It carries imported artwork.
console.log(`\n-- on the frame the import left on (${await frame()})`);
const beforeHere = await snapshot();
await drawLine();
const afterHere = await snapshot();
const inkHere = changed(beforeHere, afterHere);
console.log(
  `   the new ink: ${inkHere} pixels` +
    ` (${inkHere > 200 ? "the drawing SHOWS" : "THE DRAWING IS INVISIBLE"})`,
);
console.log(`   the status line says: ${await devtools.run('document.querySelector("#status")?.textContent ?? ""')}`);

// 2. Walk to a frame that has nothing on it, and draw there.
console.log(`\n-- on a frame without artwork`);
for (let step = 0; step < 60; step += 1) {
  await key("ArrowRight", "ArrowRight", 39);
}
await sleep(800);
console.log(`   the frame now: ${await frame()}`);
const beforeEmpty = await snapshot();
await drawLine();
const afterEmpty = await snapshot();
const inkEmpty = changed(beforeEmpty, afterEmpty);
console.log(
  `   the new ink: ${inkEmpty} pixels` +
    ` (${inkEmpty > 200 ? "the drawing SHOWS" : "THE DRAWING IS INVISIBLE"})`,
);

// 3. "Hold +1": the cell under the pointer is made one frame longer.
console.log(`\n-- "Hold +1"`);
const beforeHold = await snapshot();
await devtools.run('document.querySelector("#holdButton")?.click(); true');
await sleep(800);
const afterHold = await snapshot();
console.log(
  `   the paper changed by ${changed(beforeHold, afterHold)} pixels` +
    `, the frame is ${await frame()}`,
);

// 4. Walk away and come back: the drawing has to be there.
console.log(`\n-- walking away and back`);
for (let step = 0; step < 5; step += 1) await key("ArrowLeft", "ArrowLeft", 37);
await sleep(500);
const away = await snapshot();
for (let step = 0; step < 5; step += 1) await key("ArrowRight", "ArrowRight", 39);
await sleep(500);
const back = await snapshot();
console.log(
  `   the drawing is still on the frame: ${changed(afterEmpty, back)} pixels differ` +
    ` (${changed(afterEmpty, back) === 0 ? "yes" : "NO, IT IS GONE"})`,
);

// 5. A layer that is hidden: drawing on it must not vanish.
console.log(`\n-- drawing on a hidden layer`);
const hidden = await devtools.run(
  '(() => {' +
    ' const row = [...document.querySelectorAll(".layer-row")].find((item) => {' +
    '   const eye = item.querySelector(".layer-eye");' +
    '   if (!eye || eye.title !== "Show this layer") return false;' +
    '   const name = item.querySelector(".layer-name")?.textContent ?? "";' +
    '   return !name.includes(":");' +
    " });" +
    ' if (!row) return null;' +
    ' const name = row.querySelector(".layer-name")?.textContent ?? "";' +
    ' row.querySelector(".layer-name").click();' +
    " return name; })()",
);
console.log(`   the hidden layer: ${hidden ?? "none found"}`);
await sleep(400);
const hiddenBefore = await snapshot();
await drawLine();
const hiddenAfter = await snapshot();
const hiddenInk = changed(hiddenBefore, hiddenAfter);
console.log(
  `   the new ink: ${hiddenInk} pixels` +
    ` (${hiddenInk > 200 ? "the drawing SHOWS" : "THE DRAWING IS INVISIBLE"})`,
);
console.log(`   the status line says: ${await devtools.run('document.querySelector("#status")?.textContent ?? ""')}`);

// 6. The length of the document: the field, and a shorter document.
console.log(`\n-- the length of the document`);
const length = await devtools.run(
  '(() => { const field = document.querySelector("#frameCount");' +
    " return field ? field.value : \"no field\"; })()",
);
console.log(`   the field says: ${length} frames`);
await devtools.run(
  '(() => { const field = document.querySelector("#frameCount");' +
    ' field.value = "20";' +
    ' field.dispatchEvent(new Event("change", { bubbles: true }));' +
    " return true; })()",
);
await sleep(900);
console.log(
  `   after setting it to 20: the readout says ${await devtools.run(
    'document.querySelector("#frameReadout")?.textContent ?? ""',
  )}`,
);
console.log(
  `   the status line says: ${await devtools.run('document.querySelector("#status")?.textContent ?? ""')}`,
);

if (devtools.errors.length) {
  console.log("\nwhat the program said:");
  for (const line of devtools.errors.slice(0, 10)) console.log(`   ${line}`);
} else {
  console.log("\nthe program said nothing wrong");
}

edge.kill();
