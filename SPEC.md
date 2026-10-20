# SPEC — "TVMini" clean-room save / export / recent / timeline

An independent, small 2D animation app that implements the four demo-blocked
behaviours **and** a simple animation timeline. It uses no TVPaint code, file
format or resource.

The timing model (layers, drawings, exposures, before/after behaviour) was
informed by the observable REA evidence in `REPORT.md` section 7. The actual
implementation, schema and defaults are clean-room choices, not a claim of
TVPaint compatibility.

---

## 1. Product statement

TVMini is a local drawing and animation app. You can:

- draw pressure-sensitive brush and eraser strokes;
- keep several animation layers, reorder them, hide/lock them and change their
  opacity;
- place drawings on a frame timeline, hold an exposure, duplicate/delete
  drawings, and set what a layer does before its first and after its last
  drawing;
- play the timeline at a chosen frame rate, with optional looping;
- save/reopen a project, export the current frame as a PNG, and use a Recent
  list;
- import the preview image stored inside a Clip Studio Paint `.clip` file,
  read-only;
- export the current frame as a layered Clip Studio Paint `.clip` file.

Deliberately **not** in scope:

- reading or writing TVPaint `.tvpp` / `.tvps` files;
- writing CSP animation tracks, vector/text layers, masks or groups into
  `.clip`;
- matching TVPaint's UI, exact layer types, exposure reflow rules, defaults or
  project format;
- audio layers, cameras, selection/vector layers, onion skin, blend modes
  other than normal, or sequence/movie export;
- any interaction with TVPaint's licence or demo checks.

---

## 2. Functional requirements

### FR-1 New project
- Create an empty canvas with a chosen width/height (default 960 × 600).
- Start with one animation layer, 12 fps, start frame 1, current frame 1,
  current layer 0 and loop enabled.
- The project has no path and is marked *unsaved*.

### FR-2 Save
- If the project has a path, write it there.
- If it has no path, behave like Save As.
- On success: mark *saved*, add the path to Recent, show the byte count.
- On failure: keep the *unsaved* state, return a non-zero result, show the
  reason. **A failed save must never leave a truncated project file** (FR-3).
- Saving always writes the validated version 2 schema.

### FR-3 Save As
- Always ask for a path (or accept one from the API).
- Append `.tvmini` when the path has no extension.
- Ask before replacing a file that already exists.
- On success: the project's path becomes the new path; add to Recent.

### FR-4 Open
- Read and validate a `.tvmini` JSON file.
- Version 1 projects are migrated on load:
  - the flat `strokes` array becomes one animation layer;
  - if there are strokes, they become one drawing at frame 1 with hold 1;
  - the returned document is version 2.
- On success: load it, clear *unsaved*, add to Recent.
- On failure: leave the current project untouched, show the reason.

### FR-5 Export
- Render the **current frame** of the project to a PNG at a chosen path.
- Composite, bottom to top:
  1. the background colour;
  2. the optional imported `.clip` preview image;
  3. every visible animation layer at the current frame, with its opacity.
- Apply each layer's pre/post behaviour when the current frame is outside that
  layer's exposed range.
- Export does **not** change the project's path and does **not** add to Recent
  (Recent is for projects).
- A second export action writes the same current frame as a layered Clip Studio
  `.clip` (FR-17). It also leaves the path and Recent unchanged.
- On failure: no partial file left behind.

### FR-6 Recent
- A single MRU list of project paths, newest first.
- Maximum 50 entries.
- Adding an existing path moves it to the front (case-insensitive on Windows).
- Entries whose file no longer exists are dropped when the list is read.
- Persisted across runs.
- The menu shows a disabled "No recent projects" item when empty.

### FR-7 Unsaved-changes guard
- New / Open / `.clip` import must ask before discarding unsaved changes.

### FR-8 Pen pressure
- When the pointer is a pen (`pointerType === "pen"`) and "Pen pressure" is on,
  record `pressure` (0…1) with every point.
- Stroke width is `width × (0.2 + 0.8 × pressure)`: 20 % of the slider value at
  zero pressure, full width at 1.0.
- The on-screen canvas and the PNG export must taper identically.
- A mouse or touch pointer records plain `[x, y]` points and keeps a constant
  width.
