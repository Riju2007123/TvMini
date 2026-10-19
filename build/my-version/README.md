# TVMini — clean-room save / export / recent

A small, self-contained drawing app that implements the four behaviours the
TVPaint demo blocks. It shares **no code, data or file formats** with TVPaint.

- No dependencies. Node 20+ only (Node 22.5+ for `.clip` import).
- The UI is plain HTML/CSS/JS served by a loopback-only HTTP server.
- Project files use `*.tvmini` (JSON), **not** `.tvpp`.
- Clip Studio `.clip` files can be imported read-only (preview image only).

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

| Menu item | Behaviour | Code |
|---|---|---|
| Save | writes the current path atomically | `src/store.js` `saveProject` |
| Save As | picks a path, appends `.tvmini`, saves | `public/app.js` `saveAs` |
| Export PNG | rasterises the canvas and writes a PNG | `src/png.js`, `src/store.js` `exportPng` |
| Import `.clip` | loads the preview stored in a Clip Studio file | `src/clip.js` |
| Recent | MRU list, max 50, de-duplicated, pruned | `src/recent.js` |
| Pen pressure | width follows `PointerEvent.pressure` | `public/app.js`, `src/png.js` |
| Undo / redo | 100-step snapshot history, toolbar + shortcuts | `public/history.js` |

Key guarantees:

- **No silent failure.** Every error becomes an HTTP 4xx/5xx with a message and
  is shown in the status bar.
- **Atomic writes.** Data goes to a temp file, is fsynced, then renamed. A
  failed save leaves the old file intact.
- **Recent only changes on success.** `POST /api/save` and `POST /api/open`
  update the list only after the file operation succeeds.

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

## Undo / redo

Each finished stroke (pointer up) and each "Clear canvas" records the strokes
as they were *before* the change. The toolbar buttons and `Ctrl+Z` (undo) /
`Ctrl+A`, `Ctrl+Y`, `Ctrl+Shift+Z` (redo) walk that stack.

- 100 steps are kept; the oldest is dropped.
- A new stroke after an undo throws away the redo branch (standard behaviour).
- New and Open reset the history.
- Undo/redo mark the document unsaved; Save still goes to the same path.

## Clip Studio `.clip` import

A `.clip` file starts with `CSFCHUNK` and contains an embedded SQLite database.
TVMini reads that database read-only, takes the `CanvasPreview` PNG and makes it
the new canvas:

1. File → **Import .clip preview…** (or Open… and pick a `.clip`).
2. The canvas becomes the preview's pixel size; the image sits under your
   strokes.
3. Save As writes a normal `.tvmini` that embeds the preview, so the project
   still opens without the original file.

The original `.clip` is **never written**. Only the flattened preview is
imported — layers, timelines and vector data are not. Canvases must be within
16…4096 px. Node 22.5+ is required for the built-in `node:sqlite` reader.

## Layout

```
build/my-version/
  server.js            HTTP API + static server
  src/model.js         project schema + validation
  src/store.js         atomic save/load/export
  src/png.js           rasteriser + PNG encoder/decoder (zlib)
  src/clip.js          read-only Clip Studio preview import
  src/recent.js        persistent MRU
  public/              canvas UI
  test/                node:test suites
```

## Mapping to the report

`REPORT.md` explains what the demo does. This app is the opposite of each
finding:

| Demo behaviour | TVMini behaviour |
|---|---|
| Save slot is `xor eax,eax; ret` | real serialiser + atomic rename |
| Export guards return 0 / -1 behind a modal | real PNG writer, real result code |
| Recent is fed only by the (dead) save path | Recent is updated by every successful save/open |
| Failures are invisible | every failure returns a message |

## Limits

- One canvas, no layers, no animation.
- PNG export only.
- `.clip` import is preview-only and read-only.
- The file picker is a simple directory browser, not a native dialog.
