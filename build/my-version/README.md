# TVMini — clean-room drawing + animation timeline

A small, self-contained drawing and 2D animation app. It implements the four
behaviours the TVPaint demo blocks **and** a simple timeline/animation-layer
model. It shares **no code, data or file formats** with TVPaint.

- No dependencies. Node 20+ (Node 22.5+ for `.clip` import/export).
- The UI is plain HTML/CSS/JS served by a loopback-only HTTP server.
- Project files use `*.tvmini` (JSON), **not** `.tvpp`.
- Clip Studio `.clip` files can be imported read-only (preview image only) and
  exported as layered CSP documents for the current frame.
- One canvas, up to 100 animation layers, current-frame PNG and `.clip` export.
- A start screen with recent projects, a guide book and `F1` shortcut list.
- HSV colour wheel (hue ring + saturation/value square + hex field, plus a
  "Transparent" chip that switches to the eraser) next to the native colour
  input, and `.tvpp` (TVPaint Animation) import/export — see
  `docs/moart-study.md` for how the formats were mapped.
- Onion skin: tinted neighbouring drawings (red = before, green = after) of the
  current layer under the drawing, with independent before/after counts
  (0–5 each); toggled in the timeline toolbar or with `O`. Ghosts follow
  drawings, so a drawing held for several frames counts once. Playback speed
  (¼×–2×) multiplies the FPS, and the clock-driven playback keeps its tempo
  even when a frame renders slowly. Hold `S` for a 160 ms flipbook
  preview of the current layer's frames.
- Tool grid: line, rectangle and ellipse (drag to place) and a bucket fill
  (click a region), plus a brush **stabiliser** that calms shaky strokes, a
  per-stroke **opacity** slider and **blend modes** (normal / multiply /
  screen). Shape strokes are stored in the project file, so they survive
  save/open and export to PNG, `.clip` and `.tvpp` like any brush stroke.
- Camera track: keyframes that frame the shot. The stage shows what the
  camera sees (or the whole canvas with the frame drawn on it), the camera
  holds its last key until the next one, and the PNG export is cropped to
  the camera window.
- Sound track: import an audio file, see its waveform under the frames it
  plays on, and hear it with the playback. The sound travels inside the
  project file, so a project stays self-contained.
- Document tabs: several projects open at once, each with its own undo
  history, path and dirty mark. A quick bar floats over the canvas with the
  colour, the brush width and undo / redo.

## Keyboard shortcuts

| Group | Action | Keys |
|---|---|---|
| Tools | Brush / Eraser / Pick colour | `B` / `E` / `I` |
| Tools | Line / Rectangle / Ellipse / Fill | `L` / `R` / `V` / `F` |
| Tools | Add a camera key on this frame | `C` |
| Tools | Brush size | `[` / `]` |
| Tools | Clear the current drawing | `Backspace` |
| Timeline | Play / pause | `Space` |
| Timeline | Flip preview of the current layer (hold) | `S` |
| Timeline | Toggle onion skin | `O` |
| Timeline | Frame step | `←` / `→` |
| Timeline | Layer select | `↑` / `↓` |
| Timeline | Exposure longer / shorter | `5` / `Shift+5` |
| Timeline | Insert a blank drawing | `6` |
| Timeline | Duplicate / delete the drawing | `Ctrl+D` / `Delete` |
| Project | New / Open / Save / Save As | `Ctrl+N/O/S/Shift+S` |
| Project | Next document | `Ctrl+Tab` |
| Project | Export PNG / layered `.clip` | `Ctrl+E` / `Ctrl+Shift+E` |
| Project | Undo / redo | `Ctrl+Z` / `Ctrl+Y`, `Ctrl+Shift+Z`, `Ctrl+A` |
| Project | This list in the app | `F1` |

`F1` (or the Help menu) always shows the current list, and `Esc` closes any
dialog. Preferences — pressure gain, touch drawing, the start screen, onion
skin counts and the playback speed — are
remembered in `localStorage` (`tvmini.settings.v1`).

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

## Run on GitHub Pages (no server)

The app also runs as a **static site**, so it can be published with GitHub
Pages:

```powershell
cd build\my-version
node scripts\serve-static.mjs 8123
# open http://127.0.0.1:8123
```

This serves `public/` with no backend, exactly the way GitHub Pages serves
it. The repository contains `.github/workflows/pages.yml`, which publishes
`build/my-version/public` on every push to `master`:

**https://Riju2007123.github.io/tvpaint-save-export-rea/**

### What changes without a server

