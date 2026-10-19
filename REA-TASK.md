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
  - Node `v24.22.0` — healthy (allowed range).
  - `rea doctor --client opencode` before setup: `registration:opencode` = **false**, config_drift.
  - Dry-run planned exactly 2 actions: register OpenCode MCP, install REA skill.
  - `rea setup --client opencode --yes` applied: `configured_opencode`, `installed_skill`.
  - Doctor after setup: `registration:opencode` = **aligned**, skill version **42**, 207 tools.
  - Ghidra / JADX / IDA / Kuna / Hopper still missing — informational, expected.
  - Blocked on client restart: the running OpenCode process still uses the old config.
- **Step 3 — ROUTE:** decided — **native, not Electron**.
  - No `.asar` found anywhere under `C:\Program Files\TVPaint Developpement`.
  - Install folder contains `Qt6Core.dll`, `Qt6GUI.dll`, `Qt6Widgets.dll`,
    `Loader.dll`, `platforms\` → Qt6 native C++ application.
  - REA `inspect-pe-resources` evidence `ev_4ca6db343ebe4b1fdc933f7004949a43398895d7763e3665b5910f4f9f325206`:
    - SHA-256 `58d3e103ab789aeb81f9ab80a8c78594b72f3612eb58f611cfd193a5c534a3c0`
    - PE32+, machine 34404 (x86-64), 15,050,584 bytes
    - 50 resources / 106 entries, coverage complete
  - Window version info: 12.0.2, "TVPaint Animation 12 Pro (64bits) (DEMO)".
  - Required provider: **Ghidra 12.1.x** (verified upstream with 12.1.4) plus a
    64-bit full **JDK 21+**; `GHIDRA_INSTALL_DIR` points at the extracted folder.
  - Current blocker: `doctor --provider ghidra` → `GHIDRA_INSTALL_DIR` not set;
    `java` is not installed.
- **Step 7 — REPO:** local repo exists (commits `fe455a1`, `95917e0`).
  `gh` 2.102.0 installed via winget, login started, device code issued.
  Push still pending until `gh auth login` completes.
- **Step 4 — TRACE:** not started.
- **Step 5 — REPORT:** not started.
- **Step 6 — BUILD:** not started.
- **Step 7 — REPO:** not started.

**next step: 3**
