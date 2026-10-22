# MoArt study notes (read-only reference) → TVMini implementations

This document records what we learned by **reading** MoArt's public build as
reverse-engineering documentation of how an anime-style browser animation app
works, and what TVMini now does about each subsystem. Nothing from MoArt was
copied into TVMini — MoArt's license forbids that, so all TVMini code here is
written for this project from the observed *behaviour* and, for file formats,
from the observed *byte grammar*.

Fact levels:

- **MOART-FACT** — behaviour confirmed by reading MoArt's build.
- **INTEROP-CONSTANT** — a file-format magic number / node GUID / chunk tag.
  These name *kinds of data* in a public file format, so reusing them is the
  same as reusing a PNG signature: required for interoperability, not creative
  work.
- **INFERRED** — our own design choice where several encodings are possible;
  needs one real-file validation before we claim full fidelity.

---

## 1. Application architecture

- One big single-file HTML app: all CSS/JS inline, ~10 MB unminified. No
  framework, plain DOM + HTML5 canvas. **MOART-FACT**
- Everything user-visible lives in overlays/panels toggled by shortcuts; menus
  are DOM elements with hand-wired click handlers.
- Locales ship as JS string tables; every label goes through a `t()` lookup.
- Persisted app data (settings, recent files) via localStorage keys.

**TVMini equivalent:** same overall shape went in already (overlays, single
KEYS shortcut table in `public/app.js`, settings in
`localStorage["tvmini.settings.v1"]`), written from scratch.

## 2. Keyboard shortcut system

- A definitions table drives everything: id, key(s), scope guard, label,
  handler. The help dialog (F1) is *rendered from the same table*, not
  hand-written. **MOART-FACT**
- Keydown handler: gate against typing in inputs, then per-scope dispatch
  (canvas / timeline / dialogs), then Escape unwinds: dialog → overlay → menu.
- Shifted keys are matched by `event.key` (so Shift+5 = `%` on US layout).

**TVMini equivalent:** implemented in the previous batch — `KEYS` table,
F1 dialog from the table, typing gate, Escape unwind, `%` shift handling.

## 3. Colour picker

- HSV model: hue ring around an SV square (saturation = x, value = y),
  ~214×214 px, plus a hex text field and a *transparent* chip that switches
  the active tool to the eraser. **MOART-FACT**
- Drag inside the SV area tracks pointer; the ring shows the current hue.

**TVMini status:** our canvas colour uses a native `<input type="color">`
today. UV refactor target: hue-ring + SV-square widget in our own code
(planned next batch; the reason MoArt feels nicer is the constant-size
compound control, so plan a 214×214 module).

## 4. Brush / tools internals

- Pointer events use **coalesced events** (`getCoalescedEvents`) so fast
  strokes keep all samples. **MOART-FACT**
- Pen pressure maps through a curve; a `pressureGain` slider scales it.
- The brush stamp size multiplies through `previewSizeMul` so the on-canvas
  preview matches the finished stroke. **MOART-FACT**
- A brush **library** (named presets with parameter JSON) plus per-tool
  settings rows; tilt range values were migrated across versions (stored as
  ranges, applied to felt-tip/pencil style brushes). **MOART-FACT**

**TVMini status:** brush with pressure + `pressureGain` (25–300%, persisted)
shipped earlier. Includes eraser touch-draw toggle.

**What TVMini now does (measured, 2026-10-21):**

- **Coalesced events are used** (`getCoalescedEvents`): every sample of a fast
  stroke is kept, so a quick line comes out as a line and not as a few dots.
- **The stage is two canvases.** The document is on one, and a thin sheet on
  top of it holds the shape of the brush and the stroke in the hand. Moving
  the pointer draws the sheet only, so the document is not drawn again for
  every move. The stroke in the hand is drawn with the same code the
  document uses, so the preview looks like the stroke that will be left.
- **The document is drawn in the pixels of the screen.** The buffer of the
  stage is the size the stage is shown at, times the number of dots a pixel of
  the screen has (at most two, and at most 4096 pixels on the longest side),
  and the context is scaled to the document. That is what MoArt does, and it
  is what keeps the picture sharp on a screen with many dots per pixel.
- **The stage scrolls in both directions**, the way Clip Studio Paint does, so
  a document that is larger than the pane can be moved around. The element of
  the canvas is the size the document is shown at (the zoom is in the size, not
  in a transform), so the buffer behind it is used one to one.
