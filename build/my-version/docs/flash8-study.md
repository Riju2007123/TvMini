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

## The pencil and the brush

The program was started again and the two tools that draw were looked at,
the same way as the window: the tool was chosen with its key (**Y** is the
pencil, **B** is the brush, **P** is the bezier pen) and the picture of the
window was taken afterwards. The measurements are the ones the program
shows in its own properties panel.

### The pencil

| Part of the panel | |
|---|---|
| The stroke | a colour and a size, 1 by default |
| The shape | Solid, or Custom |
| **Stroke hinting** | a checkbox, off by default |
| **Scales** | Normal (Horizontal, Vertical and None are there as well) |
| **Miter** | 3 |
| **Join** | a curve |
| **Smoothing** | 0, greyed out until the shape is Custom |

### The brush

| Part of the panel | |
|---|---|
| The shape | a picture, chosen in the options part of the tool bar |
| The colour | chosen in the options part of the tool bar |
| **Smoothing** | **20** |

### What the two settings mean

**Smoothing** is the setting that takes the tremble out of a line. The
line that is left behind is not the line the hand made: the trembling of
the hand is gone, but the shape of the line is the shape the hand made.
The pencil leaves it at 0 and the brush at 20, so the brush draws the
calmer line of the two.

**Stroke hinting** and **Scales** are about the stroke of a shape, not
about the hand: with hinting on, the outline of a stroke keeps its shape
when it is made bigger, and the stroke is scaled with the shape.

### What the smoothing does, measured

The same line was drawn in Flash 8 with the brush, once with the
smoothing at 0 and once with it at 100 (`tools/flash8-draw.ps1` starts
the program, chooses the tool with its key, types the smoothing into the
panel and draws the line with the mouse).

| The line drawn | Smoothing 0 | Smoothing 100 |
|---|---|---|
| A wave, 380 pixels wide and 45 high | a wave | **the same wave** |
| A tremble, a quick up and down of 4 pixels every 14 pixels | **a wavy, scalloped line** | **a straight line** |

So the smoothing does two things, and only two:

1. **The quick changes of the hand are gone.** A tremble is a change that
   is over in a few pixels, and the middle of a quick change is the line
   through it.
2. **The slow changes, the shape of the line, are not touched.** A wave is
   a change that is over in a hundred pixels or more, and the middle of a
   slow change is the change itself.

That is what a **moving average** does, and nothing else does it: the
middle of the points around a point. It is **not** a taking away of the
points that bend nothing (a Ramer–Douglas–Peucker simplification), for
that flattens every gentle curve: the points of a wave sit within a
fraction of a pixel of the straight line through their neighbours, so
every wave is a straight line once the points are taken away.

**TVMini status.** The smoothing of TVMini is in `public/core/smooth.js`:
every point of the stroke is replaced by the middle of the points around
it, the points that are near enough being the ones that are counted. The
first and the last point of the stroke stay where they are, so the stroke
starts and ends where the hand did, and the pressure of a point is the
pressure the pen said. The raw points are kept aside while the stroke is
drawn, so the average can be taken again and again over the same points
without the line melting away. It is set with the **Smooth** slider in
the tool property panel, from 0 to 100, and 50 is the setting it starts
at.

### Why a line in Flash stays clean at any zoom

A line in Flash is not a picture of a line. It is a **path**: a list of
points and a width, kept as numbers. The program draws that path again
for the size the stage is shown at, so the line is drawn in the pixels of
the screen however far the stage is magnified. There is nothing to blur,
because there is no picture of the line to make bigger.

**TVMini status.** The strokes of TVMini are points and a width as well,
and they are drawn on the stage in the pixels of the screen
(`public/app.js`, the drawing of a layer), so a line stays clean at any
zoom. The **pencil** of TVMini draws a thin line with a hard edge, the
way the pencil of Flash does: the ends are cut square and the corners are
sharp (`stroke.hard` in the project, `lineCap` and `lineJoin` in the
drawing).

## The pen pressure

The strings of the program were read to find what it knows about the pen
(`H:\flash 8\Flash 8\en\Configuration\FlashResources.dll`). Three of them
are about the tablet:

| The string in Flash 8 | What it is |
|---|---|
| **Change the Brush size based on pen pressure** | a setting of the brush: the size of the brush follows the pressure of the pen |
| **Use angle information from the tablet to determine brush orientation** | a setting: the brush is turned with the tilt of the pen |
| **Use Pressure** / **Use Tilt** | the two ways the tablet can shape the brush |

So the pen does three things in Flash 8:

1. **The size of the brush follows the pressure.** The setting is there
   to turn it off; with it on, a light touch draws a thin line and a
   hard press draws a thick one.
2. **The brush is turned with the tilt of the pen**, so a picture brush
   lies along the nib the way a real brush does.
3. **The size of the brush is the pressure or the tilt**, never both at
   once.

There is **no pressure setting in the program itself** (`Flash.exe` has
no string with "pressure" in it): the pressure is read from the tablet
and used where the brush draws.

**TVMini status.** The pressure of the pen sets the width of the line
(`pressureFor` in `public/app.js`, the width of a stroke from the
pressure of the point), with a gain that a person can set (25% to 300%),
and the pen pressure can be turned off altogether. Two things were
changed after this study:

- **The readings of the pen are averaged.** The pen tells how hard it is
  pressed many times a second, and the readings jump about a little
  every time, so the width of the line jumped with them. The last four
  readings are averaged now, the way the line itself is smoothed.
- **A line whose width changes is one shape.** The stroke was drawn as a
  run of segments, each with its own width, so the width of the line
  changed in steps and the edge of the line was a row of little arcs.
  The stroke is now the left side of the line and the right side of it,
  filled together (`strokeOutline` in `public/core/paint.js`), so the
  width changes the way the width of a pen changes and the edge of the
  line is one clean edge. The export draws the same line the same way,
  so what is on the stage is what is written in the file.

The **tilt** is not used yet: a browser tells the tilt of the pen
(`tiltX` and `tiltY` of a pointer event), and the brush of TVMini is a
round tip ✗ — a round tip has no direction to turn ✗ — so the tilt
would only matter for a picture brush.



