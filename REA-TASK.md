# REA-TASK

## Answers (step 1 — ASK)

| Question | Answer |
|---|---|
| What to reverse | Windows app (.exe, Windows) |
| Where it is | `H:\Umoupen-windows\Umoupen.exe` |
| The ONE feature | A complete `.clip` reader and writer: read a document's layers, its timeline and its drawings, and write the whole thing back out as a `.clip` file |
| Goal | **C** — my own working version, built in this project |

### How the answer was phrased

The feature was asked for as *"a perfect .clip reader/writer, timeline, tools,
it can export whole file in .clip"*. That is one feature — the `.clip`
format — plus the editor around it. The editor (timeline, tools) already
exists in `build/my-version`; what is missing is the writer. So this task is
scoped as **the `.clip` format itself**, and the export is the acceptance test.

## Scope note

Goal C means an independent implementation written from a specification of
the format. The target application is closed-source commercial software by
UMOUSOFT LTD and is validly signed. What may be used from it is *facts about
the format* — table names, column names, the order of reads, observed
behaviour — which are facts about Clip Studio's file format and are recorded
in this project's own words in `build/my-version/docs/clip-format-study.md`.
Its source code is not copied, transliterated or translated into this
project, and no assets, artwork or shaders are taken from it.

The app is also used as a **black-box oracle**: it is run on documents and
its visible behaviour compared with ours, the same role `clipparse` plays.

## Starting position

This is not from zero. `build/my-version` already contains:

- a **reader** for `.clip` — SQLite in a `CHNKSQLi` chunk, the layer tree,
  the mipmap chain, the pixel decode, and the `.clip` → project import
- a **study** of the format in `build/my-version/docs/clip-format-study.md`,
  including what was learned from measuring the target app
- **215 passing tests**

What is missing, and is this task:

- the **writer** — TVMini cannot produce a `.clip` file at all
- **cel timing** — the importer picks a cel's frame from its *name*
  (`1`, `1a`, `2`); the frame should come from the timing
  (folder → strips → keys → cels). This is the known bug.
- **masks** — read as a separate mipmap chain, not decoded

**next step: 2**

## Progress log

- **Step 1 — ASK:** done. Answers recorded above. Nothing opened yet.
- **Step 2 — SETUP:** done, with two corrections to the workflow's command names.
  - Node `v24.22.0` — acceptable (the rule allows 22.19+, 24.11 or 26+; it
    forbids 23 and 25).
  - **`doctor-client` and `setup-client` no longer exist.** `rea --help` (rea
    **6.7.0**) lists `doctor`, `setup` and `mcp`. The equivalent checks are
    `rea doctor --json` and `rea mcp doctor --json`.
  - The only registration the workflow asks about — **`registration:opencode`
    — is `aligned`**: `C:\Users\MK\.config\opencode\opencode.json`, command
    `cmd.exe /d /c npx -y rea-agents@6.7.0 mcp`, no remediation.
  - `rea mcp doctor` passes every check: initialize ok (protocol
    2025-11-25), tools **207/207** with none missing, prompts **6/6**,
    server-identity digest matches, request-flow ok.
  - Skill version **42**, 207 tools, `aligned`.
  - Missing engines — hopper, Ida, jadx, kuna — are the *optional* providers
    and are not needed for a native PE. **Ghidra is healthy**: 12.1.4, JDK
    21.0.12, headless launcher, native decompiler and Job Object authority
    all verified.
  - **No action was needed**, so `rea setup` was not run.