- The measurement (`tools/draw-check.mjs`, a headless browser, 120 moves):
  the stroke path went from **601 ms to 27 ms**, about twenty times faster,
  because the document is no longer drawn for every move of the pointer.
- **The brush panel** (2026-10-21). MoArt has a panel of its own with a place
  to drop files on, a list of the brushes that come with the program and a
  list of the ones that were brought in. TVMini has the same panel now: the
  "Brushes…" button in the brush part of the tool property panel opens it.
  Files can be dropped on it or picked with the mouse; a `.png` and a Clip
  Studio Paint brush (a `.sut` file) are both understood, and the name in
  the file is kept. Every brush in the panel can be written out again as a
  Clip Studio Paint brush, which is a file of its own (the format is
  written down in `docs/sut-format-study.md`).
- **A stroke remembers its own brush** (2026-10-22). A brush belongs to the
  stroke that was made with it, the way it does in Clip Studio Paint, so
  picking another brush does not repaint the strokes that are already on the
  paper. A stroke that was made without a picture says so, so that it is not
  given one later.
- **Every tool has a section of its own in the property panel** (2026-10-22),
  the way MoArt has: the brush shows the brush, the pencil shows the pencil,
  the eraser shows the eraser, and so on, with a note under the settings
  that says what the tool does. The settings of each tool are kept apart,
  so the width of the pencil does not change the width of the brush.
- **The panel shows the shape of the brush** (2026-10-22), the way MoArt
  does: a picture of the tip of the brush, drawn with the width it has now.
- **The line follows the hand** (2026-10-22). Two settings were added to the
  brush, and they are what makes a pen feel like a pen:
  - the **velocity**: how much the width of the line follows the speed of the
    hand. A brush that is moved quickly leaves a thinner line, the way it
    does in Clip Studio Paint. The speed of the pointer is measured in the
    pixels of the screen (the hand is quick at two pixels a millisecond) and
    is put in the point of the stroke, so that the line that is drawn and
    the line that is exported are the same line.
  - the **taper**: how much of each end of the line is thin, the way the
    brush of Clip Studio Paint tapers in and out. It is a share of the
    length of the line, so a short line is not all taper.
  With both of them a line drawn with the mouse is thin where the hand moved
  quickly and thin at the ends, and the same line comes out of the PNG
  export, because the taper is worked out in the shared painter that both
  use (`public/core/paint.js`).

Still not adopted: the **per-preset preview magnification** (`previewSizeMul`,
0.25–2.0) of the brush thumbnails in the library, and building the paint
material in a **worker** as MoArt does.

## 5. Onion skin and flip preview

- **Flip preview** ("parapara"): hold a key (default `s`) to run through the
  frames of the current layer like a paper flipbook. Two modes: *flash*
  (each frame shown ~160 ms) and *hold*. **MOART-FACT**
- **Onion skin**: previous/next frames drawn faint *per layer* (genga style),
  opacity falls off with distance. **MOART-FACT**

**TVMini status:** next batch. Our plan: reuse the shared per-layer frame
compositor for both; flip preview triggered by holding `S` on the canvas scope
(160 ms flash first), onion skin as a settings toggle with 1–3 ghosts.

## 6. Camera system

- Camera moves are **keyframed rectangles**: each key stores
  `{ x, y, w, h }`; between keys the four numbers are lerped, producing
  pan + zoom + rotation-free moves. **MOART-FACT**
- Per-cut cameras (a cut = shot section) and an `OL` (over-layout) dissolve
  parameter for blending the camera view with the raw canvas. **MOART-FACT**

**TVMini status:** not implemented. Design recorded in this doc so a later
batch can build our own keyframe model onto `timeline.js`:
`camera: { keys: [{ frame, rect }] }` with out-of-range behaviour `hold`,
rendered as a canvas transform during playback/export. Marked INFERRED until
we test real projects.

## 7. Timeline / frames / layers model

- Exposure-based timeline: a layer holds a list of *image instances*; every
  instance has `startFrame`, exposure count (`instanceValue` chains), and the
  layer header (`LRHD` in .tvpp) has first/last frame plus pre/post
  behaviours (`none` 0 / `repeat` 1 / `hold` 3) for outside
  the exposed range. **MOART-FACT** (also the .tvpp grammar)
