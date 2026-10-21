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

**next step: 3 (waiting for the headless analysis), then 4**