- Turning the checkbox off forces constant width for new strokes; existing
  strokes keep their recorded pressure.
- Files with 2-element points stay valid.

### FR-9 Undo / redo
- At least 100 steps; older steps are dropped.
- One step per completed stroke.
- One step per document edit:
  clear drawing; add/delete/duplicate/hold/delete drawing; change exposure;
  add/delete/move/rename layer; toggle visibility/lock; change layer opacity;
  change pre/post behaviour; change start frame, frame rate or loop.
- Undo/redo buttons are disabled when there is nothing to do.
- `Ctrl+Z` undoes; `Ctrl+A`, `Ctrl+Y` and `Ctrl+Shift+Z` redo.
- Making a new change after an undo discards the redo branch.
- New, Open and `.clip` import reset the history.
- Undo/redo never changes the project path; they mark the document unsaved.
- A text field keeps its normal editing shortcuts; `Ctrl+A` inside a field
  selects text and does not redo.

### FR-10 Import a Clip Studio `.clip`
- Opening a `.clip` file (via Open… or "Import .clip preview…") reads it
  read-only and loads its embedded canvas preview as the new canvas.
- The original `.clip` file is never written or modified.
- The new document has no path and is offered a `.tvmini` name on Save As.
- The preview image is stored inside the `.tvmini` project, so reopening the
  project does not need the `.clip` file.
- The imported image is a read-only row at the bottom of the timeline. It is
  composited before the animation layers.
- A file that is not a `CSFCHUNK` container, has no embedded SQLite database,
  has no `CanvasPreview` row, or has a canvas outside 16…4096 px is rejected
  with a readable error and leaves the current project untouched.
- Importing does not add anything to Recent.

### FR-11 Eraser
- The tools panel offers **Brush** and **Eraser**; `B` and `E` switch tools
  when focus is not in a text field.
- An eraser stroke is recorded like a brush stroke with `"eraser": true`.
- It removes paint from its own animation layer only, revealing lower layers,
  the imported image, or the background.
- Erasing follows the same width slider and pen-pressure taper as the brush.
- Eraser strokes are ordinary history entries: undo/redo, Clear and save/open
  work unchanged.
- A brush stroke drawn after an eraser paints over the erased area again.
- The on-screen canvas and the PNG export use the same paint/erase order.

### FR-12 Animation layers
- A project has 1…100 animation layers.
- Layers are stored and shown **top-to-bottom**; index 0 is the top layer.
- Each layer has:
  `name`, `type: "anim"`, `visible`, `locked`, `opacity` (0…1),
  `blend: "normal"`, `preBehavior`, `postBehavior` and `drawings`.
- Name: trimmed, 1…80 characters.
- Hidden layers are not rendered and cannot be drawn on.
- Locked layers cannot be drawn on or have their drawings changed.
- Add, delete, move up/down and rename are available in the timeline.
- At least one layer must remain.
- Opacity is applied when compositing that layer over the layers below.

### FR-13 Drawings, exposures and behaviour
- Each drawing is `{ at, hold, strokes }`.
  - `at` is an absolute frame number.
  - `hold` is the number of frames the drawing is exposed.
  - The drawing occupies frames `at … at + hold - 1`.
- Drawings in a layer are sorted by `at` and must not overlap.
- Clicking a held frame edits the drawing that owns it, not a copy.
- **Insert drawing** at frame `f`:
  - empty frame / gap: add a one-frame blank drawing at `f`;
  - head of an existing drawing: move that drawing and all later drawings one
    frame right, then put the blank drawing at `f`;
  - inside an exposure: shorten the left part, insert a one-frame blank, copy
    the right part after it, and shift later drawings right by one.
- **Duplicate** inserts an exact copy directly after the source exposure and
  shifts later drawings right.
- **Hold +1** extends the owning exposure by one frame and shifts later
  drawings right.
- **Delete drawing** removes the owning exposure and closes the gap by shifting
  later drawings left by the removed hold.
- **Exposure** sets the owning drawing's hold to a whole number 1…10000; later
  drawings move by the same delta.