- Layer list is per-scene; TVPaint layer 1 is topmost, matching MoArt's UI.

**TVMini equivalent:** our `timeline.js` already models exactly this
(drawings with `at`/`hold`, per-layer `preBehavior`/`postBehavior`) — the
exposure model of the .tvpp reader/writer maps 1:1 onto it.

## 8. `.clip` (CSP) reading

- Multi-day study consolidated earlier; the four-step layer→pixels join
  (`Layer.LayerRenderMipmap` → `Mipmap.BaseMipmapInfo` →
  `MipmapInfo.Offscreen` → `Offscreen.BlockData` = EXta external chunk with
  UUID), 256×256 tile grid with per-tile zlib planes
  (`[alpha][BGRX interleaved]`), masks with channel sum == 1, vector layers
  as raw BE records, and layer order via `LayerFirstChildIndex` /
  `LayerNextIndex` (bottom-to-top file order). **MOART-FACT** for the
  observed reader.
- MoArt has a `.clip` **reader** but no `.clip` writer (export disabled,
  “未実装”). It *does* write `.tvpp`. **MOART-FACT**

**TVMini status:** our own `.clip` writer (validated inside CSP EX v3.0.0)
and the preview-image reader shipped earlier. The full-timeline reader is
still planned; the grammar notes above are the base.

## 9. `.tvpp` (TVPaint Animation) format — the new TVMini module

Implemented clean-room in `public/core/tvpp.js`. Byte grammar:

- The file is a tree of **node records**:
  `[16B GUID][BE32 reserved=0][BE32 size][body]`. Project → { meta, scene } →
  scene → { shot info, drawing } → drawing → { annotation, media }, and the
  media node holds the media chunk. GUID values are **INTEROP-CONSTANT**.
- The media is an IFF chunk: `FORM` + size + `TVPP` + inner chunks with
  `[4CC][BE32 size][body][pad to even]`. Order observed:
  `DGBL DPEL DLOC BGMD ARAT CRLR BGP1 BGP2 FRAT FILD MARK XSHT TLNT`,
  one group per layer (`LNAM LNAW LRHD <frames…> LEXT UDAT`), then
  `STCK XSRC`. **MOART-FACT**
- Text metadata is `[BE32 pairCount][BE16 len][UTF-16BE]…` pairs; the meta
  node carries Width / Height / FrameRate / StartFrame and so on.
- Pointer records: `LNAM` = legacy-encoded name, `LNAW` = UTF-8 name,
  `LRHD` = 26 BE32 words — `[1]` first frame, `[2]` last frame, `[3]` frame
  count, `[4]` opacity×255, `[7]&1` hidden, `[11]` post×65536+pre behaviour,
  `[15]` blend code, `[16]` marker. `LEXT` = UTF-8 BOM + ini with
  `[Images Name]` / `[Images Auid]`. **MOART-FACT**
- Frame images are `DBOD` (full image) or `SRAW` (delta/reference) each
  optionally wrapped in `ZCHK` (deflate blocks: header `[4CC][BE32 usize]`
  then body `[tag][usize]['czmp'][size][BE32 blocks][per block: 3×BE32 +
  deflate data]`). Files saved *without* compression keep them bare. Both
  decode the same: payload is `[4CC][BE32 size][data]`. **MOART-FACT**
- Pixel payload: **BGRA premultiplied** with a 64×64 tile grid; runs may
  cross tile boundaries. Encoder = trivial RLE ("Out-of-band PackBits-32");
  literal 1..127 = `n+1` pixels, 129..255 = one pixel `257-n` times.
  `DBOD` stores a linear row-major stream. Full `SRAW` stores a thumbnail
  plus per-tile `[BE32 len]` + data or `[sel][index]` tile reuse
  (sel 0 = this image, 1 = previous image). **MOART-FACT**
- Tiny `SRAW` stubs are directives: `[6][1][0]` repeat previous frame
  (a held exposure), `[2][0][b]` reuse history image b, `[5][0][0][0][0]`
  empty frame. The UDAT node contains one frame-record node per frame. **MOART-FACT**

### How TVMini implements it (all our own code)

