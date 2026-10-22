/**
 * Check the brush panel and the shape of the brush.
 *
 *   node tools/brush-check.mjs
 *
 * The program is opened in a headless browser. The shape of the brush is
 * looked for on the sheet that lies on top of the stage and compared with
 * the place the pointer is in. Then the brush panel is opened, a Clip Studio
 * Paint brush is brought in, and a brush is written out again and read back.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSutBrush } from "../public/core/sut-write.js";
import { readSutBrush } from "../public/core/sut.js";
import { encodeRgbaPng } from "../src/png.js";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TVMINI_URL ?? "http://127.0.0.1:4123";
const OUT = path.join(os.tmpdir(), "tvmini-brush-check");
const PORT = 9352;

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
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text ??
            "something went wrong",
        );
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
await devtools.send("DOM.enable");

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
await devtools.run('document.querySelector("#brushButton")?.click(); true');
await devtools.run(
  '(() => { const w = document.querySelector("#width"); w.value = "20";' +
    ' w.dispatchEvent(new Event("input", { bubbles: true })); return true; })()',
);
await sleep(300);

/* ------------------------------------------------------- the brush shape */

const box = await devtools.run(
  '(() => { const r = document.querySelector("#canvas").getBoundingClientRect();' +
    " return { x: r.left, y: r.top, w: r.width, h: r.height }; })()",
);

/** Draw a stroke on the stage and say how much ink it left. */
async function drawStroke() {
  const start = { x: box.x + 120, y: box.y + 120 };
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 12; step += 1) {
    await devtools.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + step * 12,
      y: start.y + step * 3,
      button: "left",
      buttons: 1,
    });
  }
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: start.x + 144,
    y: start.y + 36,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(400);
  return devtools.run(
    '(() => { const canvas = document.querySelector("#canvas");' +
      " const ctx = canvas.getContext(\"2d\");" +
      " const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;" +
      " let soft = 0, hard = 0;" +
      " for (let index = 0; index < data.length; index += 4) {" +
      "   const value = data[index];" +
      "   if (value < 250 && value > 5) soft += 1;" +
      "   if (value <= 5) hard += 1;" +
      " }" +
      ' return { soft, hard, status: document.querySelector("#status")?.textContent ?? "" }; })()',
  );
}

// A stroke with the round tip, to see that the stage paints at all.
await devtools.run('document.querySelector("#width").value = "20"; true');
const round = await drawStroke();
console.log(`a stroke with the round tip: ${JSON.stringify(round)}`);

/** Where the shape of the brush is on the screen, and where the pointer is. */
async function tipAt(x, y) {
  await devtools.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  await sleep(220);
  return devtools.run(
    `(() => {
       const overlay = document.querySelector("#overlay");
       const ctx = overlay.getContext("2d");
       const { width, height } = overlay;
       const data = ctx.getImageData(0, 0, width, height).data;
       let left = width, top = height, right = -1, bottom = -1, count = 0;
       for (let row = 0; row < height; row += 1) {
         for (let column = 0; column < width; column += 1) {
           if (data[(row * width + column) * 4 + 3] > 20) {
             count += 1;
             if (column < left) left = column;
             if (column > right) right = column;
             if (row < top) top = row;
             if (row > bottom) bottom = row;
           }
         }
       }
       if (count === 0) return { count: 0 };
       const sheet = overlay.getBoundingClientRect();
       return {
         count,
         screenX: sheet.left + ((left + right) / 2) * (sheet.width / width),
         screenY: sheet.top + ((top + bottom) / 2) * (sheet.height / height),
       };
     })()`,
  );
}

for (const [name, zoom] of [["at 100%", 0], ["zoomed in", 3]]) {
  for (let step = 0; step < zoom; step += 1) {
    await devtools.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: box.x + box.w / 2,
      y: box.y + box.h / 2,
      deltaX: 0,
      deltaY: -120,
      button: "none",
      buttons: 0,
    });
    await sleep(200);
  }

  const spot = { x: box.x + box.w * 0.4, y: box.y + box.h * 0.45 };
  const found = await tipAt(spot.x, spot.y);
  if (!found.count) {
    console.log(`${name}: no brush shape was found on the sheet`);
    continue;
  }
  console.log(
    `${name}: the pointer is at ${spot.x.toFixed(1)}, ${spot.y.toFixed(1)},` +
      ` the brush is at ${found.screenX.toFixed(1)}, ${found.screenY.toFixed(1)}` +
      ` (off by ${(found.screenX - spot.x).toFixed(1)}, ${(found.screenY - spot.y).toFixed(1)})`,
  );
}

