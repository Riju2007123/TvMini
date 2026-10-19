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

## 7. Timeline and animation layers

This section answers a second question: what does TVPaint 12 expose about its
timeline and animation-layer model? The evidence is static: PDB labels, one
project/template loader, the script-command table, layer accessors and class
names. It is **not** a full reverse engineering of the timeline UI.

### 7.1 Project-level timeline keys (CONFIRMED)

The binary carries named configuration keys for the timeline:

| label | address | evidence |
|---|---|---|
| `u_framerate` | `0x140ae24d8` | `ev_b66122d409002471f9701f79024429eb38eed7d457e33c93130c001c241ba9db` |
| `u_startframe` | `0x140ae2508` | `ev_55d28a80f0f3c00e5e959af20a5ab2b23d92ee0e047857f3d72d8b8bf36c2006` |
| `u_currentlayer` | `0x140ae2578` | `ev_3e44a8f457ee08476245cacfb47eb02eeb1e9ece9bb80c9d88ccb7106ffa8719` |
| `u_layercount` | `0x140ae2598` | `ev_0a0087d42c5e9f06d39ef28fca7afb78784e941cb6009caa3b31945bc6026054` |
| `u_layer%d` | `0x140ae25b0` | `ev_07d8c513bd88c5d51627b409e1a4cd9c0ad27e78d1358af5edabbe6cec7c1bce` |
| `u_anim` | `0x140ae3630` | `ev_72e2ca5f8b18cd9771918a1ffb5edd284f813f762f6a8aa9c6dd8ab796633a1e` |
| `u_loop` | `0x140ae4f18` | `ev_7528963f67735d29b298b8c209e9525a3fb744d2ec3b846509a61f1ad79a3cc2` |

The loader at `FUN_14060fca0` reads these wide-string keys from the project
configuration:

```c
FUN_1407a7e90(0, L"startframe", ...);
FUN_1407a7e90(0, L"bgcolor1", ...);
FUN_1407a7e90(0, L"bgcolor2", ...);
FUN_1407a7e90(0, L"bgmode", ...);
FUN_1407a7e90(0, L"modetimecode", ...);
FUN_1407a7e90(0, L"currentlayer", ...);
FUN_1407a7e90(0, L"layercount", ...);
FUN_1407a5da0(local_90, L"layer%d", i);
FUN_1407a7e90(0, L"flags", ...);
FUN_1407a7e90(0, L"name", ...);
FUN_1407a7e90(0, L"type", ...);
FUN_1407a7e90(0, L"postbehavior", ...);
FUN_1407a7e90(0, L"prebehavior", ...);
FUN_1407a7e90(0, L"small", ...);
FUN_1407a7e90(0, L"density", ...);
FUN_1407a7e90(0, L"allicons", ...);
FUN_1407a7e90(0, L"firstimage", ...);
FUN_1407a7e90(0, L"lastimage", ...);
FUN_1407a7e90(0, L"uicolor", ...);
```

**CONFIRMED:** a project stores a frame rate, a start frame, a current layer,
a layer count, numbered layer records, and per layer a name/type/flags,
before/after behaviour, first/last image and UI colour. Layer records are
indexed with `layer%d`, and the loader loops over `layercount`.

Evidence:
`ev_c32d4dd074dbbc9725630e21b5cf7d4d8dd535c22869472c17de1bf7e5e040dc`.

**INFERRED:** `u_loop` is the playback-loop setting and `u_anim` is an
animation-mode flag; the labels are confirmed, their full semantics are not.
The exact value types (integer, string, blob) and the default behaviour values
are not established from this loader alone.

**UNKNOWN:** whether these keys describe `.tvpp` projects, templates, or both.
Next question: open a real `.tvpp`, change one timeline field at a time, and
diff the configuration keys.

### 7.2 Exposure commands (CONFIRMED)

The script-command table exposes these timeline name/handler pairs:

| script name | handler | evidence |
|---|---|---|
| `tv_exposureinfo` | `0x1404a1590` | `ev_864232dee7af15566e5475ec20469ecfebb341844f0f36d6cde1df62f5038cd6` |
| `tv_exposureadd` | `0x1404a1300` | `ev_cb47a9053ffe515a7113db03355deac562861be682f50ad02fd99ffcd7ece928` |
| `tv_layerhold` | `0x1404a0c30` | `ev_ab7dd51b865f45d35bcff41243a0c6ab5c7fc32cbc4c92bdfcfe560e574d20f1` |
| `tv_framerate` | `0x1404ab320` | `ev_abddba1541016609c4e6ac8b27e9619a55b384dbdc52ff8beb07a401e7c99f66` |
| `tv_layercreate` | `0x1404a5bc0` | `ev_0d218a41e26331a4722694afb5db33cc80163bcc7ba2ee21e4ab4094e7e32d3e` |