- **Writer**: every new drawing's layer frame is rendered to
  straight-alpha RGBA (`renderDrawingRgba`), premultiplied to BGRA, encoded
  with our own PackBits-32 into a **bare DBOD** chunk. Held exposures become
  `[6][1][0]` stubs; gaps become `[5]…` empty stubs; blank drawings collapse
  to empty frames. Layers keep our layer order (topmost first). Node tree and
  global chunks follow the observed layout. **INFERRED** (uncompressed
  variant is a real-file encoding choice; needs one TVPaint round trip).
- **Reader**: walks node records, reads the meta node, collects IFF chunks,
  regroups per layer on `LNAM`, decodes `ZCHK` (deflate) / bare `DBOD` /
  `SRAW` payloads through the tile grid, un-premultiplies with the classic
  reciprocal table arithmetic, resolves empty/same/history stubs, and rebuilds
  a TVMini project: consecutive identical frames merge into one drawing with
  `hold`, each new frame becomes a raster-base drawing
  (`drawing.image` = PNG data URL) so TVMini edits it as an image you can
  paint over/under and erase. **MOART-FACT** for the grammar, our re-mapping
  to the TVMini project model is ours.
- Renders are wired into the browser canvas (raster base under strokes) and
  into `File` → Import/Export `.tvpp`; the round trip is covered by
  `test/tvpp.test.js` (layer order, exposures, holds, empty gaps, hidden
  flags, opacity, exact opaque colours, garbage rejection).

Known limitations (next batches): compressed `ZCHK` *writer* (reader already
handles it), blend modes beyond “Color”, layer `LOPM`/tone curves, audio
chunks, and camera/timeline chunks (`FCFG`, `TLSD`).

## 10. Application shell (MoArt layout, clean-room)

- **MOART-FACT** — MoArt's workspace is a three-column application: a source
  pane on the left (scenario board), the stage in the middle, an inspector on
  the right, and a dockable timeline / dope sheet across the bottom. The
  top bar carries the brand, the project tab strip and the export action.
- **MOART-FACT** — the palette is a mid-grey, *borderless* shell: panels are
  separated by dark seams and a 1px top-edge light instead of drawn borders.
  The recorded tokens were ground `#303336`, well `#292C2F`, surface `#43464A`,
  surface-2 `#4E5257`, surface-3 `#575B61`, text `#E9EBED`, muted `#A9AEB4` and
  a single accent `#3FA3EC` for selection, focus and the playhead. Controls are
  small: 18–22px tall, 12px type, 4px radii.
- **MOART-FACT** — panels are tear-off floating windows driven by a shared
  drag/dock kernel, and a "Window" menu opens the scenario board, the paper
  sheet, the paint tools, the colour picker, the brush settings, the swatches
  and the timesheet.
- **TVMini implements it as** — the same three-column shell plus a bottom
  timeline dock, a `Window` menu that toggles Tools / Stage / Inspector /
  Timeline, per-panel hide buttons, a drag grip that resizes the timeline, and
  a document tab that follows the project name. The palette uses the recorded
  token values.
- **Clean room** — the layout and the colour values were taken from the study
  above; no MoArt markup, CSS, JavaScript or assets were copied. The shell is
  plain HTML/CSS/JS written for this project.

## 11. The camera (MoArt), and what TVMini does with it

Studied from the shipped `index.html` (ver2958) of the user's own copy. Read
only; no code, markup or CSS was copied.

### 11.1 What MoArt's camera is (MOART-FACT)

- The camera is a **track of keyframes** on the timeline. Two surfaces exist
  with two models:
  - the *conte* surface: `project.camera = { keyframes: [...] }`, each key
    bound to a **cut** (a timeline segment) with its frame counted inside
    that cut;
  - the *genga* surface (the animation canvas): `cameraWork = { x, y, w, h,
    rotation, keyframes: [...] }` with **absolute** frames.
- A keyframe carries `{ id, cutId, frame, x, y, scale, rotation, rect, interp? }`.
  `scale` is clamped to `[0.05, 8]`, `rotation` is stored in **radians**, and
  `rect` is the paper-space window derived from them. Files store the rect.
- `interp` is optional and only ever `"ease"` or `"hold"`; absent means
  linear. The curve is `keyInterpT`: `hold → t >= 1 ? 1 : 0`, `ease → t²(3−2t)`
  (smoothstep), otherwise linear.
- The lookup finds the **previous** key (last one at or before the frame) and
  the **next** key (first one at or after it). Before the first key the first
  key is already in effect; after the last key it stays. The easing comes
  from the **previous** key.