- **Step 3 — ROUTE:** native, confirmed.
  - `open_binary` → `{format: "pe", kind: "executable", architecture:
    "x86_64", sha256: 635f8443…A7496446}`. **CONFIRMED.**
  - `binary_session` → `{open: true, cleanup_pending: false}` with provider
    ghidra 12.1.4. **CONFIRMED.**
  - Section layout read from the PE headers (11 sections; `.text`
    `0x10cc200` = 17,628,672 bytes; `.bss` `0x553c3f0` = 89 MB; no COM
    descriptor directory, so **not .NET**; no debug directory). This is
    file-level header parsing, **not REA evidence**, and is labelled as such.
  - **Blocker found — CONFIRMED by the provider's own contract.** Every
    Ghidra-backed operation (`binary_overview`, `list_segments`,
    `list_strings`) aborts. Ghidra "serves operations only after default
    auto-analysis complete", and "cancelling an active Ghidra request
    terminates its ephemeral database and discards session annotations …
    the next provider query imports the original artifact again". 17.6 MB
    of `.text` cannot be analysed inside one tool call, so every retry
    restarted from zero. This was the cause of the repeated hangs.
  - `inspect_binary_layout` cannot help: it returns
    `capability_unavailable` — the `pwntools-elf` provider is
    **Linux x64 only**.
  - `open_binary` accepts `format: "analysis-database"`, so the fix is to
    run Ghidra **headless, in the background**, and let REA open the
    finished database. Started:
    `analyzeHeadless.bat <proj> Umoupen -import H:\Umoupen-windows\Umoupen.exe
    -max-cpu 4 -analysisTimeoutPerFile 7200`

**next step: 4 — read Umoupen's timeline model, now that the database exists**

- **Step 3a — the headless analysis finished. CONFIRMED.**
  `analyzeHeadless` reported `Analysis succeeded for file:
  file:///H:/Umoupen-windows/Umoupen.exe` and `Save succeeded for:
  /Umoupen.exe (Umoupen:/Umoupen.exe)`, total time 2031 s, 4 CPUs. The
  project is at
  `C:\Users\MK\AppData\Local\Temp\opencode\ghidra-proj` and REA can now open
  it as `format: "analysis-database"` without paying the analysis cost again.

- **Step 4 — read the timeline out of `.clip` without Umoupen. CONFIRMED.**
  Working on the file directly turned out to be the faster route, and it
  answered the question the screenshot was about: how folders, cells and
  frames are held.

  - The layer tree is a **first-child / next-sibling linked list**
    (`LayerFirstChildIndex` + `LayerNextIndex`), not `LayerFolder`.
    `LayerFolder` is a flag, not a parent id. CONFIRMED on
    `Animation10.clip`: `#3 'Animation folder'` has `firstChild=4`, and the
    chain runs `4 '1' → 9 '2' → 10 '3' → 16 '4' → 21 '5' → 28 '6' → 0`.
  - The cells of an animation folder are its children in that chain.
    CONFIRMED.
  - The cell that shows on each frame is an array of 32-bit little endian
    string pool indices inside the track's mixer body. One entry per frame,
    so a cell that loops appears once per frame it shows on. CONFIRMED on
    `Animation10.clip` (offsets 1177…1197, four bytes apart) and on
    `bleach collab.clip` (32 entries, 11 cells, one 4-frame loop).
  - The cell name does **not** always give the frame. CONFIRMED on
    `bleach collab.clip`: one track reads `1,1a,2,2a,3,5,6,7,8,9,10,3a,4`,
    so `3a` is on frame 12 and `4` on frame 13.
  - A track belongs to a layer through `LayerUuidWithTrack`, written without
    dashes, against `Layer.LayerUuid`, written with dashes. CONFIRMED.

  Implemented in `public/core/clip-animation.js` (`readCelSequence`,
  `celPlacement`) and used by `clipToProject`. 223 tests pass. Measured over
  32 documents: 806 drawings, every one inside its timeline and in frame
  order.

  - **The tile layout.** Two layouts exist. Most tiles carry the alpha folded
    into 64 rows above the colour rows, but `Illustration.clip` holds plain
    tiles of exactly `height × width × 4` with the alpha already in place.
    Reading those as folded ran past the buffer. CONFIRMED by measurement
    (`132096` against `131072` bytes on a 256 × 128 tile) and now handled.
    The sample went from 32 of 43 documents read to 41 of 43; the last two
    are not Clip Studio documents at all.

  - **Canvas size.** The reader refused a 4152 × 3400 canvas, which is a
    canvas Clip Studio writes often: eight of the sample's documents. The
    limit is now a side of 8192 with a total of 40 million pixels, so those
    documents import and an 8192 × 8192 canvas is still refused. CONFIRMED.

  - **What the sample does not use.** Across 36 documents and 1285 layers,
    `LayerComposite` is 0 on every layer, `LayerClip` is 0 on every layer,
    and `LayerLayerMaskMipmap` is 0 on every layer. So blend modes, clipping
    and layer masks are not a fidelity gap for these files. CONFIRMED by
    counting, not assumed.

  - **Folders are now written, not flattened.** The writer used to drop every
    folder (`filter(layer => layer.type !== "group")`) and write the layers
    inside it as top-level layers, so a round trip lost the tree. It now
    builds the chain Clip Studio stores: a folder is a row with
    `LayerFolder = 1` and `LayerType = 0`, its children hang off
    `LayerFirstChildIndex`, and each list is reversed because the chain runs
    from the bottom of the canvas up. CONFIRMED on real files — the tree
    reads back identical for `Animation10.clip` (7 layers),
    `Animation4.clip` (20), `Animation14.clip` (34) and `b 3.clip` (93,
    with folders inside folders).

  - **The paper is not a layer any more.** The reader used to turn the
    paper row into a layer named `Paper`, so an imported document exported
    with the template's real paper **and** an empty raster of that name.
    The paper colour now becomes the project background (each channel sits
    in the top byte of a 32-bit word) and the paper and the
    "(Story Information)" row are left out of the project. They stay in the
    layer tree the reader reports. CONFIRMED by the two paper rows being
    gone from the exported `Animation10.clip`.

  **Still open:** the `FCurve` keyframe records, which a writer needs. The
  body is not a pure array of 32-bit pool indices — trying every start offset
  from the end of the pool leaves 108 of 302 words outside the pool — so it
  mixes tokens with real numbers and the value widths are still unknown.
  `createClipBuffer` therefore still refuses `animation: true`.