The table also contains the script name `tv_layeranim`
(`ev_03608e5e044e16a9213f6aa3c7de5a29755106446f68cb30981f257c5bcd7a4d`);
its handler body was not recovered, so no behaviour is claimed for it.

`tv_exposureinfo` (`0x1404a1590`) resolves the current layer and frame and
returns one of three strings:

- `"None"` — when the frame is before the first image, after the last image,
  or the layer type is `6`;
- `"Exposure %d %d"` — when the frame's exposure lookup succeeds; it calls the
  exposure-count accessor `FUN_1408661d0`;
- `"Head"` — when the frame is inside the first/last range but that lookup does
  not take the exposure branch. **INFERRED:** this is the head of a drawing.

Evidence:
`ev_038f20904eb36ba4c9492c29c15816089b88d87ddd8993348ec2b144e7402c72`.

`tv_exposureadd` (`0x1404a1300`) checks `layer_type != 6`, reads the count from
`DAT_140da1054` (minimum 1), and calls `FUN_1400e34d0(layer, current_frame,
count)`. That helper:

1. checks a layer flag (`(*(uint *)(layer + 0x40) >> 4 & 1) == 0`);
2. checks that the frame is between the first and last image;
3. calls `FUN_140861d00(layer, frame, count)` and
   `FUN_14073b130(layer, frame, count)`;
4. refreshes the UI.

`FUN_140861d00` switches on the layer type and calls a type-specific add
function for types `1`, `2`, `4`, `5` and `8`.

Evidence:
`ev_c7113713ea73bf0688de24b519de8e4f17f2fc98e74ef20c29aa417950f807b7`
(command), `ev_6b569e3b42491b292d36eb703d7046bb4054d5358fc07391a8e31dff56378369`
(helper), `ev_d3c0f35b8b2e4477c8aa7aedd3242bb9a0d25d517ebef2800c22dd7f1ffb2340`
(type dispatch).

`tv_layerhold` (`0x1404a0c30`) first checks that the current layer type is not
`6`, then routes to `FUN_1402a8030`, which creates a dialog titled
`"Hold&Fetch"` and passes the current layer/frame values into its constructor.
**CONFIRMED:** Hold is a UI command and type-6 layers are excluded.
**UNKNOWN:** the dialog's exact effect on an existing exposure (insert, extend,
split, or replace). Evidence:
`ev_3c5bdbda9386b4985d88ebd502445cc410e5c63bde222d858f0e796bef33b2db`
(handler), `ev_6332cda3fa9f1b7c2974142ddfdecb0acd5ae14a4526d823c4a83eccc2cda0ab`
(dialog).

`tv_layercreate` (`0x1404a5bc0`) accepts the type strings `"anim"` and
`"folder"` and builds a create request from them. **CONFIRMED:** `anim` is the
ordinary animation-layer type used by the create command. **UNKNOWN:** the
exact object-construction path after the request. Evidence:
`ev_dd5de44e11039ef52a6db683cb893e5996433b802f1f643a711653ecadf74198`.

`tv_framerate` (`0x1404ab320`) parses a numeric argument and accepts the
`timestretch`, `preview` and `info` options. **CONFIRMED:** there is a runtime
frame-rate command with timestretch/preview handling. **UNKNOWN:** the exact
project field it updates and its UI semantics.
Evidence:
`ev_5b9d2f3a733fce5860e553804107c75f2eae2f374a992963bbf0c4a2f5500846`.

### 7.3 Layer storage and types (CONFIRMED)

The accessors show a polymorphic layer object:

- the layer type is the 32-bit value at `layer + 0x4c`;
- type-specific object pointers are at `+0x50`, `+0x58`, `+0x60`, `+0x68`,
  `+0x70`, `+0x78`, `+0x80`;
- first-image accessor `FUN_1408654d0` switches on types `1, 2, 4, 5, 6, 7, 8`
  and reads `+0x10` or `+8` from the selected object;
- last-image accessor `FUN_1408666c0` switches on the same types and reads
  `+0x14` or `+0xc`;
- exposure-count accessor `FUN_1408661d0` and exposed-frame lookup
  `FUN_1408663b0` use the same type dispatch.

Evidence:
`ev_39fa729b4156f21d18fd6982f221140425df7a298f7f4653359eafea4ebb87b3`
(first image), `ev_637251335b06d2bdf451a1d892e839db22b72acd8e82209bd3d99ddf247d2513`
(last image), `ev_3bba94657916fff742cb9bb10fc44d0c25504b03de28a12429bb477a169e29fb`
(exposure count).

