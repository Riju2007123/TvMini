# TVMini — clean-room drawing + animation timeline

A small, self-contained drawing and 2D animation app. It implements the four
behaviours the TVPaint demo blocks **and** a simple timeline/animation-layer
model. It shares **no code, data or file formats** with TVPaint.

- No dependencies. Node 20+ (Node 22.5+ for `.clip` import).
- The UI is plain HTML/CSS/JS served by a loopback-only HTTP server.
- Project files use `*.tvmini` (JSON), **not** `.tvpp`.
- Clip Studio `.clip` files can be imported read-only (preview image only).
- One canvas, up to 100 animation layers, current-frame PNG export.

## Run

```powershell
cd build\my-version
node server.js
# open http://127.0.0.1:4123
```

Custom port:

```powershell
node server.js --port 5000
```

## Test

```powershell
npm test
# or
node --test
```

## What each feature does

| Feature | Behaviour | Code |
|---|---|---|
| Save | writes the current path atomically | `src/store.js` `saveProject` |
| Save As | picks a path, appends `.tvmini`, confirms overwrite | `public/app.js` `saveAs` |
| Export PNG | renders the current frame and writes a PNG | `src/png.js`, `src/store.js` `exportPng` |
| Import `.clip` | loads the preview stored in a Clip Studio file | `src/clip.js` |
| Recent | MRU list, max 50, de-duplicated, pruned | `src/recent.js` |
| Pen pressure | width follows `PointerEvent.pressure` | `public/app.js`, `src/png.js` |
| Eraser | clears its own layer, revealing lower layers/image | `public/app.js`, `src/png.js` |
| Undo / redo | 100-step document history, toolbar + shortcuts | `public/app.js` |
| Timeline | layers, drawings, holds, before/after behaviour | `public/timeline.js` |
| Playback | FPS, start frame, loop, frame stepping | `public/app.js` |

Key guarantees:

- **No silent failure.** Every error becomes an HTTP 4xx/5xx with a message and
  is shown in the status bar.
- **Atomic writes.** Data goes to a temp file, is fsynced, then renamed. A
  failed save leaves the old file intact.
- **Recent only changes on success.** `POST /api/save` and `POST /api/open`
  update the list only after the file operation succeeds.

## Timeline and animation layers

A project is a stack of animation layers. Layer 0 is the **top** layer; the
timeline lists them top-to-bottom and the renderer composites bottom-to-top.

Each layer has a name, visibility, lock, opacity, before/after behaviour and a
list of drawings:

```json
{
  "name": "Layer 1",
  "preBehavior": "none",
  "postBehavior": "hold",
  "drawings": [
    { "at": 1, "hold": 2, "strokes": [] },
    { "at": 5, "hold": 1, "strokes": [] }
  ]
}
```

- `at` is an absolute frame number.
- `hold` is how many frames the drawing stays on screen.
- Held frames edit the drawing that owns them.
- Drawings are sorted and never overlap.
- New layers default to `preBehavior: "none"`, `postBehavior: "hold"`. These
  are clean-room UX defaults; TVPaint's defaults were not established.

Timeline cells:

| Cell | Meaning |
|---|---|
| `●` | first frame of a drawing |
| `·` | held frame of that drawing |
| `◌` | virtual frame produced by before/after behaviour |
| blank | nothing is exposed |

Before/after behaviour:

| value | outside the layer's first/last drawing |
|---|---|
| `none` | show nothing |
| `hold` | hold the first (before) or last (after) drawing |
| `repeat` | repeat the exposed range |
| `pingpong` | reflect the exposed range |

Toolbar actions:

- **Play/Pause**, **Loop**, **FPS** (1–120), **Start** (1–100000).
- **+ Layer / − Layer / ↑ / ↓**.
- **+ Drawing**: insert a blank drawing at the current frame. At the head of
  an exposure, later drawings shift right; inside an exposure, the exposure
  is split.
- **Duplicate**: copy the current drawing directly after its exposure.
- **Hold +1**: extend the current exposure by one frame.
- **Delete**: remove the current drawing and close its gap.
- **Exposure**: set the current drawing's hold to a whole number.
- Changing **Start** moves drawings and the playhead by the same delta.

The tools panel edits the current layer's name, opacity and before/after
behaviour. **Clear drawing** empties its strokes. Visibility and lock icons are
in each timeline row.

### Drawing rules

- A hidden or locked layer cannot be drawn on.
- Drawing on an empty or virtual frame creates a new one-frame drawing there.
- An eraser clears only its own layer. Lower layers, the imported `.clip`
  preview and the background show through.
- Export composites: background → `.clip` image → visible layers at the
  current frame, applying each layer's opacity and before/after behaviour.

## Keyboard and mouse

