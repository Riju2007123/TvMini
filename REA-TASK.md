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
- **Step 3 — ROUTE:** next. Target is a native Windows `.exe` (likely C++), so the
  planned route is the REA native/Ghidra path, not Electron. Ghidra 12.1.x must be
  installed and `GHIDRA_INSTALL_DIR` set before tracing.
- **Step 4 — TRACE:** not started.
- **Step 5 — REPORT:** not started.
- **Step 6 — BUILD:** not started.
- **Step 7 — REPO:** not started.

**next step: 3**