| Feature | With the Node server | On a static host |
|---|---|---|
| Draw, timeline, layers, pen pressure, eraser | same | same |
| Save / open a project | real file paths, atomic writes | browser download, or the File System Access API to save in place |
| Export PNG / `.clip` | written straight to disk | browser download |
| Import a `.clip` preview | same | same |
| Recent projects | paths on disk, re-opened by path | kept in `localStorage`; a browser cannot re-open a file by path, so the project text is stored |
| Folder browser | in-app directory browser | the browser's own file picker |

The `.clip` writer runs **entirely in the browser**: SQLite is
[sql.js](https://github.com/sql-js/sql.js) (WebAssembly), zlib is
[fflate](https://github.com/101arrowz/fflate), and the `Buffer` API is
[feross/buffer](https://github.com/feross/buffer). The same format code
(`public/core/`) runs under Node, so a file exported in the browser and one
exported by the server are the same format.

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
| Export `.clip` | writes the current frame as a layered Clip Studio document | `src/clip-write.js`, `src/store.js` `exportClip` |
| Import `.clip` | loads the preview stored in a Clip Studio file | `src/clip.js` |
| Recent | MRU list, max 50, de-duplicated, pruned | `src/recent.js` |
| Pen pressure | width follows `PointerEvent.pressure` | `public/app.js`, `src/png.js` |
| Eraser | clears its own layer, revealing lower layers/image | `public/app.js`, `src/png.js` |
| Shape tools | line, rectangle, ellipse and bucket fill, stored as strokes | `public/core/paint.js`, `public/core/png.js` |
| Document tabs | several open projects, each with its own undo history | `public/app.js` |
| Quick bar | colour, brush width and undo/redo over the canvas | `public/app.js` |
| Camera track | keyframes that frame the shot; the export is cropped to it | `public/timeline.js`, `public/core/png.js` |
| Sound track | imported audio with a waveform, played with the animation | `public/audio.js`, `public/app.js` |
| Stroke opacity / blend | per-stroke transparency and multiply/screen mixing | `public/core/paint.js`, `public/core/png.js` |
| Stabiliser | eases pointer samples into a calmer path (0–10) | `public/core/paint.js` `smoothPoint` |
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
- **The imported `.clip` is never written.** Export refuses the current
  session's import source; a `.clip` export goes only to a different path.

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

A stroke is `{ "color": "#rrggbb", "width": n, "points": [[x, y], …] }` plus
optional `eraser`, `kind` (`line` / `rect` / `ellipse` / `fill`), `opacity`
(0–1) and `blend` (`normal` / `multiply` / `screen`). Files without those
fields keep their old meaning: freehand, fully opaque, normal blending.

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

## Shape tools, fill, opacity and blend

The tool panel has four more tools next to the brush:

| Tool | Key | How to use it |
|---|---|---|
| Line | `L` | drag from one point to another |
| Rect | `R` | drag two opposite corners |
| Oval | `V` | drag the outline |
| Fill | `F` | click a region to flood it with the current colour |

A shape is stored as a normal stroke with a `kind` field, so it saves, loads,
undoes and exports like a brush stroke:

```json
{ "color": "#000000", "width": 6, "points": [[100, 100], [300, 100]], "kind": "line" }
```

- `kind` is one of `line`, `rect`, `ellipse`, `fill`; a stroke without it is
  freehand.
- The fill stroke keeps only its seed point. The region is flooded from that
  point through pixels of a similar colour (tolerance 32) and stops at the
  stroke edges, exactly like a paint bucket. It is replayed in stroke order,
  so a fill always floods the paint that was there when it was made.
- The browser and the Node renderer share the same flood fill and blend code
  (`public/core/paint.js`), so a fill behaves the same on screen, in an
  exported PNG, in a `.clip` and in a `.tvpp`. The browser antialiases stroke
  edges while the export draws them hard, so the fill boundary can differ by
  about one pixel.

Two extra brush-panel settings apply to **new brush strokes**:

- **Stabiliser** (0–10) eases each pointer sample toward the previous one, so
  a shaky hand draws a calmer line. Level 0 turns it off; the level is
  remembered in `localStorage`.
- **Stroke opacity** (1–100%) and **Blend** (normal / multiply / screen) are
  stored on the stroke:

```json
{ "color": "#ff0000", "width": 6, "points": [[40, 40]], "opacity": 0.5, "blend": "multiply" }
```

A transparent or blending stroke is painted into a mask first and then applied
in one pass, so a stroke never darkens its own overlaps. The blend maths
follows the canvas rule (blend the colours, then composite by source alpha),
which keeps the browser preview and the exported pixels in step.

## Camera track

The camera frames the shot. It is a list of keyframes on the timeline, each
one a window over the canvas:

```json
"camera": {
  "keys": [
    { "frame": 1, "x": 0, "y": 0, "width": 960, "height": 600 },
    { "frame": 24, "x": 240, "y": 150, "width": 480, "height": 300 }
  ]
}
```

- The camera **holds** its last key until the next one arrives, so one key
  frames the whole animation. A camera key also counts as content, so the
  timeline grows to reach it.
- The stage can show two things: the **camera view** (the shot, scaled to
  fit, with a letterbox around it) or the **whole canvas** with the camera
  frame drawn on it. The 🎥 button in the camera row switches between them,
  and the Inspector has the position, width and height of the key.
- Drawing works in both: the pointer is mapped back through the camera, so a
  stroke lands where you clicked.
- The PNG export is cropped to the camera window, so the picture is the shot
  and not the whole canvas. The `.clip` and `.tvpp` exports still use the
  canvas size.
- `C` adds a key on the current frame; the ✕ button in the camera row removes
  it. Camera edits are undoable like any other change.

## Sound track

File → **Import a sound…** adds an audio file to the timeline:

```json
"audio": { "name": "beep.wav", "data": "<base64>", "duration": 0.6, "offset": 0 }
```

- The sound is stored **inside** the project file (base64), so a project stays
  self-contained. The limit is 12 MB of base64; the ✕ button in the sound row
  removes it again.
- The waveform is drawn under the frames it plays on. The peaks are worked
  out with the Web Audio API when the sound is imported, and again whenever a
  project is opened.
- Playback starts the sound together with the animation, lined up with the
  start frame, and stops it on pause. A browser may refuse to start a sound
  without a user gesture; pressing play again fixes that.
- The sound is **not** written into the PNG, `.clip` or `.tvpp` exports —
  those formats have no room for it in TVMini.

## Open documents

The top bar holds a tab strip, one tab per open project:

- **+** (or `Ctrl+N`) opens a new empty document in its own tab.
- **File → Open…** opens a file in a tab. An untouched empty document is
  reused, so opening a file does not leave a blank tab behind.
- Clicking a tab switches to it; the ✕ on the tab closes it. The last
  document is never closed — it is emptied instead, so the app always has
  something to draw on.
- Every document keeps **its own undo history**, its own path and its own
  dirty mark. The dot on a tab is bright when the document has unsaved
  changes.
- `Ctrl+Tab` walks through the tabs, `Ctrl+Shift+Tab` walks back.

The quick bar floats over the canvas with the colour, the brush width and
undo / redo. It follows the tools panel in both directions, and the × on its
right folds it away to a small handle.

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

## Clip Studio `.clip` export

File → **Export layered .clip (current frame)…** writes a real `CSFCHUNK`
document that Clip Studio Paint can open as a normal illustration:

- one raster layer per TVMini animation layer, in the same top-to-bottom order;
- layer name, visibility, lock and opacity are copied;
- the panel/paper colour becomes the document background;
- an imported `.clip` preview becomes a separate raster layer below the
  animation layers;
- every layer contains its drawing resolved at the **current frame**.

The timeline itself is **flattened to the current frame**. TVMini does not write
CSP animation folders or `Track`/`TimeLine` records, so the result is a layered
still image, not an animated CSP timeline. Vector, text, masks, groups and blend
modes other than normal are not produced.

## TVPaint `.tvpp` import / export

TVMini can read and write TVPaint Animation `.tvpp` projects. The byte grammar
was mapped by reverse engineering and is documented (with confidence levels) in
`docs/moart-study.md`; the implementation itself is clean-room code in
`public/core/tvpp.js`.

### Import

1. File → **Import .tvpp (TVPaint)…**
2. Every layer becomes a TVMini layer in the same top-down order, keeping name,
   visibility, opacity and the first frame of each layer's range.
3. Each layer's frames decode to raster bases: repeated frames merge into one
   drawing with a longer hold (our exposure model), gaps become empty frames,
   and a drawing carries an `image` (base64 PNG at canvas size) that sits under
   the layer's strokes — so you can paint over it or erase into it.
4. Save As writes a normal `.tvmini` that keeps everything; the original
   `.tvpp` is never written.

### Export

File → **Export .tvpp (TVPaint)…** writes every drawing as raster layer frames:

- one layer per TVMini layer, topmost first, with opacity, visibility and the
  layer's own frame range;
- held exposures become compact "same as previous frame" stubs and empty gaps
  become empty-frame stubs, matching the observed TVPaint compression
  behaviour;
- images themselves are written uncompressed (`DBOD`), a variant real TVPaint
  files also use — **this writer still needs one real TVPaint round trip before
  we call it fully battle-tested** (the reader side handles compressed `ZCHK`
  files too).

By design the exporter never overwrites the `.tvpp` file that was imported in
the same session.

How it works: `src/clip-write.js` starts from the blank CSP document in
`assets/clip-template.clip`, rewrites the canvas size and mip chains, builds a
block table for each layer, zlib-compresses the RGBA tiles into `CHNKExta`
chunks, updates `ExternalChunk`, stores the composed preview in
`CanvasPreview`, and rebuilds the `CSFCHUNK` container. The writer uses
`node:sqlite`, so it needs Node 22.5+.

The blank template came from the MIT-licensed `clipparse` project's
`emptyimage.clip` sample. It contains no artwork; TVMini replaces its names,
canvas, layers and pixels. The format notes are from the public clean-room CLIP
format descriptions, not from TVPaint.

**Validation:** a generated 640 × 480 file with two layers (blue at 50 % and
red at 100 %) was opened in **Clip Studio Paint EX v3.0.0**; the title bar
reported `tvmini-test (640 × 480 px, 72dpi, 100%)`, the layer panel showed
`Blue`, `Layer 1` and `Paper`, and both strokes rendered with the expected
order and opacity. There was no corruption warning.

## Layout

```
build/my-version/
  server.js            HTTP API + static server
  scripts/
    serve-static.mjs   serve public/ with no backend (GitHub Pages preview)
  public/              the whole web app; this folder is what Pages publishes
    index.html
    app.js             canvas, timeline UI, history
    shell.js           window chrome: panels, Window menu, resize grip, doc tab
    history.js
    timeline.js        shared frame/exposure/behaviour logic
    style.css
    core/              platform-independent logic, used by Node and the browser
      model.js         project schema + validation + v1 migration
      png.js           rasteriser + PNG encoder/decoder
      clip.js          read-only Clip Studio preview import
      clip-write.js    layered Clip Studio .clip writer
      tvpp.js          TVPaint .tvpp reader + writer (clean room)
      png.js           canvas renderer + PNG encode/decode
      platform.js      file backend: Node server or browser storage
      storage.js       browser storage (File System Access API, localStorage)
      sqlite.js        SQLite: node:sqlite under Node, sql.js in the browser
      bytes.js         Buffer: native under Node, feross/buffer in the browser
      zlib.js          zlib: node:zlib under Node, fflate in the browser
    assets/
      clip-template.clip  blank CSP structural template
    vendor/            vendored browser libraries (MIT / public domain)
  src/                 Node-only server side
    model.js           re-exports public/core/model.js
    png.js             re-exports public/core/png.js
    clip.js            re-exports public/core/clip.js, adds file access
    clip-write.js      re-exports public/core/clip-write.js, adds file access
    store.js           atomic save/load/export
    recent.js          persistent MRU
  test/                node:test suites
```

`public/timeline.js` is pure logic shared by the browser, the server-side PNG
renderer and the tests, so exposure lookup has one definition.

`public/core/` is the same idea for the binary formats: the model, the PNG
codec, the Clip Studio reader and writer, and the SQLite/zlib/Buffer
dependencies all have one implementation that runs in both Node and the
browser.

## Shell

The window uses the three-column shell of the MoArt pre-production tool that
was studied for this project (`docs/moart-study.md`): a thin top bar, a tools
column on the left, the stage in the middle, an inspector on the right, and
the timeline docked across the bottom.

The *shape* is imitated only. **No MoArt code, markup, CSS or assets are
reused** — MoArt is source-available rather than open source, so the shell was
written from scratch against the layout that was documented in the study.

- The `Window` menu lists Tools, Stage, Inspector and Timeline and toggles
  them; the choice is remembered in `localStorage`.
- Every panel header carries a `–` button that hides that panel.
- The strip between the stage and the timeline is a drag grip: drag it to
  resize the timeline, double-click it to reset the height.
- The document tab in the top bar follows the project name and the `*` dirty
  mark.
- The palette is the mid-grey, borderless shell the study recorded: panels are
  separated by dark seams and a 1px top-edge light rather than drawn borders,
  and one accent colour (`#3fa3ec`) carries selection, focus and the playhead.

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
- PNG and `.clip` export of the current frame only; no sequences or movies.
- `.clip` import is preview-only and read-only. `.clip` export is a layered
  still image for the current frame; it does not write CSP animation tracks.
- `.tvpp` export writes uncompressed images and needs one real TVPaint save to
  be called fully validated (the reader handles both compressed and bare
  files); blend modes, audio and camera chunks are not produced yet.
- `.clip` export needs Node 22.5+ under the Node server, because it uses
  `node:sqlite`. On a static host it uses SQLite compiled to WebAssembly
  instead, and needs no Node at all.
- On a static host the browser's security model applies: a project can only be
  saved to a file the user picks, and a recent project cannot be re-opened
  from a path.
- TVMini does not read or write `.tvpp`. The timing model is informed by the
  evidence, but the schema and defaults are its own.
- The file picker is a simple directory browser, not a native dialog.