- Drag on the canvas to draw.
- `B` / `E` — brush / eraser.
- `Ctrl+Z` — undo; `Ctrl+A`, `Ctrl+Y`, `Ctrl+Shift+Z` — redo.
- `Ctrl+S` / `Ctrl+Shift+S` — save / save as.
- `Ctrl+O` / `Ctrl+N` — open / new.
- `Space` — play/pause.
- `←` / `→` — step one frame.
- Click any timeline cell to select its layer and frame.

`Ctrl+A` inside a text field selects text instead of redoing.

## Data format

A `.tvmini` file is UTF-8 JSON, version 2. Top-level fields:

`format`, `version`, `width`, `height`, `background`, `image`, `fps`,
`startFrame`, `currentLayer`, `currentFrame`, `loop`, `layers`.

`image` is an optional base64 PNG used by `.clip` import; it is drawn under
every animation layer and must match the canvas size. Version 1 files (flat
`strokes`) are migrated on load into one layer with one drawing at frame 1.

Validation and limits are in `src/model.js` and `SPEC.md` section 3.

## Pen pressure

A stylus reports `PointerEvent.pressure` between 0 and 1. When "Pen pressure"
is on (the default), every point stores that value as a third coordinate:

```json
"points": [[100, 20, 0.15], [140, 90, 0.85]]
```

Stroke diameter = `width × (0.2 + 0.8 × pressure)`, so light strokes stay
visible at 20 % of the slider value and full pressure reaches 100 %.

The same formula is used by `src/png.js`, so the exported PNG matches what you
see on screen. Mouse and touch input keep plain `[x, y]` points and a constant
width. Old files with 2-element points still load unchanged.

## Eraser

Choose **Brush** or **Eraser** in the tools panel, or press `B` / `E`. An eraser
stroke is stored as a normal stroke with one extra flag:

```json
{ "color": "#000000", "width": 20, "points": [[30, 30]], "eraser": true }
```

Strokes are drawn on a transparent layer above the background and any imported
image. An eraser stroke clears only that layer (`destination-out` in the
browser, alpha clearing in `src/png.js`), so lower layers, the white canvas or
the `.clip` preview show through — not a painted-on white line. It uses the
same width slider and pressure taper, is undoable like any stroke, and exports
identically.

## Undo / redo

Each finished stroke and each document edit records a snapshot *before* the
change. That includes timeline edits: add/duplicate/hold/delete drawing,
exposure, start frame, FPS, loop, layer add/delete/move/rename, visibility,
lock, opacity, behaviour and Clear.

- 100 steps are kept; the oldest is dropped.
- A new change after an undo throws away the redo branch.
- New, Open and `.clip` import reset the history.
- Undo/redo mark the document unsaved; Save still goes to the same path.

## Clip Studio `.clip` import

A `.clip` file starts with `CSFCHUNK` and contains an embedded SQLite database.
TVMini reads that database read-only, takes the `CanvasPreview` PNG and makes it
the new canvas:

1. File → **Import .clip preview…** (or Open… and pick a `.clip`).
2. The canvas becomes the preview's pixel size; the image sits under the
   animation layers as a read-only timeline row.
3. Save As writes a normal `.tvmini` that embeds the preview, so the project
   still opens without the original file.

The original `.clip` is **never written**. Only the flattened preview is
imported — layers, timelines and vector data are not. Canvases must be within
16…4096 px. Node 22.5+ is required for the built-in `node:sqlite` reader.

## Layout

```
build/my-version/
  server.js            HTTP API + static server
  src/model.js         project schema + validation + v1 migration
  src/store.js         atomic save/load/export
  src/png.js           rasteriser + PNG encoder/decoder (zlib)
  src/clip.js          read-only Clip Studio preview import
  src/recent.js        persistent MRU
  public/timeline.js   shared frame/exposure/behaviour logic
  public/app.js        canvas, timeline UI, history
  test/                node:test suites
```

`public/timeline.js` is pure logic shared by the browser, the server-side PNG
renderer and the tests, so exposure lookup has one definition.

## Mapping to the report

`REPORT.md` explains what the demo does. This app is the opposite of each
finding:

| Demo behaviour | TVMini behaviour |
|---|---|
| Save slot is `xor eax,eax; ret` | real serialiser + atomic rename |
| Export guards return 0 / -1 behind a modal | real PNG writer, real result code |
| Recent is fed only by the (dead) save path | Recent is updated by every successful save/open |
| Failures are invisible | every failure returns a message |
| Timeline internals are partly unknown | documented clean-room model, not format-compatible |

## Limits

- One canvas, 1…100 animation layers; no audio, camera, selection/vector or
  image layers.
- Only `blend: "normal"`; no per-drawing opacity, masks, groups or onion skin.
- PNG export of the current frame only; no sequences or movies.
- `.clip` import is preview-only and read-only.
- TVMini does not read or write `.tvpp`. The timing model is informed by the
  evidence, but the schema and defaults are its own.
- The file picker is a simple directory browser, not a native dialog.