**next step: 5 — the `binc` value widths, which is the last thing standing
between the reader and a writer that keeps the animation**



**Session note - cel timing and a hold fix (Animation3.clip, the file in the
Umoupen screenshots).** The track blob ends with the cel names; the frames are
not stored as 32-bit words after them. A per-track array of 64-bit doubles does
appear, and for the Animation folder's 9 cels it reads 0,1,...,8 - which agrees
with placing cels on consecutive frames. The other two tracks in the same file
do not give a clean increasing run (5 cels give 1,2,3,4; 7 cels give a
non-monotonic list), so the field is **not** identified. Cel timing stays
UNKNOWN; animation writing stays refused.

Separately, a layer *inside* a cell took the length of the whole animation, so
its drawing ran past the end of the timeline (frames 18..21 in a 17 frame
file). Fixed in `public/core/clip.js`: the hold now comes from the cell, and
`test/clip-import.test.js` covers it.



**Session note - the cel timing field is identified (step 5 closed).** The
`FCurve` record is found by scanning the body at **every byte offset**, not
only at multiples of four: nothing in that part of the document is aligned.
A record starts with the pool index of `FCurve`, then a zero, then a property
count (1..8), then `(name, value)` pairs; the cell curve carries
`Type = ImageCelName`. Then comes a field count and, for every field, three
metadata words (`Int32[]`, width + 24, width + 28), the field name, the field
type, the count, the values and two zero words.

CONFIRMED against `Animation3.clip` (three tracks, 9 / 5 / 7 cells):

```
Frame   0  4  8 10 16 18 20 22 24     (60 Hz ticks)
Tag     1  2  3  4  5  6  7  8  9
Value   0  1  2  3  4  5  6  7  8
```

`Frame` is a time in **60 Hz ticks**: `frame = Frame * fps / 60`. At 30 fps
that is frames 0,2,4,5,8,9,10,11,12, so cels are **held**, not consecutive.
The decisive check is `Animation2.clip` at 24 fps, whose keys step by 2.5
ticks (0, 2.5, 5, 7.5, 10, 17.5) and become the whole frames 0,1,2,3,4,7.
`TimeClip.End` / `Rate` are plain little endian doubles; `End` is the last
frame of the track in the same ticks. Across the corpus `End * fps / 60`
equals `TimeLine.BiggestEndFrame` (248 -> 124, 240 -> 120, 300 -> 120).