- **Start frame** moves every drawing and the current frame by the same delta.
- Pre/post behaviour controls frames outside the layer's exposed range:

  | value | meaning |
  |---|---|
  | `none` | nothing is shown outside the layer's range |
  | `hold` | before: hold the first drawing; after: hold the last |
  | `repeat` | repeat the exposed range |
  | `pingpong` | reflect the exposed range |

  Virtual cells are shown as `◌`, are never edited directly, and are not
  counted as drawings.
- A new layer defaults to `preBehavior: "none"` and `postBehavior: "hold"`.
  This is a clean-room default; TVPaint's default is not established.
- Drawing on an empty or virtual frame creates a new one-frame drawing at the
  current frame.

### FR-14 Playback
- The timeline toolbar has Play/Pause, Loop, FPS (1…120), Start frame
  (1…100000) and a current-frame label.
- `Space` toggles playback when focus is not in a field or button.
- Playback advances the current frame from the start frame to the highest
  exposed frame in the project.
- At the end: loop to the start frame when Loop is on; otherwise stop.
- Each animation layer applies its own pre/post behaviour at frames where that
  layer has no exposed drawing.
- Playing an empty project shows a readable message instead of starting a
  timer.
- `←` / `→` step one frame and stop playback.

### FR-15 Timeline UI
- One row per animation layer, top layer first; one column per frame.
- The layer head shows visibility, name and lock.
- The frame header shows absolute frame numbers and marks the first frame.
- A filled dot `●` is a drawing's first frame; `·` is a held frame; `◌` is a
  virtual frame; blank is empty.
- Clicking any frame cell selects both that layer and that frame.
- The current frame is outlined; the current layer row is highlighted.
- The timeline scrolls horizontally for long scenes and vertically for many
  layers.
- If a `.clip` preview is present, a read-only image row is shown below the
  animation layers.
- Toolbar actions: Play/Pause, Loop, FPS, Start, + Layer, − Layer, ↑, ↓,
  + Drawing, Duplicate, Hold +1, Delete, Exposure.
- The current layer's name, opacity and pre/post behaviour are edited in the
  tools panel.

### FR-16 Canvas rendering
- The canvas shows the current frame.
- Layers are composited bottom-to-top; layer 0 is the top.
- Held frames show the owning drawing.
- Virtual frames follow pre/post behaviour.
- Eraser strokes clear only their own layer's paint.
- The imported `.clip` preview is behind all animation layers.
- Export uses the same layer resolution and compositing rules as the screen.

### FR-17 Export a layered Clip Studio `.clip`
- File → **Export layered .clip (current frame)…** writes a `CSFCHUNK`
  container with an embedded SQLite database and external zlib-compressed image
  blocks.
- The result contains:
  - the paper/background colour;
  - the imported `.clip` preview as a separate raster layer, when present;
  - one raster layer per TVMini animation layer, in the same top-to-bottom
    order;
  - each layer's current-frame drawing, name, visibility, lock and opacity.
- The canvas size, resolution and composed `CanvasPreview` match the project.
- The output must open in Clip Studio Paint EX v3.0.0 without a corruption
  warning. The current-frame result is a layered **still image**; TVMini does
  not write CSP animation folders/tracks, vector/text layers, masks or groups.
- Export appends `.clip` when the chosen name has no extension, asks before
  replacing an existing file, and refuses to overwrite the `.clip` imported in
  the current session.
- Export does not change the project path and does not add to Recent.
- On failure: no partial file left behind.
- Node 22.5+ is required for `node:sqlite`; on older Node the endpoint returns
  a readable error.

---

## 3. Data format

Project file: UTF-8 JSON, extension `.tvmini`.

```json
{
  "format": "tvmini",
  "version": 2,
  "width": 960,
  "height": 600,
  "background": "#ffffff",
  "image": null,
  "fps": 12,
  "startFrame": 1,
  "currentLayer": 0,
  "currentFrame": 1,
  "loop": true,
  "layers": [
    {
      "name": "Layer 1",
      "type": "anim",
      "visible": true,
      "locked": false,
      "opacity": 1,
      "blend": "normal",
      "preBehavior": "none",
      "postBehavior": "hold",
      "drawings": [
        {
          "at": 1,
          "hold": 2,
          "strokes": [
            { "color": "#1f2937", "width": 6, "points": [[10, 10], [42, 80]] },
            { "color": "#b91c1c", "width": 12, "points": [[100, 20, 0.15], [140, 90, 0.85]] },
            { "color": "#000000", "width": 20, "points": [[30, 30]], "eraser": true },
            { "color": "#000000", "width": 6, "points": [[10, 10], [90, 10]], "kind": "line" },
            { "color": "#000000", "width": 6, "points": [[10, 10], [90, 70]], "kind": "rect" },
            { "color": "#000000", "width": 6, "points": [[10, 10], [90, 70]], "kind": "ellipse" },
            { "color": "#000000", "width": 6, "points": [[50, 40]], "kind": "fill" },
            { "color": "#ff0000", "width": 6, "points": [[10, 10]], "opacity": 0.5, "blend": "multiply" }
          ]
        }
      ]
    }
  ]
}
```