- The window is interpolated in rect space: `x`, `y`, `w`, `h` are lerped and
  the **rotation takes the shortest path** (350° → 10° goes over the top, not
  the long way round).
- The **UI** is a frame drawn over the canvas: drag it to move, corner
  handles to resize (the aspect ratio is kept), a rotate mark to turn it, a
  dim fill outside it, a dashed **motion path** with a dot on every key, and
  a centre mark. The timeline lane shows a "CAMERA" label with ◀/▶ key
  navigation and a button that **toggles a keyframe at the playhead** — the
  new key inherits the camera as it is shown at that moment.
- The **export renders through the camera** (`gengaCameraWorkAt` feeds the
  frame renderer), so the exported picture is the shot, not the whole paper.
- During playback the *genga* surface plays "seamless camera view in place":
  the camera frame stays where it is and the artwork moves through it, with
  everything outside the frame darkened.

### 11.2 What TVMini does (TVMini's own code)

- The same **idea**, in TVMini's own model: `camera.keys` is a list of
  `{ frame, x, y, width, height, rotation, interp }` with **absolute frames**
  (TVMini has no cuts), `rotation` in **degrees** (friendlier for a user
  facing number fields) and `interp` of `linear` / `ease` / `hold`.
- The **kernel** lives in `public/timeline.js` (`cameraAt`,
  `cameraInterpT`, `cameraView`, `cameraCorners`) and is shared by the
  browser, the PNG renderer and the tests. The previous key's `interp`
  decides the easing, the rotation takes the shortest path, and the first
  and last keys hold outwards.
- The **editor** is a camera tool (`C`): drag the frame to move it, drag a
  corner to resize it (the shape is kept), drag the handle inside the top
  edge — or hold `Shift` while dragging — to turn it. The drag writes a
  keyframe on the current frame, exactly like MoArt's toggle button.
- The **timeline lane** shows a diamond per key, a button that toggles the
  key on the current frame (`Shift+C`) and a button that switches between
  the camera view and the editor view.
- The **Inspector** carries the framing (x, y, width, height), the rotation
  and the motion (`linear` / `ease` / `hold`) of the key on the current
  frame.
- The **export** (PNG) is cropped to the camera window of the frame being
  exported, with the rotation applied, so the picture is the shot. The
  `.clip` and `.tvpp` exports still use the canvas size.
- The motion path and the key dots are drawn on the canvas in the editor
  view, and the area outside the frame is dimmed.

### 11.3 Differences (deliberate)

- TVMini has one camera model, not two, and its keys are absolute.
- TVMini's camera view shows the shot filling the stage; MoArt's genga
  surface keeps the frame in place and moves the artwork through it. TVMini
  shows the moving frame over the artwork in the editor view instead.
- No "position limit" (MoArt's checkbox that keeps the frame centred on one
  axis) and no separate camera preview window.

## 12. Validation status

- **`.tvpp` round trip**: our writer ↔ our reader, byte-structural tests pass
  (90 tests total green). Real TVPaint validation still pending: **give the
  app one real `.tvpp` save** and we can check the reader both ways.
- **`.clip`**: our writer already validated in CSP EX v3.0.0 previously.
- The full-timeline `.clip` reader and the camera system remain the agreed
  next large batches. The **camera system is now built** (section 11): the
  model, the interpolation, the draggable frame and the cropped export are
  in, with tests in `test/camera.test.js`. The full-timeline `.clip` reader
  is still open.
- A **read-only `.clip` container inspector** came with it
  (`readClipDocument` in `src/clip.js`): it reports the tables, the layer
  records, the canvas size and its own limits, and it never writes to the
  file. It reports the native structure, it does not claim to decode CSP's
  raster tiles into editable pixels.

## 13. The shell, brought in line with MoArt (measured 2026-10-21)

The palette tokens of section 10 were already recorded, but the window was
still painted in the old light grey and the timeline was a band at the top.
This batch put the shell on the recorded tokens.

### 13.1 What changed (our own code)

- **The whole window is the MoArt shell now.** `:root` carries the recorded
  values — ground `#303336`, well `#292C2F`, surface `#43464A`, surface-2
  `#4E5257`, surface-3 `#575B61`, text `#E9EBED`, muted `#A9AEB4`, accent
  `#3FA3EC` — and every rule reads them, so the panels, the wells, the
  buttons and the fields are the same greys as MoArt's. One blue means
  "live" and one red means "the playhead"; nothing else is coloured.