**CONFIRMED:** there are at least seven layer variants, and not every layer is
animated. `tv_exposureinfo` explicitly returns `"None"` for type `6`, and
`tv_exposureadd` explicitly skips type `6`. **INFERRED:** type `6` is a
non-animated image/background-like layer.

**UNKNOWN:** the human names and full semantics of types `1, 2, 4, 5, 7, 8`,
why type `3` is absent, and which variant is the ordinary animation layer.
Next question: create one layer of each type in the retail UI and compare the
`type` key with the timeline row's icon/menu.

### 7.4 Before/after behaviour names (CONFIRMED)

Six UI icon resources name the possible behaviours:

| resource label | address | evidence |
|---|---|---|
| `u_LayerLoopNone.png` | `0x140b28358` | `ev_81403e153d47bb6726d215cc68f9d9eea544e81c6356126f5d0f30d8abd0753f` |
| `u_LayerLoopRepeatAfter.png` | `0x140b28380` | `ev_ba7d15d683cae539b88cccca81cb1c7f0570f648cfd7c2ec56f424eea936fa02` |
| `u_LayerLoopPingPong.png` | `0x140b283b8` | `ev_7691bcc1785102ecda1f0f4abe27da06136bd63ba7805df8d397bb19c6d902f2` |
| `u_LayerLoopHoldAfter.png` | `0x140b283e8` | `ev_ed30670aaf1574f026c99eb726e7d805fdf98d6df9f8222ffc5567694bb27028` |
| `u_LayerLoopRepeatBefore.png` | `0x140b28418` | `ev_fc3c93a74736bbead563321618787b23d81998ec4c1b93d3e3e9fed086e25468` |
| `u_LayerLoopHoldBefore.png` | `0x140b28450` | `ev_553bb49329268fdad736d1fa210952e030d234bf96c7360d527ac184dd62fb8f` |

The script names `tv_layerprebehavior`, `tv_layerpostbehavior`,
`tv_firstimage` and `tv_lastimage` also exist:

- `ev_fa93e118d5ca06d8a739dcd9d5758b568a468a2e8ebf21de49dce80c3ee13e86`
- `ev_5db07af081a84231594f04b78d8dfccb8c20fd8513304b7b6a1b4d08c040b813`
- `ev_1786525deb034f8744b69ce1567dc549aa3dee963bb83b066ecf74a52983c02c`
- `ev_b215bda83ab12fd6a12e0ecde1575fcd2a4ad416e828485814a70c5d6ba63ce6`

**CONFIRMED:** a layer has separate before and after behaviours, and the
available concepts are `none`, repeat, ping-pong and hold. **INFERRED:** the
Repeat/Hold icons map to the pre/post fields; `None` and `PingPong` appear as
single icons. The exact enum encoding is not proven. **UNKNOWN:** the numeric
values and the defaults for a new or imported layer.

### 7.5 Timeline classes (CONFIRMED existence; INFERRED role)

The public PDB symbols include:

- `cTimelineLayer`, `cTimelineLayerOptions`, `cTimelineLayerTimeline`;
- `cTimelineLayers`, `cTimelineStrip`, `cTimelineNotes`;
- `cTimelineAudio`, `cTimelineAudioTrack`, `cTimelineAudioClip`;
- `cCmdActivateDrawingFrame`, `cLayerProfileHandler`,
  `cMenuLayerEventListener`.

Two vtables are named:
`cTimelineLayer::vftable` at `0x140b27c00`
(`ev_5971ad74bf7d03977b93f73021c2e386f5af5f70e5cda54e43690afbf4bb4c15`) and
`cTimelineLayers::vftable` at `0x140b284c0`
(`ev_d58ad0ca5655a1e9d8186dc1b52e10eeaf5681b730bb6642b7891a7784cb9389`).
Cross-references to the latter were also captured:
`ev_916103a4993a8192b988f30a52ecfaaa15d06d354fabe5110b0ad4dca9b9e340`.

The same name export resolves vftables for `cTimelineStrip`
(`ev_0034407de0f02158d056bd9b9c621b48a7679e257e103d5489d5a07acab1994f`),
`cTimelineNotes`
(`ev_ce6a744419df13636dec05476c2faea118399eee55f9c4b27548779e4ce83a69`),
`cTimelineAudio`
(`ev_767b091ccdb01ab932abab1790b35ba3e90b83a30c4b56bce36f7a3bd4063669`),
`cCmdActivateDrawingFrame`
(`ev_bc9e54081e6c127ffee6cfd064beedc88daa582ca2104da285b4603a5bdfc78d`),
`cLayerProfileHandler`
(`ev_a53bfd4f0043ac601ab947c616db6be4fcb17e2cd7d3a79c93759bdd12e29c5d`)
and `cMenuLayerEventListener`
(`ev_8b11ea0906e9534504f46b1839fc0896c448d414231b5f4a9de2ff66a88438ce`).