/* --------------------------------------------------------- the brush panel */

await devtools.run('document.querySelector("#brushPanelButton")?.click(); true');
await sleep(300);

const panel = await devtools.run(
  '(() => { const dialog = document.querySelector("#brushDialog");' +
    ' if (!dialog || dialog.hidden) return { open: false };' +
    ' return { open: true,' +
    ' builtins: document.querySelectorAll("#brushBuiltins .brush-card-item").length,' +
    ' imported: document.querySelectorAll("#brushImported .brush-card-item").length }; })()',
);
console.log(`the brush panel: ${JSON.stringify(panel)}`);

// A Clip Studio Paint brush to bring in.
const png = encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, 255));
const brushFile = path.join(OUT, "brought-in.sut");
fs.writeFileSync(
  brushFile,
  await writeSutBrush({ name: "a brush from Clip Studio Paint", size: 17, texture: { data: png.toString("base64") } }),
);

const nodeId = await devtools.run(
  '(() => { const input = document.querySelector("#brushDropInput");' +
    " input.setAttribute(\"data-seen\", \"1\"); return input ? 1 : 0; })()",
);
const document_ = await devtools.send("DOM.getDocument", { depth: -1 });
const inputNode = await devtools.send("DOM.querySelector", {
  nodeId: document_.root.nodeId,
  selector: "#brushDropInput",
});
await devtools.send("DOM.setFileInputFiles", {
  files: [brushFile],
  nodeId: inputNode.nodeId,
});
await sleep(600);
await devtools.run(
  '(() => { const input = document.querySelector("#brushDropInput");' +
    " input.dispatchEvent(new Event(\"change\", { bubbles: true })); return true; })()",
);
await sleep(800);

const after = await devtools.run(
  '(() => ({ imported: document.querySelectorAll("#brushImported .brush-card-item").length,' +
    ' names: [...document.querySelectorAll("#brushImported .brush-card-name")].map((n) => n.textContent),' +
    ' status: document.querySelector("#status")?.textContent ?? "" }))()',
);
console.log(`after bringing a brush in: ${JSON.stringify(after)}`);

/* ------------------------------------- a brush of Clip Studio Paint itself */