A point is `[x, y]` or `[x, y, pressure]`. The third value is optional and,
when present, must be between 0 and 1. `width` is the diameter at full
pressure.

A stroke without `kind` is freehand. `line` and `rect` keep two points (the
drag start and end), `ellipse` keeps the two corners of its bounding box and
`fill` keeps one seed point; the region is flooded from that seed through
similar-coloured pixels and stops at the stroke edges. `kind: "fill"` cannot be
combined with `eraser`.

`camera` is optional. It holds the keyframes of the camera track:

```json
"camera": {
  "keys": [
    { "frame": 1, "x": 0, "y": 0, "width": 960, "height": 600, "rotation": 0, "interp": "linear" },
    { "frame": 24, "x": 240, "y": 150, "width": 480, "height": 300, "rotation": 0, "interp": "ease" }
  ]
}
```

The camera travels from one key to the next with the **first** key's `interp`
(`linear`, `ease` or `hold`); before the first key and after the last one it
holds. `rotation` is in degrees and always takes the short way round. A PNG
export is cropped to the camera window of the exported frame.

`audio` is optional. It holds the sound that plays with the animation:

```json
"audio": { "name": "beep.wav", "data": "<base64>", "duration": 0.6, "offset": 0 }
```

`data` is the sound file itself, so the project stays self-contained. The
sound is not written into the PNG, `.clip` or `.tvpp` exports.

Layers are listed top-to-bottom. Drawings are listed in ascending `at` order.
`at` and `currentFrame` are absolute frame numbers, not zero-based indices.

`image` is optional. When present it is a base64 PNG drawn under every layer;
its pixel size must equal the canvas. It is produced by `.clip` import and then
travels with the project:

```json
"image": { "width": 2136, "height": 1418, "data": "iVBORw0KGgo..." }
```

### 3.1 Version 1 migration

A version 1 file has a flat `strokes` array and no `layers`. On load it becomes
version 2 with one layer; the strokes become one drawing at frame 1 with hold 1.
If the flat array is empty, the layer has no drawings.

### 3.2 Validation rules

| field | rule |
|---|---|
| `format` | exactly `"tvmini"` |
| `version` | integer `1` or `2` |
| `width`, `height` | integer 16…4096 |
| `background`, stroke `color` | `#rrggbb` |
| `image` | optional; `{ data, width, height }`, base64 PNG (max 8,000,000 chars), size equals the canvas |
| `fps` | finite number 1…120 |
| `startFrame` | integer 1…100000 |
| `currentLayer` | integer 0…`layers.length - 1` |
| `currentFrame` | integer 1…10,000,000 and at or after `startFrame` |
| `loop` | boolean |
| `layers` | 1…100 |
| layer `name` | trimmed text, 1…80 characters |
| layer `type` | exactly `"anim"` |
| `visible`, `locked` | boolean |
| `opacity` | number 0…1 |
| `blend` | exactly `"normal"` |
| `preBehavior`, `postBehavior` | `none`, `hold`, `repeat` or `pingpong` |
| `drawings` | 0…1000 per layer; 0…5000 in the whole project |
| drawing `at` | integer 1…10,000,000 and at or after `startFrame` |
| drawing `hold` | integer 1…10000 |
| drawing order | sorted by `at`; exposures must not overlap |
| stroke `width` | number 1…200 |
| stroke `eraser` | optional boolean; `true` means the stroke removes paint |
| stroke `kind` | optional; `line`, `rect`, `ellipse` or `fill`; absent means freehand |
| stroke `opacity` | optional number 0…1; absent means fully opaque |
| stroke `blend` | optional; `normal`, `multiply` or `screen`; absent means `normal` |
| stroke `points` | at least 1; `[x, y]` or `[x, y, p]`, `p` is 0…1; max 200000 per stroke |
| `camera` | optional; `{ keys: [{ frame, x, y, width, height, rotation, interp }] }`, max 1000 keys, sorted by frame, no two keys on one frame |
| `audio` | optional; `{ name, data, duration, offset }`; `data` is base64, max 12,000,000 characters |
| total `strokes` | max 10000 in the whole project |