**CONFIRMED:** these classes exist and the layer container has a vtable.
**INFERRED:** they implement the timeline's rows, strips, notes and audio
lanes, and `cCmdActivateDrawingFrame` is the command that changes the active
drawing/frame. **UNKNOWN:** their field layout, method roles and the exact UI
path from a click to an exposure edit. Most methods are still `FUN_*`; a class
name alone is not enough to reconstruct behaviour.

### 7.6 What this means

The evidence supports this model, which TVMini implements independently:

1. A project has a frame rate, start frame, current layer, current frame,
   layer count and loop setting.
2. A layer has a name, type, flags, first/last exposed frame, a before
   behaviour and an after behaviour.
3. A frame is either the head of a drawing, a held frame, or outside the
   layer's exposed range; the before/after behaviour decides what is shown
   outside that range.
4. Layers can have different types, and at least one type is not animated;
   TVMini deliberately implements only its own ordinary animation layer.
5. The timeline UI is a separate subsystem (`cTimeline*`) layered on top of
   these exposure primitives.

TVMini does **not** copy TVPaint's field layout or defaults. It uses absolute
frame numbers, a JSON schema, drawings with a hold length, and the four
behaviours `none`, `hold`, `repeat`, `pingpong`. New layers default to
`preBehavior: "none"` / `postBehavior: "hold"`; that is a clean-room choice
because the retail defaults were not established.

The resulting requirements and tests are in `SPEC.md` sections 2 and 5.

---

## 8. The demo message source

`Resources\data\english.tvpaint.loc`:

```
$000001315      "Function not implemented in the demo\nversion of TVPaint Animation"
$012001316      "Welcome to the Trial Version of TVPaint 12 ! ... this version
                 does not allow you to save or export your work. ..."
```

`$012001316` is referenced by `FUN_140543610`, `FUN_1409e4940`, `FUN_140a05b20`
and `FUN_140a17b00` — the startup/trial banner, not the save path.

---

## 9. Evidence index

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
| `ev_c32d4dd0…e040dc` | project loader reads timeline and per-layer keys |
| `ev_b66122d4…1ba9db` | `u_framerate` key label |
| `ev_55d28a80…6c2006` | `u_startframe` key label |
| `ev_0a0087d4…c6026054` | `u_layercount` key label |
| `ev_07d8c513…c7c1bce` | `u_layer%d` key label |
| `ev_038f2090…402c72` | `tv_exposureinfo` output and type-6 handling |
| `ev_c7113713…f807b7` | `tv_exposureadd` command |
| `ev_6b569e3b…78369` | exposure-add helper checks flags and first/last image |
| `ev_3c5bdbda…b33b2db` | `tv_layerhold` skips type-6 layers and opens the dialog |
| `ev_6332cda3…cda0ab` | `tv_layerhold` opens the `Hold&Fetch` dialog |
| `ev_dd5de44e…f74198` | `tv_layercreate` accepts `anim` / `folder` type strings |
| `ev_39fa729b…87b3` | first-image accessor switches on layer type |
| `ev_63725133…247d2513` | last-image accessor switches on layer type |
| `ev_81403e15…bd0753f` | six before/after behaviour icon names |
| `ev_5971ad74…bb4c15` | `cTimelineLayer::vftable` |
| `ev_d58ad0ca…cb9389` | `cTimelineLayers::vftable` |
| `ev_0034407d…cab1994f` | `cTimelineStrip::vftable`; other `cTimeline*` vftables also resolved |

---

## 10. Limits of this analysis

1. No runtime observation. Everything above is static. I did not launch the
   application, click menus, or attach a debugger.
2. The Ghidra decompiler became intermittent late in the session; the final
   claims are backed by **disassembly** and **file bytes**, which are stronger
   evidence than pseudocode.
3. The File-menu Export command id is still unknown (section 5.3).
4. The retail `plugins\saver` folder contents are unknown.
5. The exact "Recent" UI the user means is unknown (section 6.3).
6. Section 7 is structural and behavioural evidence, not a full timeline UI
   reverse engineering. Most `cTimeline*` methods are still `FUN_*`.
