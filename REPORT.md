# TVPaint 12 Pro Demo — why Save, Save As, Export and Recent do not work

Reverse-engineering report produced with REA (Ghidra 12.1.4 provider).

Target: `TVPaint Animation 12 Pro Demo.exe`
SHA-256 `58d3e103ab789aeb81f9ab80a8c78594b72f3612eb58f611cfd193a5c534a3c0`
PE32+ · x86-64 · image base `0x140000000` · 15,050,584 bytes.

How to read this document:

- **CONFIRMED** — I saw it directly in the disassembly, in the bytes on disk, or
  in the shipped data files.
- **INFERRED** — a conclusion that follows from confirmed facts but was not
  observed end-to-end at runtime.
- **UNKNOWN** — not established; the next question is written down.

This report documents *behaviour*. It does not modify the application and does
not describe a licence bypass. The goal was an independent clean-room
re-implementation, described in `SPEC.md`.

---

## 1. Short answer

| Feature | What actually stops it | Status |
|---|---|---|
| **Save Project** | The project object's save slot (`vtable+0x30`) does a path check and then calls the Save-As slot, which is a 3-byte function that returns 0. It never opens or writes a file. | CONFIRMED |
| **Save Project As** | The project object's Save-As slot (`vtable+0x38`) is literally `33 C0 C3` (`xor eax,eax; ret`). | CONFIRMED |
| **Export** | Five demo-guard functions display localization message **1315** — *"Function not implemented in the demo version of TVPaint Animation"* — and return 0 / -1. Every export entry point calls one of them. The `saver` plugin folder also ships empty. | CONFIRMED |
| **Recent** | There is **no demo gate** in the recent-files subsystem. It only displays the shared history list, and that list is filled by successful open/import actions — never by save, because save never runs. | CONFIRMED (no gate) / INFERRED (why it looks dead) |

In other words: there is no single "demo flag" that switches these four
features off. Save/Save As are **replaced at compile time** by a stub, and
Export is **replaced by guards** that show the demo message. Recent is a
**downstream casualty**.

---

## 2. Where the menu commands go

Menu commands are dispatched by `FUN_1405dffa0(command_id)`.

```
FUN_1405dffa0:
  case 3   -> FUN_140689060   ; File > Save Project
  case 4   -> FUN_140688700   ; File > Close Project
  case 5   -> FUN_140689090   ; File > Save Project As
  case 0x15-> FUN_14068fa00   ; save-sequence entry point
```

The command registry is a static array at `0x140d65428`. Each record is
`0x28` bytes:

| offset | field |
|---|---|
| `+0x00` | u32 command id |
| `+0x18` | `char*` internal name |
| `+0x20` | function pointer |

The array has **214 entries** and terminates at `0x140d67598`. Relevant rows:

| id | name | target |
|---|---|---|
| `0x4eb6` | `SaveProject` | `0x140689060` |
| `0x4eb7` | `SaveAsProject` | `0x140689090` |
| `0x4ebb` | `SaveAllProjects` | `0x140689080` |
| `0x4ecd` | `CloseProject` | `0x140688700` |
| `0x4eba` | `SaveClip` | `0x140689560` |
| `0x4fbf` | `ImportProject` | `0x14068c1d0` |

Evidence: `ev_8448f91b9e86bb4be92055b74bc6407d70c897ea1004bf7618a85ad894fb129d`
(registry bytes), and the names were decoded from the string block at
`0x140b13400`.

Note there is **no** `Export` command in this registry. Export is not a normal
command: the UI paths that export converge on the script-level functions in
section 5.

---

## 3. Save Project — a path check wired to a stub

`FUN_140689060` is tiny:

```
plVar1 = FUN_14050e5d0();          // get project singleton (DAT_140da1e20)
(**(code **)(*plVar1 + 0x30))(plVar1);   // call vtable slot +0x30
```

`FUN_14050e5d0` returns the global project pointer `DAT_140da1e20`
(setter: `FUN_14050e5e0`).

### 3.1 Which class owns the vtable

The object's vtable is `0x140b21b60`. I resolved its RTTI on disk:

| item | value |
|---|---|
| vtable | `0x140b21b60` |
| RTTI Complete Object Locator | `0x140c18408` |
| RTTI Type Descriptor | `0x140d7fc10` (offset `0xD7FC10` from image base) |
| type name | `.?AVcStoryboard@@` |

So the singleton is an instance of **`cStoryboard`** (TVPaint's project/storyboard
object). Evidence `ev_761da80ce912b056d07af2d4766983d09b40f064b77255b635192478ed14a193`.

### 3.2 The two vtable slots

Reading 0x48 bytes at `0x140b21b58` gives the vtable:

| slot | address | meaning here |
|---|---|---|
| `+0x30` | `0x1406cd490` | "Save Project" |
| `+0x38` | `0x14006e890` | "Save Project As" |

`0x140b21b60 + 0x30 = 0x140b21b90` → `0x1406cd490`
`0x140b21b60 + 0x38 = 0x140b21b98` → `0x14006e890`

### 3.3 `FUN_1406cd490` does not write anything

Decompiled behaviour (paraphrased):

```
if (project.path is empty)            return 0x6e696d70;
if (extension(project.path) != ".tvpp") return 0x6e696d70;
if (!exists(project.path))            return 0x6e696d70;
return (**(code **)(*project + 0x38))(project);   // -> 0x14006e890
```

Its complete callee set is string/path helpers only:
`0x14079a240, 0x14079a480, 0x14079a7b0, 0x14079b410, 0x14079b590,
0x1407a5f90, 0x1407a6e60, 0x140a956b0`.

No `CreateFile`, no `WriteFile`, no stream open, no serializer. It validates
the name and delegates.

### 3.4 The Save-As slot is a three-byte stub

`address_to_file_offset(0x14006e890)` → file offset **449680** (`0x6DD90`).

Bytes read straight from the file on disk:

```
33 C0 C3 CC CC CC CC CC CC CC CC CC CC CC CC CC
```

`33 C0` = `xor eax,eax`; `C3` = `ret`. That is the whole function.

Evidence: `ev_7f5efc9028e9f4997935c6ea512fa2895cf8cb4d6b3a983af4662355d7844f84`
(offset) and `ev_3f97e6fc6e009a8391e333d7ca25dcfb99f453a472a779439ccd5eee06e887ed`
(bytes).

**Result:** pressing Save Project runs a path check and then calls a function
that immediately returns 0. Pressing Save Project As calls the same three-byte
function directly. Neither can create a file. This is why no error dialog is
needed — the command "succeeds" and does nothing.

---

## 4. Why this is not a runtime switch

If a demo flag disabled saving at runtime, you would expect the save function
to test the flag and branch. It does not: the slot is *statically* replaced by
a stub. There is no code path from `0x14006e890` to a writer.

The demo watcher is a separate object:

- global `DAT_140dabf00`
- getter `FUN_140767c30`, setter `FUN_140767c40`
- only two code references to the global (`xrefs 0x140dabf00` →
  `0x140767c30`, `0x140767c40`), i.e. the accessor pair
- the getter has 12 call sites; **none** of them is in the save chain or the
  recent-files subsystem

Evidence `ev_b65a923cf12748898663ee748456d881f2d774070557977808118571a897dd24`.