- **The timeline is a dock at the bottom**, the way MoArt's dope sheet is,
  with the properties bar above it and the status bar below. The drag grip
  sits above the timeline, so pulling it down gives the timeline more room.
- **The rows of the timeline are one line high.** `--tl-row-h` is the single
  source of that height and the head, the cells, the lanes and the ruler all
  read it, so the rows cannot drift apart. The *Compact view* button in the
  header switches them to 34px rows and the choice is remembered.
- **The ruler marks the playhead with a red triangle** in the key line, and
  the frame the playhead is on is the only number in the ruler that is red.
- **The frame numbers are written the way MoArt writes them.** MoArt's ruler
  puts a monospace digit at the *left* of every frame column, 9px, in the
  muted colour, with the column's line standing on the left of the number
  (`font-family: ui-monospace, Consolas, monospace; font-size: var(--fs-sm);
  position: absolute; top: 4px; left: 3px`). It writes **every** frame in
  the window and hides the small labels when a column is narrower than 16px
  (`--genga-minor-label: cellW < 16 ? 'none' : 'block'`). TVMini does the
  same: the numbers are monospace and left-aligned, every frame is written,
  and the column is never narrower than the number it has to hold — the
  widest number of the ruler decides that width, so a project past frame 100
  gets wider columns rather than clipped digits.
- **Every frame gets a column of the same fixed width.** MoArt sizes the
  timeline with `width: calc(var(--genga-cell-w, 22px) * frames)` — the
  columns are fixed, and the timeline grows by scrolling, never by
  stretching. TVMini was doing the opposite (`minmax(min, 1fr)`), so a short
  scene spread its twelve frames across the whole window and every number
  floated far away from the frame it named. The columns are fixed now: the
  number of a frame stands directly above that frame, and a long scene
  scrolls sideways.
- **The strip is three hundred frames long** and is scrolled across. MoArt
  reaches the same place with a zoom knob on a rail (`--genga-cell-w`, the
  `.tl-zoom-knob` and the `.tl-vbar` beside the timeline); TVMini has no
  zoom, so the strip is simply long and scrolls, which is the same idea
  without a control to learn. The rail under the strip is thin, so it does
  not eat a row of frames.
- **The tool property panel is one tall column on the left**, the way
  MoArt's is: the colour circle at the top, then the tools, then the
  history, then the brush and the pen. The properties of the tool used to
  live in a bar along the bottom of the window; they live in the panel
  now, and the bottom of the window belongs to the stage and the timeline.
  MoArt's panel is called *TOOL PROPERTY* and is headed by small captions
  — *Color circle*, *Tools*, *ERASER* — so TVMini's is called the same and
  its parts are captioned the same way.
- **The colour circle is always on screen.** MoArt's panel holds the hue
  ring with the saturation/value square inside it permanently, and TVMini
  used to keep the wheel behind a button that opened a floating panel.
  The wheel sits in the panel now, at 176px, and follows the colour from
  the start.
- **The wheel follows the cursor, and it follows the colour.** The ring is
  drawn with the arc of a hue at the angle of that hue, and the point that
  is picked reads the hue at that same angle, so the marker of the ring
  lands on the arc that was clicked and the colour that comes out is the
  colour of that arc — the marker is never a quarter turn away from the
  cursor. The square is asked before the ring, so its corner, which
  reaches the inner edge of the ring, is a click in the square and not a
  change of the hue. The wheel also follows the colour of the strokes
  wherever that is changed — the colour picker of the browser, the
  eyedropper or the hex field — so the marker of the ring and the dot of
  the square always stand for the colour that is in use. A grey has no hue
  of its own, so the ring keeps the hue it had instead of jumping to red.
- **Every panel can be taken out of the window and put where it belongs.**
  MoArt's panels sit in a fixed frame, but the window of TVMini is the
  user's to arrange: the head of a panel is the handle that moves it, and a
  drag pulls the panel out of the window and over it. The panel goes
  **exactly where it is put** — it may hang over the edge of the window, as
  long as a strip of it stays on the screen to grab it by — and the panel
  keeps its place in the window all the same, so the panels around it do
  not move, and the column it used to hold is given to the others. A panel
  that floats has handles on its edges and in its corners to make it
  bigger, and a button in its head (or a double-click on the head) puts it
  back where it was.
