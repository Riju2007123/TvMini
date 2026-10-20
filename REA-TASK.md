# REA-TASK

## Answers (step 1 — ASK)

| Question | Answer |
|---|---|
| What to reverse | Desktop app (.exe, Windows) |
| Where it is | `C:\Program Files\TVPaint Developpement\TVPaint Animation 12 Pro Demo\TVPaint Animation 12 Pro Demo.exe` |
| The ONE feature | What restrictions stop us from using **Save Project**, **Save Project As**, **Export**, and **Recent** |
| Goal | **C** — my own working version (independent implementation, no copied code) |

## Scope note

Goal C means building an independent, clean-room working version of the
*save / export / recent-files* behaviour. It does **not** mean patching,
unlocking, or bypassing TVPaint's demo or licensing checks. Any evidence found
about licence enforcement is reported as documentation only.

## Progress log

- **Step 1 — ASK:** done. Answers recorded above. No target files touched yet.
- **Step 2 — SETUP:** done.
  - Node `v24.22.0`; `rea doctor --client opencode` aligned; skill version **42**, 207 tools.
  - Ghidra 12.1.4 + JDK 21 installed; `doctor --provider ghidra` → `healthy: true`.
- **Step 3 — ROUTE:** done — **native Qt6 C++**, not Electron.
  - PE32+, x86-64, 15,050,584 bytes, SHA-256
    `58d3e103ab789aeb81f9ab80a8c78594b72f3612eb58f611cfd193a5c534a3c0`.
  - Evidence `ev_4ca6db343ebe4b1fdc933f7004949a43398895d7763e3665b5910f4f9f325206`.
- **Step 4 — TRACE:** done. See `REPORT.md` for the full evidence chain.
  - Save Project / Save As end in a 3-byte `xor eax,eax; ret` stub. CONFIRMED.
  - Export is blocked by five demo guards that show localization message 1315. CONFIRMED.
  - Recent has no demo gate; it is a consumer of the save/open history. CONFIRMED (no gate).
- **Step 5 — REPORT:** done — `REPORT.md`.
- **Step 6 — BUILD:** done — `SPEC.md` + `build/my-version` (independent app + tests).
  - Follow-up: pen pressure support (per-point `[x, y, pressure]`, tapered
    canvas + PNG export) and undo/redo (100-step snapshot history).
  - 40/40 tests pass.
- **Step 7 — REPO:** private repo
  `https://github.com/Riju2007123/tvpaint-save-export-rea` (branch `master`).
- **Step 8 — CLIP STUDIO PARITY:** done.
  - The user showed a 75 s recording of Clip Studio Paint EX building an
    animation: an "Animation folder" whose children are the cells
    `1`, `1a`, `2`, `2a`, `3`, `4`, a nested layer group, a clip mask and the
    keyframe buttons of the timeline.
  - Added to TVMini: **layer folders** (nested), **named cells** (`1`, `1a`,
    `2`, `2a`), a **clip mask**, **keyframe navigation**, and a `.clip` import
    that brings in the whole document — folders, animation folders and the
    cells of an animation — as frames on the timeline.
  - The cell naming rule was read out of 45 real `.clip` files: a cell is
    named after the frame it sits on, with a letter for a second cell on the
    same frame. See `build/my-version/docs/clip-format-study.md`.
  - Project format is now version 3 (folders, clip mask, cell names);
    version 1 and 2 files are migrated on load.
  - 176/176 tests pass.
- **Step 9 — TIMELINE LOOK:** done.
  - The timeline is drawn the way Clip Studio Paint draws it: a ruler with the
    keys of the animation above the frame numbers, a tinted column for the
    frame that is shown, a line for the first frame, a **⊞** button on every
    row that adds a layer next to it, a settings menu for the timeline, and
    *frame / first frame / last frame* in the corner.
  - The names of the cells and the keys can be hidden.

**next step: all steps complete — see REPORT.md / SPEC.md**