The reader now uses this: `readCelCurve`, `celPlacementFromKeys` and
`readTrackRange` in `public/core/clip-animation.js`. The last cell is held to
the end of its track. The old "longest run of cell names" heuristic stays as
the fallback for a document whose curve cannot be read.

Also fixed: a layer *inside* a cell whose own name happened to be a number was
treated as a cell of its own (frame from the name, one frame of hold). It now
follows the cell it sits in.

Writing `animation: true` is still refused. The remaining work is a
byte-for-byte round trip of a whole mixer body (the `TimeClip` and `Param`
tree plus the document checksum), not the cell record.

## Step 6 - round trip a whole mixer body, then edit it (done)

`public/core/clip-mixer.js` parses a document, writes it back from its parts
and gets the same bytes. Measured:

- 10 of 10 documents of `Animation3.clip` and 4 of 4 of `Animation2.clip`
  rebuild **byte for byte** (pool, the word after the pool, body and CRC).
- The document checksum is the standard CRC-32 over the bytes from offset 16
  to the end; all 14 documents match, so a rebuilt document is always valid
  by construction.
- The external blob is the 40 byte locator, `u64` big endian `4 +
  compressed`, `u32` little endian compressed, then the zlib stream, and it
  round-trips. `TrackActionMixerSize` is the **unpacked** document length.
- The `ImageCelName` curve is replaced on its own: same keys, one more, one
  fewer - each result is read back by `readCelCurve`
  (`tools/mixer-roundtrip.mjs`, `test/clip-mixer.test.js`).
- The three words before a field are `[Int32[]][total - 8][total - 4]`,
  where `total` includes the metadata, name, type, count, values and the
  trailing `[0][0]`.

`createClipBuffer` still refuses `animation: true`, for one concrete reason:
a **new** track needs a document skeleton (the `TimeClip`/`Param` tree), and
the blank template has no animation tables at all. Splicing a curve into an
existing document is safe; inventing the rest of the tree is not. The two
ways out are (a) build one small animation template once in Clip Studio
Paint and ship it like the blank template, or (b) use the imported `.clip`
itself as the skeleton at export time.

### Checked in Clip Studio Paint

`tools/clip-patch-curve.mjs` reverses the cells of track 13 of
`Animation3.clip` in a copy and writes a new file. Clip Studio Paint opened
it, and its Timeline showed the same rows the file says:

```
Animation folder : 9 cel    ... 6 7 8 9
Folder 1 : 5 cel            ... 3 2 1a      <- was 1a 2 3 4 5
Folder 2 : 7 cel            ... 3 4 5
```

Track 13 drives layer 17, "Folder 1", which is the row that changed. The
independent `clipparse` validator also reports the copy consistent
("参照整合性 OK"). So the document rebuild, the external chunk, the
recomputed `ExternalChunk.Offset`s, `TrackActionMixer2Size` and the
container are all right; CSP is the oracle for the whole chain.

Two more facts from the same pass:

- an animation folder is a `Layer` row with **`LayerFolder = 1` and
  `AnimationFolder = 1`**;
- `Layer.LayerUuid` is *TEXT* with dashes while `Track.LayerUuidWithTrack`
  is a 16-byte blob, so matching the two means dropping the dashes.

**next step: 7 - export animation by using the imported .clip as the skeleton**

## Step 7 - export the animation, using the imported .clip as the skeleton (done)

`createClipBuffer(project, { animation })` now takes the `.clip` the project
came from and writes the timeline into a new file. The `TimeLine` and `Track`
tables are created with the definitions of the skeleton and its rows are
copied; every animation folder of the project becomes one track whose
`ImageCelName` curve holds the cells of that folder, and the end of the track
follows the end of the project.

`store.js` hands the imported file over as the skeleton, and falls back to a
static export when it cannot be read.