7. The human names and complete semantics of layer types `1, 2, 4, 5, 6, 7, 8`
   are unknown; type `6` is only known to be treated as non-animated.
8. The numeric encoding and default values of the before/after behaviours are
   unknown, and the exact reflow rule behind the `Hold&Fetch` dialog was not
   recovered.
9. No runtime timeline operation was observed; the timeline commands are
   evidenced statically.

---

## 11. What this means for the clean-room build

The demo-blocked behaviours and the timeline primitives are small and well
understood:

1. **Save / Save As** — serialize the project model to a file, atomically.
2. **Export** — render the current frame to a PNG, with a real result code and
   a visible error on failure.
3. **Recent** — a bounded, de-duplicated, persisted MRU list that is updated
   only on *successful* open/save, and that silently drops entries whose files
   no longer exist.
4. **Timeline / animation layers** — store drawings at absolute frames with a
   hold length, resolve before/after behaviour outside a layer's exposed range,
   composite visible layers for the current frame, and play at the project
   frame rate.

TVMini implements these independently. `SPEC.md` turns them into testable
requirements, and `build/my-version` contains the implementation and tests.

---

## 12. Clip Studio `.clip` export validation

This section is **not** evidence about TVPaint. It records the separate work
needed for TVMini's "Export layered `.clip`" feature.

### 12.1 Format basis

- **CONFIRMED (file bytes)** — a CSP document is a `CSFCHUNK` container. The
  8-byte tag is followed by a big-endian total file size and the offset of
  `CHNKHead`; `CHNKHead` points at the binary section; `CHNKExta` chunks hold
  external data; `CHNKSQLi` holds a complete SQLite database; `CHNKFoot` ends
  the file.
- **CONFIRMED (file bytes)** — image data is stored outside SQLite. Each
  `Offscreen.BlockData` is a 40-byte external ID, and `ExternalChunk` maps that
  ID to the `CHNKExta` payload. Block tables inside `Offscreen.Attribute` give
  the size of each zlib-compressed block record.
- **CONFIRMED (public clean-room format notes)** — the block record layout,
  BGRA row order, the folded 64×64 alpha plane, zlib compression, and the
  “zero `BlockCheckSum` means no checksum” behaviour are documented by the
  `clipparse` / `clip-tools` clean-room projects. TVMini's writer is an
  independent JavaScript implementation of those notes.
- **CONFIRMED (file bytes)** — the blank `emptyimage.clip` sample used as a
  structural template is a normal CSP document (1600×1200, 5 mip levels, paper
  plus one raster layer). TVMini replaces its canvas, layer rows, names, mip
  chains and pixels; no sample artwork is retained.

### 12.2 What the writer produces

- Rebuilt `CSFCHUNK` header and `CHNKHead` binary-section size.
- Canvas dimensions and mip chains for every layer.
- Paper layer with the TVMini background colour as its initial fill.
- One raster layer per TVMini animation layer, in CSP's bottom-to-top order.
- Layer name, visibility, lock, opacity and UUID.
- A 100 % offscreen buffer per layer, encoded as zlib block records.
- Optional imported `.clip` preview as a separate layer under the animation
  layers.
- `CanvasPreview` PNG for CSP's canvas/layer previews.
- One `CHNKExta` chunk per raster layer, with matching `ExternalChunk` offsets.

### 12.3 Runtime result

- **CONFIRMED** — a generated 640×480 file with two raster layers (blue at
  50 % opacity, red at 100 %) was opened in **Clip Studio Paint EX v3.0.0**.
  The title bar showed `tvmini-test (640 × 480 px, 72dpi, 100%)`; the layer
  panel listed `Blue`, `Layer 1` and `Paper`; the red stroke was partially
  covered by the blue stroke, matching the requested order and opacity. CSP
  showed no “layer image is corrupted” warning.
- **CONFIRMED by inspection of the written database** — the file had the
  requested canvas size, one external chunk per raster layer, offsets that
  match the container layout, and a `CanvasPreview` of the correct size.
- **UNKNOWN / not implemented** — CSP animation tracks. TVMini exports the
  current frame as a layered still image. The CSP `TimeLine`/`Track` binary
  encoding for animation folders and cels was not reconstructed, so the writer
  does not claim animated-CSP compatibility.
- **NOT CLAIMED** — vector, text, mask, group, filter or non-normal blend
  compatibility.

### 12.4 Why this is still clean-room

The writer contains no TVPaint code and no CSP code. It uses public file-format
observations and a blank CSP document as a structural template. The project
model, rendering order, exposure rules and export behaviour remain TVMini's own
design; see `SPEC.md` FR-17.
