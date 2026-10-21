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