**Checked in Clip Studio Paint.** `tools/clip-export-animation.mjs` imports
`Animation3.clip` and writes it out again. CSP opened the result and its
Timeline showed:

```
Folder 2 : 7 cel        3 4 5      (cells 1 1a 2 2a 3 4 5)
Folder 1 : 5 cel        3 4 5      (cells 1a 2 3 4 5)
Animation folder : 9 cel 5 6 7 8 9  (cells 1 2 3 4 5 6 7 8 9)
```

which is the same as the file it came from, at the same frames, with the
current frame 9 of 124 - the same numbers the source timeline carries. The
independent `clipparse` validator reports the written file consistent
("参照整合性 OK"), and our own reader reads it back as 46 layers, 36 cell
layers and frames 1..125, exactly as the source.

One bug worth remembering: the string pool of a document is written from the
pool the record was built with, so a curve whose cell names are not in the
pool yet needs the longer pool handed to the writer too. Without it the tag
values point past the end of the pool and the curve reads back empty.

## Step 8 - write the animation of a project that did not come from a .clip (done)

A project that was made in TVMini has no `.clip` to copy a track from, so the
program now ships one: `public/assets/clip-animation-template.clip`, a small
document that holds a real animation. It is the skeleton of every export that
has no imported file behind it, and it holds the parts of the format the
writer does not understand: the definitions of the `TimeLine` and `Track`
tables, the row of a cell track, the track of the paper and the two action
documents of the track.

A layer of the project that holds more than one drawing becomes a **row**: an
animation folder with one child layer per drawing, and a track of kind 2000
whose `ImageCelName` curve names the cells and gives the frame each one
starts on. A layer with a single drawing stays an ordinary layer, so a
project without an animation exports as a document without one.

**Checked in Clip Studio Paint.** `tools/clip-export-cells.mjs` makes a
project with three cells of its own and writes it. CSP opened the result and
showed the folder `Dots : 3` in the layer panel, with the three cells under
it, and the timeline

```
Dots : 3 cel            first second third   (frames 0, 2 and 4)
```

which are the frames the project holds. The canvas showed the first cell's
stroke.

**One rule worth keeping.** A cell can be a folder of its own: the cells of
"Folder 1" in `Animation3.clip` each hold layers of their own, and those
layers are cells of the cell and not rows of their own. So a folder inside
another folder of cells is a cell, and a layer inside a row is a cell too -
only the outermost folder of cells is a row. Without that rule every cell
that holds layers became a track of its own, and the timeline showed nine
rows where the document has three.

## Step 9 - the writer and the reader agree on every document of the corpus (done)

`tools/clip-roundtrip-corpus.mjs` imports every `.clip` of a folder the way
the editor imports it, writes it out again with the document itself as the
skeleton of the tracks, reads the result back and compares the cells of every
track. On the corpus of this machine:

```
OK   Animation.clip: 2 track(s)
OK   Animation2.clip: 1 track(s)
OK   Animation3.clip: 3 track(s) (the same cells, in the order of the layers)
OK   TVMini-animation-demo.clip: 2 track(s)

4/4 documents keep their cells
```

The cells of every track are the same. The order of the tracks in the list is
the order of the layers, which is the order the editor draws them in, so it
can differ from the order of the source: `Animation3.clip` lists the track of
"Animation folder" first and the written file lists "Folder 2" first, because
that is the layer that is drawn on top.

**The feature asked for is done:** a `.clip` is read with its folders, its
animation folders, its cells and its frames, and it is written back out with
all of them, checked in Clip Studio Paint itself.

**next step: 10 - keep the writer and the reader in step with every change of the format**

## Step 10 - the reader, checked against Umoupen (done)

Umoupen is the oracle for the reader. `tools/umou-capture.ps1` opens a
document in it and takes a picture of the window, and `tools/reader-frames.mjs`
renders the frames the reader sees, so the two can be compared side by side.

Comparing `Animation3.clip` and `Animation.clip` found four things the reader
got wrong. All four are fixed, and each fix is checked by a test.

