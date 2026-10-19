# SPEC — "TVMini" clean-room save / export / recent

An independent, small application that implements the four behaviours the
demo build blocks, without using any TVPaint code, format or resource.

Nothing here is derived from TVPaint source. Only the *observable behaviour*
described in `REPORT.md` was used as a requirement.

---

## 1. Product statement

TVMini is a local drawing app. You can draw strokes on a canvas, keep the work
in a project file, reopen it later, export the current canvas as a PNG, and
pick recently used projects from a menu.

Deliberately **not** in scope:

- reading or writing TVPaint `.tvpp` / `.tvps` files
- matching TVPaint's UI, tool set or layer model
- any interaction with TVPaint's licence or demo checks

---

## 2. Functional requirements

### FR-1 New project
- Create an empty canvas with a chosen width/height (default 960 × 600).
- The project starts with no path and is marked *unsaved*.

### FR-2 Save
- If the project has a path, write it there.
- If it has no path, behave like Save As.
- On success: mark *saved*, add the path to Recent, show the byte count.
- On failure: keep the *unsaved* state, return a non-zero result, show the
  reason. **A failed save must never leave a truncated project file** (FR-6).

### FR-3 Save As
- Always ask for a path (or accept one from the API).
- Append `.tvmini` when the path has no extension.
- Refuse to overwrite silently only if the target exists and is not a valid
  TVMini project — the UI must ask for confirmation first.
- On success: the project's path becomes the new path; add to Recent.

### FR-4 Open
- Read and validate a `.tvmini` JSON file.
- On success: load it, clear *unsaved*, add to Recent.
- On failure: leave the current project untouched, show the reason.

### FR-5 Export
- Render the current canvas to a PNG at a chosen path.
- Support the full canvas only (v1).
- On success: show the pixel size and byte count. Export does **not** change
  the project's path and does **not** add to Recent (Recent is for projects).
- On failure: no partial file left behind.

### FR-6 Recent
- A single MRU list of project paths, newest first.
- Maximum 50 entries.
- Adding an existing path moves it to the front (case-insensitive on Windows).
- Entries whose file no longer exists are dropped when the list is read.
- Persisted across runs.
- The menu shows a disabled "No recent projects" item when empty.

### FR-7 Unsaved-changes guard
- New / Open / Quit must ask before discarding unsaved strokes.

### FR-8 Pen pressure
- When the pointer is a pen (`pointerType === "pen"`) and "Pen pressure" is on,
  record `pressure` (0…1) with every point.
- Stroke width is `width × (0.2 + 0.8 × pressure)`: 20 % of the slider value at
  zero pressure, full width at 1.0.
- The on-screen canvas and the PNG export must taper identically.
- A mouse or touch pointer records plain `[x, y]` points and keeps a constant
  width.
- Turning the checkbox off forces constant width for new strokes; existing
  strokes keep their recorded pressure.
- Files written before this feature (2-element points) stay valid.

### FR-9 Undo / redo
- One history step per completed stroke and per "Clear canvas".
- At least 100 steps; older steps are dropped.
- Undo/redo buttons are disabled when there is nothing to do.
- `Ctrl+Z` undoes; `Ctrl+Y` and `Ctrl+Shift+Z` redo.
- Making a new change after an undo discards the redo branch.
- New and Open reset the history.
- Undo/redo never changes the project path; they mark the document unsaved.

---

## 3. Data format

Project file: UTF-8 JSON, extension `.tvmini`.

```json
{
  "format": "tvmini",
  "version": 1,
  "width": 960,
  "height": 600,
  "background": "#ffffff",
  "strokes": [
    { "color": "#1f2937", "width": 6, "points": [[10, 10], [42, 80]] },
    { "color": "#b91c1c", "width": 12, "points": [[100, 20, 0.15], [140, 90, 0.85]] }
  ]
}
```

A point is `[x, y]` or `[x, y, pressure]`. The third value is optional and,
when present, must be between 0 and 1. `width` is the diameter at full
pressure.

Validation rules:

| field | rule |
|---|---|
| `format` | exactly `"tvmini"` |
| `version` | integer `1` |
| `width`, `height` | integer 16…4096 |
| `background`, `color` | `#rrggbb` |
| `width` (stroke) | number 1…200 |
| `points` | array of `[x, y]` or `[x, y, p]`; `p` is 0…1 |
| `strokes` | array, max 10000 |

Unknown fields are ignored so the format can grow.

### 3.1 Atomic write
1. write to `<target>.tmp-<pid>-<rand>`
2. `fsync`
3. `rename` over the target

If any step fails, unlink the temp file and return the error.

---

## 4. Interface

### 4.1 Local HTTP app
- `node server.js` starts on `127.0.0.1:4123` (configurable `--port`).
- Loopback only.
- Static UI in `public/`.
- JSON API under `/api`.

| method | path | body | result |
|---|---|---|---|
| `GET` | `/api/state` | — | `{ recent, cwd, platform }` |
| `GET` | `/api/list?dir=` | — | `{ dir, parent, entries[] }` |
| `POST` | `/api/open` | `{ path }` | `{ project, path }` |
| `POST` | `/api/save` | `{ path, project }` | `{ path, bytes, recent }` |
| `POST` | `/api/export` | `{ path, project }` | `{ path, bytes, width, height }` |
| `GET` | `/api/recent` | — | `{ entries[] }` |
| `POST` | `/api/recent/remove` | `{ path }` | `{ entries[] }` |

Errors: HTTP 4xx/5xx with `{ "error": "human readable" }`. The UI shows this
text; it never fails silently.

### 4.2 UI
- File menu: New, Open…, Save, Save As…, Export PNG…, Recent ▸, Exit.
- Canvas: drag to draw; stroke colour and width controls.
- Status bar: last result or error.
- Title bar: `name — TVMini` with `*` while unsaved.

---

## 5. Acceptance tests

Every item below is automated in `build/my-version/test/`.

| # | Test | Pass condition |
|---|---|---|
| T1 | save → open round-trip | identical strokes, size, background |
| T2 | save to unwritable dir | error returned, target absent, temp absent |
| T3 | save over existing file | replaced atomically, no `.tmp-*` left |
| T4 | save without extension | `.tvmini` appended |
| T5 | open invalid JSON | error, previous project object untouched |
| T6 | open wrong `format` | error |
| T7 | recent add | newest first |
| T8 | recent duplicate (different case) | one entry, moved to front |
| T9 | recent cap | 50 max |
| T10 | recent prune | missing files removed |
| T11 | recent persistence | reload from disk keeps order |
| T12 | export PNG | valid signature, IHDR size, decodable IDAT |
| T13 | export failure | no file left |
| T14 | HTTP save/open/export | 200 + correct payload |
| T15 | HTTP bad path | 4xx + `error` string |
| T16 | HTTP path traversal in `/api/list` | rejected |
| T17 | pressure 0.05 with width 20 | core painted, 5 px away stays background |
| T18 | pressured project save → open | pressure values preserved |
| T19 | history undo/redo | states restored in order |
| T20 | new change after undo | redo branch discarded |
| T21 | history limit | oldest state dropped |
| T22 | reset | both directions cleared |

---

## 6. Non-goals / limits

- Browser UI is served locally; it is not a hosted service.
- One canvas, one layer, no animation timeline.
- Export is PNG only.
- No cloud sync, no telemetry, no network access beyond loopback.