Unknown fields are ignored so the format can grow.

### 3.3 Atomic write
1. write to `<target>.tmp-<pid>-<rand>`
2. `fsync`
3. `rename` over the target

If any step fails, unlink the temp file and return the error.

---

## 4. Interface

### 4.1 Local HTTP app
- `node server.js` starts on `127.0.0.1:4123` (configurable `--port`).
- Loopback only.
- Static UI in `public/`.
- JSON API under `/api`.

| method | path | body | result |
|---|---|---|---|
| `GET` | `/api/state` | — | `{ recent, cwd, home, platform }` |
| `GET` | `/api/list?dir=` | — | `{ dir, parent, entries[] }` |
| `GET` | `/api/stat?path=` | — | `{ exists, dir, size, path }` |
| `POST` | `/api/open` | `{ path }` | `{ project, path, recent }` (v1 migrated) |
| `POST` | `/api/import-clip` | `{ path }` | `{ project, path, name }` (read-only preview import; one empty animation layer) |
| `POST` | `/api/save` | `{ path, project }` | `{ path, bytes, recent }` |
| `POST` | `/api/export` | `{ path, project }` | `{ path, bytes, width, height }` (current frame PNG) |
| `POST` | `/api/export-clip` | `{ path, project }` | `{ path, bytes, width, height, layers }` (current frame layered `.clip`) |
| `GET` | `/api/recent` | — | `{ entries[] }` |
| `POST` | `/api/recent/remove` | `{ path }` | `{ entries[] }` |

Errors: HTTP 4xx/5xx with `{ "error": "human readable" }`. The UI shows this
text; it never fails silently.

### 4.2 UI
- File menu: New, Open…, Import .clip preview…, Save, Save As…, Export current
  frame PNG…, Export layered .clip (current frame)…, Recent ▸.
- Tools: Brush / Eraser / Pick buttons (`B` / `E` / `I`), Line / Rect / Oval /
  Fill buttons (`L` / `R` / `V` / `F`), Camera button (`C`), colour, width,
  pen pressure, stabiliser (0–10), stroke opacity (1–100 %) and blend mode,
  undo / redo.
- Timeline: a camera row (keyframes that frame the shot, `Shift+C` toggles a
  key on the current frame), the layer rows, and a sound row with the
  waveform.
- Top bar: a document tab strip (one tab per open project, each with its own
  undo history), open, save and export. `Ctrl+Tab` walks through the tabs.
- Stage: a quick bar over the canvas with the colour, the brush width and
  undo / redo; it can be folded away.
- Current layer: name, opacity, before-first behaviour, after-last behaviour,
  clear current drawing.
- Canvas: drag to draw; stroke colour and width controls.
- Timeline toolbar: Play/Pause, Loop, FPS, Start, current frame, layer
  add/delete/move, drawing add/duplicate/hold/delete, exposure.
- Timeline grid: layer rows, frame columns, current-cell outline, virtual cells.
- Status bar: last result or error.
- Title bar: `name — TVMini` with `*` while unsaved.

---

## 5. Acceptance tests

Every item below is automated in `build/my-version/test/` unless marked
**manual**.