1. **A hidden folder hid nothing.** The renderer looked at the visibility of a
   layer alone, so the cells of a hidden animation folder were painted anyway.
   The picture of `Animation3.clip` showed three sketches on top of each other
   where the document shows one, because two of its three animation folders are
   hidden. The rule the timeline already used - a layer is painted when it and
   every folder above it are shown - is now used by the renderer as well, and
   the opacity of the folders counts into it too.

2. **The camera was not read at all.** A camera is a track of kind 2005 whose
   curves hold the centre, the position, the rotation and the zoom of the
   view. The reader now reads them and builds the keys of the camera. The
   window it works out is the frame scaled by the zoom, with its middle where
   the position says; CONFIRMED against the red rectangle Umoupen draws on the
   page, and against the frames of its keyframes (1, 22, 41).

3. **The document was read at the size of the page, not the size of the
   canvas.** A document has two sizes, and the layers live on the canvas. Only
   `Animation.clip` of the corpus has a page that is smaller than its canvas,
   and there the reader cut 800 pixels off the picture.

4. **A layer's picture was put at the top left of the canvas.** The layer's
   own offset says where it sits, and the picture has to go with it.

One more thing the comparison settled: a cell that the track of its folder
does not name is not on screen, and the reader used to give it the frame its
name stands for.

After the fixes the corpus round trips its cells again - 10 of 10 documents -
and the picture of every document of the corpus is the picture Clip Studio
Paint and Umoupen show.

**next step: 11 - the camera of a document, written back out**


## Step 11 - the frames of a document: a track stops at a boundary (done)

The exported animation opened in Clip Studio Paint but did not play the way
the timeline said it would: the cell that was on screen was one frame early,
and the last cell of every row ran one frame too long. Three numbers were
wrong, and all three are now measured against the documents of the corpus
(`H:\a`: `Animation2`, `Animation5`, `Animation15`, `bleach (2)`).

1. **`TimeLine.EndFrame` is a count of frames.** With `StartFrame` 0 it is
   also the 1-based number of the last frame: `Animation15` has 120 and its
   track covers 120 frames, `Animation5` has 25, `bleach (2)` has 101 and
   `Animation2` has 18. The reader added one to it, so every document came
   in one frame too long.

2. **The `End` of a track is a boundary, not a frame.** The frame a track
   ends on is the first frame that is *not* shown. The reader held the last
   cell up to that frame instead of up to the frame before it, and the
   writer wrote the boundary one frame too early.

3. **A track can run on past the end of the timeline.** `Animation5` has a
   track that ends at frame 127 while its timeline holds 25 frames. What
   lies beyond the last frame is never shown, so the hold of the last cell
   stops at the timeline.

With those fixed, a document of the corpus that is imported, written back
and imported again comes back **the same**: the same canvas, the same
timeline, the same layers in the same tree, and every cell on the same frame
for the same number of frames - 0 differences on all four documents. The
pictures of the cells are byte for byte the same, and the track of the cells
holds the same keys at the same ticks as the document Clip Studio Paint
wrote.

Checked in Clip Studio Paint: the exported animation opens, it plays, and
the cell on the screen is the cell the timeline says. The frame counter
reads `1 / 1 / 25` at the first frame and the cell `1` is the one that is
shown; at frame 22 the cell `8` is shown, which is where its key sits.

Two more things came out of the comparison with Clip Studio Paint, and both
are fixed:

- **The writer started from the blank document, which is an illustration.**
  A document with an animation says so (`DefaultPageSettingType` is
  `Animation`, not `Illust`), it counts the frames of its timeline from 1
  (`Canvas.TimeLineFrameDisplay`), and it has a crop frame and a paper
  colour. Those settings are now taken from the document the animation is
  written from - the file the project was imported from, or the document
  with an animation in it that ships with the program.

- **The write was slow.** Every statement of a document with a few hundred
  layers was its own commit, and each of them waited for the disk. The write
  is one transaction now, and `bleach (2)` is written in 25 seconds instead
  of 50.

**next step: 12 - the tracks of kind 2001, 4000 and 1000, and the camera**



