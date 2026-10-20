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
shipped earlier. Includes eraser touch-draw toggle. Still stubs by design;
the interesting pieces to adopt next are coalesced events (smoothness on fast
strokes) and size preview multiplier.

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

## 11. Validation status

- **`.tvpp` round trip**: our writer ↔ our reader, byte-structural tests pass
  (90 tests total green). Real TVPaint validation still pending: **give the
  app one real `.tvpp` save** and we can check the reader both ways.
- **`.clip`**: our writer already validated in CSP EX v3.0.0 previously.
- The full-timeline `.clip` reader and the camera system remain the agreed
  next large batches.