| # | Test | Pass condition |
|---|---|---|
| T1 | save → open round-trip | identical size, background, layers, drawings, strokes |
| T2 | save to unwritable dir | error returned, target absent, temp absent |
| T3 | save over existing file | replaced atomically, no `.tmp-*` left |
| T4 | save without extension | `.tvmini` appended |
| T5 | open invalid JSON | error, previous project object untouched |
| T6 | open wrong `format` / unsupported version | error |
| T7 | recent add | newest first |
| T8 | recent duplicate (different case) | one entry, moved to front |
| T9 | recent cap | 50 max |
| T10 | recent prune | missing files removed |
| T11 | recent persistence | reload from disk keeps order |
| T12 | export PNG | valid signature, IHDR size, decodable IDAT |
| T13 | export failure | no file left |
| T14 | HTTP save/open/export | 200 + correct payload |
| T15 | HTTP bad path | 4xx + `error` string |
| T16 | HTTP path traversal in `/api/list` | rejected |
| T17 | pressure 0.05 with width 20 | core painted, 5 px away stays background |
| T18 | pressured project save → open | pressure values preserved |
| T19 | history undo/redo | states restored in order |
| T20 | new change after undo | redo branch discarded |
| T21 | history limit | oldest state dropped |
| T22 | reset | both directions cleared |
| T23 | `.clip` import | preview PNG, size and base64 match the source |
| T24 | `.clip` rejection | foreign file and damaged database give a readable error |
| T25 | image + strokes export | imported pixels and stroke pixels appear in the PNG |
| T26 | eraser | erased area shows background; later strokes paint again |
| T27 | eraser over image | erased area shows the imported image, in preview and PNG |
| T28 | eraser persistence | `eraser: true` survives save → open |
| T29 | drawing lookup | head and held frames resolve to the owning drawing |
| T30 | insert drawing | empty, head and inside-exposure cases produce the documented layout |
| T31 | duplicate drawing | copy inserted after the exposure, later drawings shifted |
| T32 | exposure / hold | later drawings move by the same delta; invalid values rejected |
| T33 | delete drawing | gap closes by the removed hold |
| T34 | pre/post behaviour | `none`, `hold`, `repeat`, `pingpong` resolve to the right source frame |
| T35 | frame rendering | requested frame, held frames and out-of-range behaviour are honoured |
| T36 | layer compositing | top-to-bottom order, opacity, visibility and layer-local eraser |
| T37 | start-frame shift | drawings and current frame move together |
| T38 | content bounds / columns | content end and displayed columns are correct |
| T39 | v1 migration | flat strokes become one drawing on one layer |
| T40 | current-frame export | exporting frame N writes frame N, not frame 1 |
| T41 | `.clip` import API | returns a version 2 project with one empty animation layer |
| T42 | stat endpoint | reports `exists`, `dir` and `size` for an existing file and `exists: false` for a missing one |
| T43 | `.clip` export API | 200; `CSFCHUNK`; file length in header; one raster layer; one `CHNKExta`; preview size matches |
| T44 | `.clip` canvas/layers | embedded SQLite has the project size, paper, expected raster layer(s) and external offsets |
| T45 | `.clip` opens in CSP EX v3.0.0 (**manual**) | no corruption warning; layer names/order/opacity and drawings are visible |

Manual browser checks performed for the UI layer:

- draw with a synthetic pen and verify the pressure taper on screen and in the
  exported PNG;
- undo/redo a stroke and a timeline insertion;
- insert, duplicate, hold and delete drawings; change exposure and start frame;
- add, move, lock, hide and delete layers; verify order and opacity;
- switch pre/post behaviour and confirm virtual/empty cells;
- play/pause and step frames;
- Save As, reopen, export and compare the PNG pixels;
- export a layered `.clip`, open it in Clip Studio Paint EX v3.0.0, and verify
  the canvas, layer names/order/opacity and current-frame drawings.

---

## 6. Non-goals / limits

- Browser UI is served locally; it is not a hosted service.
- One canvas, 1…100 animation layers; no audio, camera, selection/vector or
  image layers.
- Only `blend: "normal"`; no per-drawing opacity, masks, groups or onion skin.
- Export is PNG or a layered `.clip` of the current frame; no image sequences
  or movies.
- `.clip` import reads only the embedded canvas preview: layers, timelines and
  vector data are not imported, and the imported file is never written.
- `.clip` export writes raster layers only. It does not write CSP animation
  tracks, vector/text layers, masks or groups.
- TVMini does not read or write `.tvpp`; its timing model is inspired by the
  evidence but its schema and defaults are its own.
- The exact meanings of TVPaint's layer types, exposure split/reflow rules and
  default behaviours are not established; see `REPORT.md` section 10.
- No cloud sync, no telemetry, no network access beyond loopback.