**INFERRED:** the four restrictions are compile-time edits in the demo build
(dead save slots + guard functions), not one shared runtime flag. This is
consistent with the trial banner text ("this version does not allow you to save
or export your work").

---

## 5. Export — five guards, one message

TVPaint's export entry points are script-level functions. Their API table
starts at `0x140b07d80`. The relevant entries:

| script name | function | guard it calls |
|---|---|---|
| `tv_savebrush` | `0x1404928b0` | `0x1402a9480` |
| `tv_savebrushanim` | `0x1404929e0` | `0x1402a95d0` |
| `tv_savedisplay` | `0x140492bb0` | `0x1402a9590` |
| `tv_saveimage`, `tv_savelayer` | `0x140492e20` | `0x1402a94a0` |
| `tv_savesequence` | `0x140492f70` | `0x1402a9480` + `0x1402a9600` |
| `tv_clipsavestructure` | `0x14048e030` | `0x1402a9600` |
| `tv_projectsavesequence` | `0x140491d10` | `0x1402a9600` |

Caller coverage for the guards (complete, from Ghidra):

```
0x1402a9480 <- 0x140131d00, 0x1404928b0, 0x140492f70
0x1402a94a0 <- 0x140492e20
0x1402a9590 <- 0x140131d00, 0x140492bb0
0x1402a95d0 <- 0x1404929e0
0x1402a9600 <- 0x14048e030, 0x140491d10, 0x140492f70
```

### 5.1 What a guard looks like

`0x1402a9600`, on disk:

```
0x1402a9600  SUB RSP,0x28
0x1402a9604  MOV ECX,0x523
0x1402a9609  CALL 0x140531c10      ; look up localization string id 0x523
0x1402a960e  MOV RCX,RAX
0x1402a9611  CALL 0x1407a46f0      ; show message
0x1402a9616  XOR AL,AL             ; return false
0x1402a9618  ADD RSP,0x28
0x1402a961c  RET
```

`0x523` = **1315** decimal. In
`Resources\data\english.tvpaint.loc`:

```
$000001315 "Function not implemented in the demo\nversion of TVPaint Animation"
```

The other four guards are the same shape, with different return values:

| guard | return |
|---|---|
| `0x1402a9480` | `0` |
| `0x1402a94a0` | `0` (after building a partial structure) |
| `0x1402a9590` | `-1` |
| `0x1402a95d0` | `0` |
| `0x1402a9600` | `false` |

Evidence: `ev_6086d2335aab98cf0255a599426799f92b0aa700aed5c523943100de370edc46`
(`0x1402a9600`), `ev_8ea1bd1c1f067456cca3eb3fbbd49f7f767f7bf374d7a91186f17e2dd8228a30`
(`0x1402a9480`).

### 5.2 The export codecs are missing as well

`Resources\plugins\saver\` contains a single empty marker file `.nofile`.
`Resources\plugins\loader\` is the same. No saver DLL is shipped.

**CONFIRMED:** even with the guards removed, this installation has no export
codec plugin to write an image sequence or movie. The guard is the first wall;
the missing plugin is the second.

**UNKNOWN:** whether the retail installer places saver DLLs in this folder or
whether TVPaint 12 links its own writers. I did not have a retail build to
compare. Next question: compare the `plugins\saver` folder of a licensed
install.

### 5.3 Where the UI "Export" item lives

I found `"Export..."` (localization id 30823) used in a menu builder at
`FUN_140082780`. That particular menu is the **Bin** context menu (`Browse…`,
`Add…`, `Import…`, `Export…`, `Delete`), not the File menu.

`"Export..."` id 60355 appears in `FUN_14050f150`; `"Export"` id 51013 and
`"Export Footage"` id 3100 appear elsewhere in the UI.

**INFERRED:** the File → Export dialog, the Bin export and the right-click
export all end up in the same script-level export functions, because those are
the only code that consumes the guards and they are the only export backends
found.

**UNKNOWN:** the exact File-menu command id for Export. It is not in the 214-entry
command registry, which suggests the File menu item opens a dialog directly
rather than dispatching a command. Next question: capture the File menu with a
runtime UI tool and read the command id on click.

---

## 6. Recent — no gate, but nothing to show

### 6.1 The data structure

Recent projects are a single global vector:

| symbol | role |
|---|---|
| `DAT_140daab70` | begin pointer |
| `DAT_140daab78` | end pointer |
| `FUN_14074f530(i)` | get entry *i* |
| `FUN_14074fb20(path)` | add path if not already present, then trim to 50 |
| `FUN_14074efc0` | persist/load entries as `Project_%02d` under config keys `FileHistoImport` and `FileHisto` |

`FUN_14074fb20` has exactly **four** callers (complete Ghidra coverage):

```
0x140282800, 0x1402b1040, 0x1402bc4f0, 0x1406d0a80
```

`0x1402b1040` is the open-project path — it is also called from the command
dispatcher (`FUN_1405dffa0`, the `>= 3000` branch) when a recent entry is
chosen. `0x1402bc4f0` is called from `0x1402b1040`, i.e. also on open.

Evidence `ev_21bd61ec8c1105e883f829adf3e918405369943fef63a6f242dec588db50abcc`.

### 6.2 Selecting a recent entry is not blocked

`FUN_14063d900` takes a recent index, resolves the path, validates it with
`0x1402a9a70`, and calls `0x14053ee60` (the normal open routine). `0x1402a9a70`
shows the ordinary file errors on failure:

- empty/invalid path → localization `0x93f` (2367) *"Path not found!"*
- unrecognised content → localization `0x933` (2355) *"Unrecognized file format"*

No demo message, no guard call. It is called from `FUN_14063a440` case `0x6a`.

The recent menu itself is built with label id `0x59f3` (23027) — `"Browse..."`.

### 6.3 The negative evidence

I checked the recent subsystem for the demo gate:

- callee sets of `FUN_1405d9950` (builds the "Recent projects / Recent folders /
  Recent files" places, ids 0x99057f–0x990581) and `FUN_14063d900`
  (open recent entry) contain **none** of the five guard functions;
- neither function references the demo watcher getter `FUN_140767c30` or the
  global `DAT_140dabf00`;
- the save chain (section 3) terminates in the three-byte stub and never calls
  `FUN_14074fb20`.

**CONFIRMED:** Recent is not separately disabled.

**INFERRED (why it looks disabled):** the list only ever contains paths that
were opened/imported successfully, or saved. Because saving is a no-op, a user
who works and saves all session never gets a new "recent project" entry. And
any entry whose file has since moved is rejected with *"Path not found!"* /
*"Unrecognized file format"*, so the menu can look empty or broken.

**UNKNOWN:** which exact "Recent" UI the user meant (File → Recent submenu, the
places list in the Open dialog, or the "reuse a recent export folder" button in
the Export dialog, id 1031092). Next question: a screenshot of that menu with
one entry visible or greyed out.

---

## 7. The demo message source

`Resources\data\english.tvpaint.loc`:

```
$000001315      "Function not implemented in the demo\nversion of TVPaint Animation"
$012001316      "Welcome to the Trial Version of TVPaint 12 ! ... this version
                 does not allow you to save or export your work. ..."
```

`$012001316` is referenced by `FUN_140543610`, `FUN_1409e4940`, `FUN_140a05b20`
and `FUN_140a17b00` — the startup/trial banner, not the save path.

---

## 8. Evidence index

| id | what it proves |
|---|---|
| `ev_4ca6db34…f325206` | target identity: PE32+, x86-64, SHA-256, resources |
| `ev_81398564…adea` | Ghidra import: 28,052 procedures, 17,374 strings |
| `ev_8448f91b…b129d` | command registry bytes at `0x140d65428` |
| `ev_761da80c…14a193` | vtable `0x140b21b60` → `cStoryboard`, slots `+0x30`/`+0x38` |
| `ev_7f5efc90…844f84` | `0x14006e890` → file offset 449680 |
| `ev_3f97e6fc…e887ed` | on-disk bytes `33 C0 C3 …` |
| `ev_6086d233…70edc46` | guard `0x1402a9600` disassembly (msg `0x523`) |
| `ev_8ea1bd1c…228a30` | guard `0x1402a9480` disassembly |
| `ev_b65a923c…97dd24` | demo flag `DAT_140dabf00` has only accessor references |
| `ev_21bd61ec…50abcc` | recent-list add function has four callers |
| `ev_a57a99eb…080b36f3` | Save command callers |

---

## 9. Limits of this analysis

1. No runtime observation. Everything above is static. I did not launch the
   application, click menus, or attach a debugger.
2. The Ghidra decompiler became intermittent late in the session; the final
   claims are backed by **disassembly** and **file bytes**, which are stronger
   evidence than pseudocode.
3. The File-menu Export command id is still unknown (section 5.3).
4. The retail `plugins\saver` folder contents are unknown.
5. The exact "Recent" UI the user means is unknown (section 6.3).

---

## 10. What this means for the clean-room build

The four behaviours are small and well understood:

1. **Save / Save As** — serialize the project model to a file, atomically.
2. **Export** — render the current frame (and optionally a range) to an image
   format, with a real result code and a visible error on failure.
3. **Recent** — a bounded, de-duplicated, persisted MRU list that is updated
   only on *successful* open/save/export, and that silently drops entries whose
   files no longer exist.

`SPEC.md` turns that into testable requirements, and `build/my-version`
contains an independent implementation with tests.