- **A panel is taken out of the window with a button, not with a drag.** The
  `⇱` button next to the name of a panel floats it **where it stands** —
  the same window, only loose, so it does not jump anywhere when it is
  taken out — and the `⇲` button that takes its place puts it back where
  it came from. The same grips as the one of the timeline sit on the seams
  of the window: the one on the left makes the tool property panel wider,
  the one on the right makes the column of the layers and the inspector
  wider, and the one between the layers and the inspector makes the layers
  taller. A grip grows the panel **away from the edge the grip sits on**,
  so the grip on the top edge of the timeline makes the timeline taller
  when it is pulled up. The layout is remembered, so the window comes back
  the way it was left.
- **The stage zooms around the pointer.** The point of the document under
  the pointer is worked out before the zoom, and the document is placed
  afterwards so that the same point lands under the pointer again. Each
  axis is worked out on its own — the horizontal point and the vertical one
  are different points of the document, and using one for both slides the
  picture away from the pointer. The pane is scrolled to move the
  document, and what the scroll cannot take (because the document is
  smaller than the pane and there is nothing to scroll) is left to a
  shift of the sheet. The shift is a translation, so the picture stays
  sharp, and the browser's own scroll anchoring is turned off so it
  cannot move the picture behind our back. Measured: the pointer stays
  on the same point of the document to within a tenth of a pixel, in
  both directions, whether the document is larger or smaller than the
  pane.
- **The stage is a window onto a world, not a box.** MoArt keeps an explicit
  pan (`state.gengaPanX`, `state.gengaPanY`) and a zoom
  (`state.gengaZoom`, clamped to 0.1…8), and the paper is placed in the
  workspace rather than filling the viewport — which is why its scrollbars
  stay alive at 43% and the paper can be moved anywhere.
  TVMini now does the same thing with the pane it already had: the document
  sits in a **world** that is always a little larger than the pane, so the
  bars of the pane keep their range at any zoom, and the document is
  centred in the world. The zoom controls moved into the head of the stage
  the way MoArt has them — the size as a percentage, a bar to make it
  smaller, a bar to make it bigger, and a button to show the whole document.
  The percentage is a button as well: it goes back to 100% and centres the
  document, which is what MoArt's reset does.
- **The wheel zooms over the whole stage**, not only over the document, and
  the point of the document that is kept is the one under the pointer — or
  the nearest edge of the document when the pointer is over the empty
  stage beside it.
- **Every mark is a shape, not a picture of a character.** The transport, the
  eye, the lock, the fold arrow, the camera key and the row buttons are
  drawn as SVG in one sprite at the top of the page, so the window looks the
  same on every machine — and the colour-emoji glyphs that used to render
  the transport as blue blocks are gone.
- **The toolbar of the timeline carries a shape for each thing it acts on:**
  a **rectangle** is a layer, a **circle** is a folder and a **triangle** is a
  drawing. The action that takes a thing away is the same shape with a
  **bar in front of it**. The six buttons are layer, folder, folder away,
  layer away, drawing and drawing away, and not one of them carries a word.
  The layers panel uses the same six, so the two places that do the same
  thing look the same.
- **A bug in the layout was found and fixed while doing this.** Hiding a
  panel took its grid row with it, and every part below it slid up by one.
  Each part of the window now says which row it sits in, so the window holds
  still when a panel is hidden.

### 13.2 Clean room

- Nothing was copied from MoArt's build. The palette values are the ones
  already written down in section 10 of this document; the shapes, the
  sprite, the geometry and the code are ours. The sprite at the top of
  `public/index.html` is drawn from scratch in the same way as the icons
  that were already in the file.

### 13.3 Checked

- 285 tests green (`node --test`).
- The whole window, the timeline at 1× and at 3×, the layers panel, the
  tools panel, the properties bar, the export dialog and the start screen
  were rendered and looked at.
- Every rewritten button was driven in the running app: add layer, add
  folder, fold, delete layer, add drawing, delete drawing, the eye, the
  lock, the camera key and the *Compact view* switch all still do what they
  did.
- Hiding the timeline, the properties and the tools panel, and putting them
  back, was measured: the window holds still.