// A brush that Clip Studio Paint wrote, so the shape of the tip and the
// settings of the brush can be checked.
const cspBrush = process.env.TVMINI_CSP_BRUSH ?? "C:\\Users\\MK\\Documents\\Real G-Pen 2.sut";
if (fs.existsSync(cspBrush)) {
  await devtools.send("DOM.setFileInputFiles", {
    files: [cspBrush],
    nodeId: inputNode.nodeId,
  });
  await sleep(400);
  await devtools.run(
    '(() => { const input = document.querySelector("#brushDropInput");' +
      " input.dispatchEvent(new Event(\"change\", { bubbles: true })); return true; })()",
  );
  await sleep(900);

  const csp = await devtools.run(
    '(() => ({ names: [...document.querySelectorAll("#brushImported .brush-card-name")].map((n) => n.textContent),' +
      ' sizes: [...document.querySelectorAll("#brushImported .brush-card-size")].map((n) => n.textContent),' +
      ' width: document.querySelector("#width")?.value,' +
      ' opacity: document.querySelector("#strokeOpacity")?.value }))()',
  );
  console.log(`a brush of Clip Studio Paint: ${JSON.stringify(csp)}`);

  // A stroke made with it, and a look at the ink: the shape of the tip of a
  // pen has a soft edge, where the round tip has a hard one. The panel is
  // closed first, because it lies over the stage.
  await devtools.run(
    '(() => { const close = document.querySelector("#brushDialog .overlay-close");' +
      " if (close) close.click(); return true; })()",
  );
  await sleep(300);
  await devtools.run('document.querySelector("#width").value = "30"; true');
  const ink = await drawStroke();
  console.log(`the ink of the stroke: ${JSON.stringify(ink)}`);
  console.log(
    ink.soft > 0
      ? "  the ink has a soft edge, so the shape of the tip of the brush was painted"
      : "  the ink has a hard edge, so the shape of the tip was NOT painted",
  );
  const shot = await devtools.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, "stage.png"), Buffer.from(shot.data, "base64"));
  console.log(`a picture of the stage: ${path.join(OUT, "stage.png")}`);

  // The tinting and the stamping on their own, so it is clear which part
  // of the brush painting is at fault.
  const probe = await devtools.run(
    '(() => { const canvas = document.querySelector("#canvas");' +
      " const ctx = canvas.getContext(\"2d\");" +
      ' const p = document.createElement("canvas"); p.width = 8; p.height = 8;' +
      ' const pc = p.getContext("2d"); pc.fillStyle = "#ff0000"; pc.fillRect(0, 0, 8, 8);' +
      ' const t = document.createElement("canvas"); t.width = 8; t.height = 8;' +
      ' const tc = t.getContext("2d"); tc.drawImage(p, 0, 0);' +
      ' tc.globalCompositeOperation = "source-in"; tc.fillStyle = "#000000";' +
      " tc.fillRect(0, 0, 8, 8);" +
      " const tint = [...tc.getImageData(0, 0, 1, 1).data].join(\",\");" +
      " ctx.drawImage(t, 200, 200, 30, 30);" +
      ' const painted = [...ctx.getImageData(205, 205, 1, 1).data].join(",");' +
      ' ctx.fillStyle = "#00ff00"; ctx.fillRect(210, 210, 20, 20);' +
      ' const filled = [...ctx.getImageData(215, 215, 1, 1).data].join(",");' +
      " const matrix = ctx.getTransform();" +
      ' return { tint, painted, filled, alpha: ctx.globalAlpha,' +
      ' mode: ctx.globalCompositeOperation, scale: matrix.a, offsetX: matrix.e }; })()',
  );
  console.log(`the tint and the stamp on their own: ${JSON.stringify(probe)}`);
  console.log(
    ink.soft > 0
      ? "  the ink has a soft edge, so the shape of the tip of the brush was painted"
      : "  the ink has a hard edge, so the shape of the tip was NOT painted",
  );
} else {
  console.log(`no brush of Clip Studio Paint at ${cspBrush}`);
}

/* ------------------------------------------------------- writing a brush out */

const folder = path.join(OUT, "files");
fs.mkdirSync(folder, { recursive: true });
const written = path.join(folder, "written-out.sut");
const clicked = await devtools.run(
  '(() => { const button = document.querySelector("#brushImported .brush-card-item button[title*=\\"Clip Studio Paint brush\\"]");' +
    " if (!button) return false; button.click(); return true; })()",
);
console.log(`the export button was pressed: ${clicked}`);
await sleep(500);

// The file dialog of the program: the folder, the name, Save.
const dialog = await devtools.run(
  '(() => { const modal = document.querySelector("#modal");' +
    ' if (!modal || modal.hidden) return "no dialog";' +
    " const dir = document.querySelector(\"#dirInput\");" +
    " dir.value = " + JSON.stringify(folder) + ";" +
    ' document.querySelector("#goButton").click();' +
    ' return "ok"; })()',
);
await sleep(600);
await devtools.run(
  '(() => { const input = document.querySelector("#nameInput");' +
    " input.value = \"written-out.sut\";" +
    ' input.dispatchEvent(new Event("input", { bubbles: true }));' +
    ' document.querySelector("#confirmButton").click();' +
    " return true; })()",
);

let status = "";
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(250);
  status = await devtools.run('document.querySelector("#status")?.textContent ?? ""');
  if (fs.existsSync(written)) break;
}
console.log(`the status says: ${status}`);

if (!fs.existsSync(written)) {
  console.log(`NO FILE at ${written}`);
} else {
  const bytes = fs.readFileSync(written);
  const brush = await readSutBrush(bytes);
  console.log(`the file that was written: ${bytes.length} bytes`);
  console.log(`  the brush in it is "${brush.name}" and is ${brush.size} pixels wide`);
  console.log(
    brush.texture
      ? `  the picture in it: ${brush.texture.width} by ${brush.texture.height}`
      : "  it holds no picture",
  );
}

edge.kill();
