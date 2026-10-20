# The Macromedia Flash Professional 8 shell

TVMini's window is laid out and painted after Macromedia Flash Professional
8. This note records what was measured, so that the layout can be kept
faithful and the numbers can be checked again later.

**No Flash code, markup, CSS, icons or other assets are reused.** Flash is
closed-source and its artwork is Macromedia's. What is taken from it is the
*shape* of the window: where the panels sit, how big they are, what colour
they are and how the chrome is drawn. Every pixel of TVMini is drawn from
scratch, the same way `docs/moart-study.md` was done for the other shell
this application was modelled on.

## What was examined

**The program.** Macromedia Flash Professional 8, the Windows build:

| | |
|---|---|
| Path | `H:\flash 8\Flash 8\Flash.exe` |
| Size | 16,879,616 bytes |
| Format | PE32, x86 |
| SHA-256 | `ac443ce0541ad569e753ab7abd22e37d91928e7045fc12be440fe8cd6c6b7a91` |
| Toolchain | MFC 7.1 (`MFC71.dll`, `MFC71u.dll`) |

**The window.** The program was started and its window was measured with
the Win32 window API, so the numbers are the ones the program itself uses
and not an estimate from a picture. The window was maximised on a
1928×1088 desktop.

## The shape of the window

```
┌ menu bar ─────────────────────────────────────────────────────────────┐
├ document tabs ───────────────────────────────────────────────────────┤
├ timeline ────────────────────────────────────────────────────────────┤
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
│                                                                       │
│                         the stage (the pasteboard)                   │
│                                                                       │
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
├ properties ──────────────────────────────────────────────────────────┤
└───────────────────────────────────────────────────────────────────────┘
┌ tools ┐                                     ┌ colour ───────────────┐
│       │                                     │ align & info          │
│       │            the stage                │ library               │
│       │                                     └───────────────────────┘
└───────┘
```

The **timeline is at the top**, above the stage, and the properties are at
the bottom. The timeline is a fixed-height panel and the stage fills what
is left; a drag grip between them changes the split. That is the opposite
of TVMini's first layout, where the timeline sat under the stage.

## The measurements

Taken from the running program, in pixels, with the window maximised on a
1928×1088 desktop.

### The frame

| Part | Size | At |
|---|---|---|
| Window | 1928×1088 | -4, -4 (maximised) |
| Menu bar | 1928×22 | 0, 0 |
| Document tabs | 1632×32 | 73, 43 |
| Timeline | 1632×100 | 72, 105 |
| Drag grip under the timeline | 1632×4 | 73, 206 |
| The stage | 1636×709 | 71, 210 |
| Properties | 1632×163 | 73, 917 |
| Left dock | 73×1037 | 0, 43 |
| Right dock | 223 wide | 1705, 43 |

### The tool bar

A column of 68 pixels on the left, with the buttons in **two columns of
24×24**:

| | |
|---|---|
| The bar | 68×547 |
| A tool button | 24×24, at x = 7 and x = 33 |
| A colour button | 50×29 ("Stroke color", "Fill color") |
| A small colour button | 16×15 |
| A drop-down | 51×24 |

The bar is divided into four parts, each with a heading written across it:
**Tools**, **View**, **Colors**, **Options**.

### The timeline

| | |
|---|---|
| The panel | 1632×100 |
| The frame ruler | a horizontal scrollbar 1220×17 at the top right |
| The vertical scrollbar | 17 wide on the right |
| The frame counter | a small edit box |

### The right dock

Three panels, each with a heading that can be folded away:

| Panel | |
|---|---|
| Color | two tabs, "Color Mixer" and "Color Swatches" |
| Align & Info & Transform | folded away in the picture that was taken |
| Library - Untitled-1 | a drop-down 150×21, a `+` and a `-` button of 20×20 |

## The colours

Read out of a picture of the running program. The shell is the classic
light grey of Windows, not a dark theme.

| Part | Colour |
|---|---|
| Menu bar | `#ffffff` |
| Document tab strip | `#b8b8b8` |
| The tab that is selected | `#64647e` |
| The timeline | `#f8f8f8` over `#f0f0f0` |
| The grid of the timeline | `#a0a0a0` |
| The layer row that is selected | `#6d6d6d` |
| The pasteboard of the stage | `#d0d0d0` |
| The page on the pasteboard | `#ffffff` |
| The tool bar | `#f0f0f0` |
| The right dock, the body | `#ffffff`, the headings `#f0f0f0` |
| The properties panel | `#f0f0f0` |
| A scroll bar | `#f0f0f0` |

## The chrome

The chrome is the classic Windows one: a raised bevel on the outside of a
panel, a sunken bevel around a field, a hairline of shadow at the bottom
and at the right. The parts of the window are separated by the gap between
them rather than by a drawn line, and the gap is a shade darker than the
panels.

The menu bar is a real one: the items are written on a white bar and the
letter that is the shortcut is underlined.

## What was taken from it, and what was not

Taken: the order of the parts of the window, the size of every part, the
colours, the way the chrome is drawn, the way the tool bar is divided into
parts, and the way the rows of the timeline are drawn.

Not taken: any artwork. The 126 icons in the program are Macromedia's, and
the icons in TVMini are drawn from scratch. The menu bar of TVMini keeps
its own menus, because the commands of Flash are not the commands of
TVMini.
