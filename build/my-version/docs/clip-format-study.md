# The native `.clip` format, and how Clip Studio Paint writes it

This note records the method a `.clip` file uses, so that TVMini's reader and
writer can be built on the real format instead of a guess. Everything here was
read out of real Clip Studio Paint documents and confirmed against the shipped
`CLIPStudio.exe`.

The code that implements this lives in:

| File | What it does |
|---|---|
| `public/core/clip.js` | the reader: the container, the database, the pixels, the layer tree |
| `public/core/clip-blocks.js` | the codec shared by the reader and the writer |
| `public/core/clip-write.js` | the writer: it builds a document CSP opens |
| `src/clip.js` | the same reader, with the file system added |
| `src/clip-write.js` | the same writer, with the file system added |

## What was examined

**The program.** Clip Studio Paint 1.5, the native Windows build:

| | |
|---|---|
| Path | `C:\Program Files\CELSYS\CLIP STUDIO 1.5\CLIP STUDIO\CLIPStudio.exe` |
| Size | 28 MB, PE32+, x86-64, image base `0x140000000` |
| SHA-256 | `ad0a801100a82c9ad40923c6c9a88ec26b0d9c977165234e8b2dcbb1e0f0720c` |
| PDB | `CLIPStudio.pdb`, GUID `e48deea3-c4e0-4321-ae99-f86b408f65d8` |
| Contents | 60,191 procedures, 26,405 strings |

Two strings in the binary give the whole container vocabulary away. They sit
next to each other in `.rdata`:

```
0x1415f6f78   "CSFCHUNKCHNKHeadCHNKFootCHNKExtaCHNKSQLi%s-journal"
0x1415130b0   "extrnlid"
```

The five chunk names are one contiguous literal, and the `%s-journal` is the
SQLite journal mode CSP turns the database into.

**The documents.** Eighteen real `.clip` files, from 0.25 MB to 16.4 MB, all
written by Clip Studio Paint 1.5 (`Project.ProjectInternalVersion` is `1.1.0`).
The blank document TVMini uses as its template,
`public/assets/clip-template.clip`, is one of them, 267,270 bytes with
`CHNKHead`, four `CHNKExta` chunks, `CHNKSQLi` and `CHNKFoot`.

## The container

A `.clip` file is a flat list of chunks behind a 24 byte header:

```
0x00   8 bytes   "CSFCHUNK"
0x08   u64 BE    the size of the whole file
0x10   u64 BE    the size of this header, 24
0x18             the first chunk
```

Every chunk is the same shape:

```
0x00   8 bytes   the name, ASCII
0x08   u64 BE    the size of the payload
0x10             the payload
```

CSP writes the chunks in this order:

| Chunk | Payload | What it holds |
|---|---|---|
| `CHNKHead` | 40 bytes | the format version and the document id |
| `CHNKExta` | varies | one blob that lives outside the database |
| `CHNKSQLi` | the database | the SQLite file image |
| `CHNKFoot` | empty | the terminator |

### `CHNKHead`

```
0x00   u64 BE   256       the format version
0x08   u64 BE   offset    the file offset of the CHNKSQLi chunk header
0x10   u64 BE   16
0x18   16 bytes            the document id, a fresh random value per file
```

The offset at `0x08` was checked against every document: it always points at
the `CHNKSQLi` chunk header. The writer keeps it up to date as the blobs are
added.

### `CHNKExta`

This is the part the old reader skipped entirely, and it is where the pixels
live. The payload opens with a locator:

```
0x00   u64 BE   40        the size of the locator
0x08   40 bytes           the blob id, "extrnlid" and 32 uppercase hex digits
0x30   u64 BE             the length of what follows
0x38                     the blob
```

### `CHNKSQLi`

The payload is the SQLite file image, byte for byte: its length is always the
page count times the page size (4096 in every document seen), and the SQLite
header's page count agrees.

## The database

A real document holds 21 tables. The ones that matter for a reader:

| Table | What it holds |
|---|---|
| `Project` | the name, the default page size, the colour setup, `ProjectInternalVersion` |
| `Canvas` | the canvas size, the resolution, the crop frame, the colour profiles |
| `Layer` | one row per layer: the name, the type, the visibility, the lock, the opacity, the mipmap and the thumbnail |
| `Mipmap`, `MipmapInfo` | the chain of scaled levels of a layer |
| `Offscreen` | the raster of one level: an `Attribute` blob and a `BlockData` pointer |
| `LayerThumbnail` | the 512×512 preview of a layer |
| `CanvasPreview` | the PNG of the whole canvas |
| `ExternalChunk` | where each external blob sits in the file |
| `ExternalTableAndColumnName` | which columns are stored outside the database |
| `Track`, `TimeLine`, `AnimationCutBank` | the animation |
| `LayerComp`, `LayerCompManager` | the layer compositions |
| `ElemScheme`, `ParamScheme` | the settings of every element and parameter |
| `CanvasItem`, `CanvasItemBank` | the canvas items |
| `RemovedExternal` | the blobs that were dropped |

Three of these are created by the program itself, and the exact statements
are in the binary:

```
CREATE TABLE IF NOT EXISTS ExternalChunk(ExternalID BLOB, Offset INTEGER);
CREATE TABLE IF NOT EXISTS ExternalTableAndColumnName(TableName TEXT, ColumnName TEXT);
CREATE TABLE IF NOT EXISTS RemovedExternal(ExternalID BLOB);
```

Every other table is created with one statement:

```
CREATE TABLE IF NOT EXISTS %s(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT)
```

and its columns are added afterwards.

### Layer types

| `LayerType` | Kind | Notes |
|---|---|---|
| 1 | raster | an ordinary drawing layer |
| 256 | root folder | the canvas root |
| 800 | information | the "(Story Information)" text layer |
| 1584 | paper | the white background, `DrawToRenderOffscreenType` 61 |

A folder is a row with `LayerFolder` set, not a separate type. An animation
folder has `AnimationFolder` set as well. The old reader dropped the paper
rows and the folders; the new reader keeps every row and says which kind it
is.

### The layer tree

The layers of a document are held in a chain. Two columns say how:

| Column | Meaning |
|---|---|
| `LayerFirstChildIndex` | the first layer inside this folder |
| `LayerNextIndex` | the next layer at the same level |

So a folder's children are the chain that starts at `LayerFirstChildIndex`,
and the chain of a child continues with `LayerNextIndex`.

**The chain starts at the bottom of the screen.** The root folder of a real
document points at the paper layer, the paper points at the animation folder,
and the animation folder points at the "(Story Information)" layer — which is
the top row of the Clip Studio Paint palette. The reader therefore turns the
chain around at every level: the first layer of the list is the top one.

A worked example, from `Animation2.clip`:

```
root (type 256)
└── Paper (type 1584)
    └── Animation folder (AnimationFolder = 1)
        ├── "1"
        │   └── "1a"
        │       └── "2"
        │           └── "2a"  (a folder)
        │               ├── "Layer 1"
        │               ├── "Layer 2"
        │               └── "Layer 3"
        └── "3"
            └── "4"
```

Turned around, that is the order the palette shows: the animation folder at
the top, then the cells `4`, `3`, `2a` (with the three layers inside it),
`2`, `1a` and `1`, and the paper at the bottom.

### How the writer rebuilds the tree

The project keeps its layers in one list, top first, and every layer has a
`parent` index, so it holds the same tree in a flat form. The writer turns
that back into the chain:

- Every project layer becomes a `Layer` row, folders included.
- A folder is a row with `LayerFolder = 1` and `LayerType = 0`; a drawing
  layer is `LayerFolder = 0` and `LayerType = 1`. Both flags were read off
  real folders and raster layers, not guessed.
- The children of a folder are linked from `LayerFirstChildIndex`, each one
  pointing at the next with `LayerNextIndex`. Each list is **reversed**
  before it is written, because the chain runs from the bottom of the canvas
  up.
- The root folder (`Canvas.CanvasRootFolder`) points at the paper, the paper
  points at the bottom layer of the canvas, and the top layer ends the chain
  with `LayerNextIndex = 0`.

A folder has a mipmap chain but **no blob**: in `Animation10.clip` and in
`b 3.clip` the `BlockData` id of a folder is not listed in `ExternalChunk`.
Clip Studio Paint opens such a file, so the writer gives a folder a chain and
writes no pixels for it.

Measured: a project of five layers with a folder inside a folder exports and
reads back with the same names, kinds and depths; so do `Animation10.clip`
(7 layers), `Animation4.clip` (20) and `Animation14.clip` (34).

### The cells of an animation folder

The children of an animation folder are the **cells** of the animation, and
each one of them is a layer of its own. A cell can be a raster layer or a
folder that holds several layers.

**Which one a document uses is a choice of the document.** Measured with
`tools/clip-cell-layers.mjs`:

| document | the cells of its animation folders |
|---|---|
| `Animation15` | 4 raster layers, each with a picture |
| `Animation5` | 8 raster layers, each with a picture |
| `Animation2` | one folder of 7 raster cells, and one folder whose 5 cells are **folders** of 3 layers each |
| `bleach (2)` | every cell is a **folder** of 2 to 6 layers - a puppet animation |
| a `.clip` TVMini writes | raster cells, one picture each |

So a simple animation is a row of bitmaps, and a puppet animation is a row
of folders, each holding the parts that move together. The reader keeps both
(shapes the same), and the writer writes a hand-drawn row as raster cells
and leaves the puppet structure of an imported document alone - `bleach (2)`
comes back with all 256 of its layers, the folders among them included.

**A cell's name is not its frame.** The name is a number and an optional
letter: `1`, `1a`, `1b`, `2`, `2a`. The letter tells which cell it is when a
frame carries more than one of them, but the number is only the frame the
cell was *made* on, and moving a cell on the timeline does not rename it.
The corpus proves it: one track of `bleach collab.clip` holds
`1, 1a, 2, 2a, 3, 5, 6, 7, 8, 9, 10, 3a, 4`, and the action document places
`3a` and `4` next to each other, not on frames 3 and 4.

The truth is in the action document of the track that belongs to the
animation folder. Its `ImageCelName` curve holds one key per cell: the
`Frame` array gives the time in 60 Hz ticks, the `Value` array gives the
cell's index in the folder, and the `Tag` array gives its name. The layout
is written out under "The FCurve record" below.

A cell whose name does not appear in the curve — a layer inside a cell that
is not a cell itself, for instance — keeps the frame and the hold of the
cell it sits in.

**A cell holds until the next cell starts.** An animation folder has no
holes in it: the cells of a row follow each other, and the last one holds
until the end of the track. That is why a document of the corpus has a cell
on every frame of its row, and why the hold of a cell is not a number of its
own but the distance to the cell after it. TVMini holds its cells the same
way now (`closeCellGaps` in `public/timeline.js`): a cell that is made on a
later frame reaches the cell before it, and the cell that is made reaches the
cell after it.

**A cell can sit somewhere else than it was drawn.** The track of an
animation folder carries more curves than the names of the cells:
`ImagePosition.X/Y`, `ImageScale.X/Y`, `ImageCenter.X/Y` and
`ImageRotation` say where the picture of a cell is, how big it is and how far
it is turned. `bleach (2)` has them: the parts of its puppets move from one
frame to the next, and the curves say how. A layer of Clip Studio Paint has
only an offset (`LayerOffsetX/Y`) — the place of its picture — so a scale or
a turn belongs to the cell, not to the layer.

TVMini keeps the same thing: a cell may carry a transform
(`{ x, y, scale, rotation }`, `public/core/transform.js`). The picture turns
and grows around the middle of the canvas, the brush is put back into the
picture before the ink is put down, and the export writes the picture where
the transform says — a `.clip` has no layer-level scale or turn of its own.

**The curves of a cell are read on import.** A track of `bleach (2)` carries
`ImagePosition` (where the middle of the picture is), `ImageCenter` (where it
is at home), `ImageScale` and `ImageRotation`, and the difference between
the position and the centre is how far the picture is from its place. A
document that is imported keeps the place of its cells, so the parts of a
puppet animation are still where they were, and a cell that is a folder of
layers is moved as a whole.

The writer has no curve of its own for that, so the picture is put where the
transform says instead. The document looks the same, but the turn and the
size of a cell live in the picture rather than in the curves of its track.

### The tracks that are not cell tracks

A document has more tracks than the ones that show cells:

| kind | what it is | how it is written |
|---|---|---|
| 2003 | the paper: the range of the whole timeline | copied from the skeleton ✓ |
| 2000 | a row of cells | the cells are spliced into it ✓ |
| 2005 | the camera | its six curves are spliced into it ✓ |
| 2001 | the track of an ordinary layer | carried over as it is ✓ |
| 1000 | the track of the cel folder | carried over as it is ✓ |
| 4000 | the play time of the animation | carried over as it is ✓ |

The last three hold no cells, so the cells of a document do not depend on
them, but **Clip Studio Paint shows a layer in its timeline only when the
layer has a track** — a document that is written without them shows the
rows of its animation folders and nothing else. They are carried over as
they are, with the range of the document instead of the one they had, and a
layer that had one gets its track again: the uuid of the layer is kept in
the project, so the track can be found when the project is written back out.

### How a blob is found

Three pieces fit together:

1. `Offscreen.BlockData` holds a 40 byte blob: the text `extrnlid` and 32 hex
   digits. It is a pointer, not the data.
2. `ExternalChunk` maps that id to a file offset. The offset is the offset of
   the **`CHNKExta` chunk header**, not of its payload. This was confirmed on
   every document: the first blob of `Animation11.clip` is at offset 80, and
   80 is exactly where the first `CHNKExta` chunk header sits.
3. `ExternalTableAndColumnName` lists the columns that are stored this way.
   In every document it is the same ten, and the first one is the one that
   matters:

```
Offscreen        BlockData
VectorObjectList VectorData
Canvas3DModelBank      BankData
Canvas3DModelLoader    ModelData
Track                   TrackActionMixer
Track                   TrackActionMixer2
CanvasItemBinary        ItemBinaryData
Manager3DOd             SceneData
ModelData3D             Layer3DModelData
TimeLapseBlob           BlobData
```

## The raster

A layer's pixels are a grid of 256×256 tiles.

### The attribute

`Offscreen.Attribute` is a blob of four sections. The first four 32 bit
numbers are the size of the size table (16) and the size of each section. The
sections are the parameters, the initial colour and the table of block sizes.

The parameter section holds, at 22 bytes in, twenty 32 bit values:

| Value | Meaning |
|---|---|
| 0 | the width of the raster |
| 1 | the height |
| 2 | the number of tile columns |
| 3 | the number of tile rows |
| 4 | the colour mode, 33 for RGB |
| 6 | the number of channels, 4 |
| 7 | the bit depth, 5 |
| 14, 15 | the height and the width of one tile, 256 |

The block size section holds the tile count, the channel count and then the
byte length of every tile record.

### The tiles

A `CHNKExta` blob that holds a raster is a list of tile records, each one:

```
0x00   u32 BE   the size of the record
0x04   u32 BE   the length of the key in characters, 19
0x08   38 bytes "BlockDataBeginChunk", UTF-16 big endian
0x2E   u32 BE   the index of the tile
0x32   u32 BE   the size of the tile once it is unpacked
0x36   u32 BE   the width of the tile
0x3A   u32 BE   the height of the tile
0x3E   u32 BE   1 when the tile has pixels, 0 when it is empty
0x42   u32 BE   the size of the compressed tile, plus four
0x46   u32 LE   the size of the compressed tile
0x4A            the zlib stream
```

A record with pixels ends with `u32 17` and the key `BlockDataEndChunk`.
After the records come two trailer properties, `BlockStatus` and
`BlockCheckSum`, each a name in UTF-16 big endian followed by an array of
32 bit values, one per tile.

An empty tile record is 104 bytes and a full one is 112 bytes more than its
compressed data.

### Inside a tile

The tile is stored as `(height + 64) × width` RGBA pixels:

- The **colour** sits in rows 64 and up, one row per source row.
- The **alpha** is folded into the first 64 rows as a grid of 4×4 super-pixels.
  The alpha of the source pixel `(y*4+tile, column*4+channel)` is at
  `(tile*64 + column)*4 + channel` in row `y`.
- The colour channels are in **blue, green, red** order.

That last point is the one that catches people out. The writer has always
swapped the red and blue bytes, because that is what CSP expects, and the
reader has to swap them back.

The fold only works because a tile is 256 pixels wide: the fold covers
exactly 64 rows of 256 pixels. A tile of any other width spills over into the
rows below, so the codec is only valid at the real tile size of 256.

### A second tile layout, with no folded alpha

Not every tile is packed that way. `Illustration.clip` holds tiles whose
unpacked size is exactly `height × width × 4` — no extra 64 rows — and whose
alpha is already in the fourth byte of every pixel. Read as a folded tile,
`decodeRgbaBlock` ran off the end of the buffer at row 65 of a 256 by 128
tile: `sourceStart 132096` against a buffer of `131072` bytes, which is
`128 × 256 × 4`.

The two layouts are told apart by length alone, and the test is exact:

```
folded   raw.length === (height + 64) * width * 4
plain    raw.length ===  height         * width * 4
```

The plain layout only needs the blue and red bytes swapped; its alpha is used
as it stands. With that branch in place, `Illustration.clip` imports, and the
sample goes from 32 of 43 documents read to 41 of 43. The two that are left
are not documents at all: one is a TVMini project saved with a `.clip`
extension and one is an empty file.

## The animation

`TimeLine` holds the frame rate and the frame range. `Track` holds the
keyframes, in two opaque blobs, `TrackActionMixer` and `TrackActionMixer2`,
with a `TrackKind` that says what the track animates (2000 and 2003 were seen).
The `TrackValueMap` column maps the values onto the frames.

TVMini reads the timeline, reports the tracks, and reads the `ImageCelName`
curve of every track to place the cels of an animation folder. The writer
still writes a static document: the bundled template has no `TimeLine` table
at all, so an export carries the timing of the template rather than the timing
of the project.

## The picture of a document

These are the rules the reader follows, each one measured against a document
and checked against what Clip Studio Paint and Umoupen show.

**The canvas is the size of the document.** A document has two sizes: the
canvas (`Canvas.CanvasWidth` and `Canvas.CanvasHeight`) and the page
(`Project.DefaultPageWidth` and `Project.DefaultPageHeight`). The page is the
sheet of paper, the canvas the whole area the layers live on. The pictures of
the layers are the size of the canvas and the camera works in canvas
coordinates, so the canvas is the size the document is read at. Only one
document of the corpus has a page that is smaller than its canvas:
`Animation.clip` is 2064 by 3080 with a page of 2064 by 2280.

**A layer's picture sits where the layer sits.** `Layer.LayerOffsetX` and
`Layer.LayerOffsetY` say where the layer is on the canvas, and the picture is
put there at its own size. The part that falls outside the canvas is cut away.
`LayerRenderOffscrOffsetX` and `LayerRenderOffscrOffsetY` say where the
layer's own buffer was drawn from, not where its picture is: adding them moves
the picture of `Animation.clip` 400 pixels too high.

**A hidden folder hides the layers inside it.** `Layer.LayerVisibility` is
read for every layer, and a layer inside a folder that is hidden is not
painted. Without that rule the picture of `Animation3.clip` shows three
sketches on top of each other where the document shows one: two of the three
animation folders of that document are hidden.

**The opacity of the folders above a layer counts into it.** The opacity of a
layer is its own times the opacity of every folder above it.

**A cell the track does not name is not on screen.** The track of an animation
folder says which of its cells are shown and when. A cell that is in the folder
but not in the track stays in the folder without a frame, and is not painted.

### The camera

A camera is a track of kind **2005**, and it hangs on the camera layer (a layer
of type 512). Its mixer carries six curves:

| Curve | Axis | What it says |
|---|---|---|
| `ImageCenter` | X and Y | the half width and the half height of the frame the camera looks through |
| `ImagePosition` | X and Y | where the middle of that frame sits on the canvas |
| `ImageRotation` | - | how far the camera is turned, in degrees |
| `ImageScale` | - | how much of the frame is shown, in percent |

Every curve carries the times of its keys (`Frame`) and the value of every key
(`Value`), and the keys of the camera are the rows all of them share. The times
are the 60 Hz ticks of the document, so they become frames with the frame rate
of the document, the same way the cells do.

The window the camera shows is the frame scaled by the zoom, with its middle
where the position says:

```
x = positionX - centreX * scale
y = positionY - centreY * scale
width  = 2 * centreX * scale
height = 2 * centreY * scale
```

CONFIRMED against `Animation.clip`: its camera says a frame of 1920 by 1080
around the point (954.6, 2570) at 73.9 percent, which is the window 245.0,
2170.9 of 1419.3 by 798.3. Umoupen draws that window as the red rectangle on
the page, and the rectangle measured on its screen is 1415 by 804 canvas pixels
with its top edge at 2161 - the same window to within a pixel. The keys of the
camera are on frames 1, 22 and 41, and Umoupen shows its keyframes on frames
1 and 22.

The camera curves carry no easing of their own, so the camera travels at a
constant speed between two keys (INFERRED: the easing of a camera lives in
the blend records of the document, which are not read yet).

## The animation

`TimeLine` holds the frame rate and the frame range. `Track` holds the
keyframes, in two opaque blobs, `TrackActionMixer` and `TrackActionMixer2`,
with a `TrackKind` that says what the track animates.

The tracks of a timeline form a list: `TimeLine.FirstTrack` points at the
first one and each `Track.TrackNextIndex` points at the next. The kinds that
were seen are 1000, 2000, 2001, 2003 and 2005 (a plain track, an animation
track, a track with one more property, a track on a layer and one more), and
3000, 3103, 3104, 3106 and 4000 in the documents that use the 3D and the
comic features.

### The mixer blobs

`Track.TrackActionMixer` and `Track.TrackActionMixer2` are 40 byte pointers,
exactly like `Offscreen.BlockData`, and the sizes sit in the columns next to
them. The blob they point at is

```
0x00   u64 BE   the length of what follows
0x08   u32 LE   the length of the compressed part
0x0C            the zlib stream
```

after the 56 byte external locator. Inflating it gives CSP's own serialised
document:

```
0x00   "cmt "        the magic
0x04   4 characters  the version, "0100" or "0110"
0x08   "binc"        the codec
0x0C   u32 LE        a checksum
0x10   u32 LE        the number of entries in the string pool
0x14                the pool, one length prefixed string per entry
```

The pool starts with the type names the document uses and is followed by the
names of the properties and the string values; the body after the pool refers
to those entries by their index. The numbers inside the document are little
endian, while the numbers of the blob that carries it are big endian.

The body itself starts with the number of type names, as a little endian
32-bit number, and then holds the values.

The pool of an animation track, in full, is this. The first twenty-two
entries are the type names and the rest are the property names and the
string values:

```
 0 null          1 Byte         2 SByte        3 UInt16       4 Int16
 5 UInt32        6 Int32        7 Single       8 Double       9 String
10 Float2       11 Float3      12 Quat        13 Matrix44    14 Single[]
15 Byte[]       16 Int32[]     17 String[]    18 Float2[]    19 Float3[]
20 Quat[]       21 Matrix44[]
22 celsysdocument  23 version      24 1.0.0
25 Version-Information  26 Software  27 CLIP STUDIO  28 Version
29 2.1.0         30 General      31 2.0.0
32 ActionNodeClip  33 Name         34 (empty)     35 TimeClip
36 Start         37 End          38 Rate         39 MotionClip
40 MotionBlend   41 ShiftBlend   42 NextBlend    43 BlendEnable
44 TimeInfo      45 AnimInfo     46 Param        47 ImageCelName
48 Tag           49 1            50 FCurve       51 Type
52 Frame         53 Value        54 LeftSlope    55 RightSlope
56 Interp        57 Constant
```

A track that moves a cel has more entries in its pool, with
`ImageAspectScale`, `ImageCenter`, `ImagePosition`, `ImageRotation` and
`Opacity` in it, and its curve has an `Axis` and both an `X` and a `Y`.

The type names seen are `null`, `Byte`, `SByte`, `UInt16`, `Int16`,
`UInt32`, `Int32`, `Single`, `Double`, `String`, `Float2`, `Float3`, `Quat`,
`Matrix44` and the arrays of them. A document that carries doubles instead of
floats has `Double2`, `Double3` and `Double[]` as well.

### The body, as far as it is mapped

The body starts with the number of type names and then holds the values. The
values are written as a regular stream, and the layout of two different
documents is the same: comparing the mixer of an animation track in
`Animation11.clip` (120 frames) with the one in `Animation16.clip` (33
frames), the two bodies have the **same length pattern and the same offsets
for every field**. Only the values differ, and they differ as floats:

```
offset 176   3.84375   vs   3.8438...      a float
offset 200   3.25      vs   3.25           a float
offset 264   3.84375   vs   3.8438...      a float
```

So the property values are single precision floats, and the names in the pool
appear in the body at fixed offsets. Around offset 380 the body holds a run of
numbers that step by 256, which is the stride of one tile, so the keyframe
table is laid out in 256 byte records.

What is still missing in that first reading is how a value is tagged and where
a nested object ends. The answer turned out to be that the records are simply
not aligned: the body has to be scanned at **every byte offset**, and a record
is recognised by its first words. The `FCurve` record, which is the one that
places the cells, is written out under "The FCurve record" below.

The rest of the tree — `TimeClip`, `Param`, the blend properties — is still
not walked end to end, so the animation cannot be written back yet, and TVMini
does not try to. The writer keeps a document static on purpose: a malformed
mixer is the one thing that could make Clip Studio Paint reject a file that
otherwise opens, and a static file that opens is worth more than an animated
file that does not.


The property names in the pool say exactly what a track holds. The smallest
track has `ActionNodeClip`, a `TimeClip` with `Start`, `End` and `Rate`, the
blend properties `MotionBlend`, `ShiftBlend`, `NextBlend` and `BlendEnable`,
`TimeInfo` and `AnimInfo`. An animation track adds `Param` with
`ImageCelName` and `Tag`, and one `FCurve` with `Type`, `Frame`, `Value`,
`LeftSlope`, `RightSlope`, `Interp` and `Constant`. A track that moves a cel
adds `ImageAspectScale`, `ImageCenter`, `ImagePosition`, `ImageRotation` and
`Opacity`, and its curve has an `Axis` and both an `X` and a `Y`.

The program itself names the same things in its type information, in the
`Planeswalker` namespace:

```
.?AVPWAnimationFCurve@Planeswalker@@
.?AVPWFCurve@Planeswalker@@
.?AV?$vector@VPWFCurveKey@Planeswalker@@...
```

So a keyframe is a `PWFCurveKey`: a frame, a value, the slope on each side
and the interpolation. The keyframe list itself is not decoded yet: the value
part of the body still has to be mapped out, and until it is, an animation
cannot be written back.

TVMini reads the timeline, the tracks, the sizes and the property names, and
reports them. It does not write animation: the bundled template is a static
document with no `TimeLine` table at all, so an export carries no motion.

### The body, read as a stream of four-byte integers

Fresh measurement on the animation track of `Animation10.clip`
(`extrnlid75507AEF65004DFE994FF502EF050F40`, 651 bytes on disk, 1,700
inflated, 62 pool entries, body starting at byte 491):

The pool ends at 491 and the remaining 1,209 bytes read as 302 little endian
32-bit integers plus one spare byte. Reading each integer, and replacing it
with the pool entry when it is one, gives the document's own outline back in
document order:

```
  491  16            527  16 (Int32[])      555  16
  495  20            531  20 (Quat[])       559  24 '1.0.0'
  499  32 'Name'     535  24 '1.0.0'        563  28 'Version'
  503  22 'celsysdocument'  539  25 'Version-Information'
  507   0 'null'     543   0 'null'         571   9 (String)
  511   1 (Byte)     547   0 'null'         575  27 'CLIP STUDIO'
  515  23 'version'  551   2 (SByte)
  519  24 '1.0.0'                            603   9 (String)
  523   2 (SByte)                            607  29 '2.1.0'
```

Two things follow, and both are measured rather than assumed:

1. **The integers are not all of the same kind.** Pool indices name the
   document's parts, and the numbers 0 to 21 are the type codes, because they
   index exactly the first twenty-two pool entries. The `9` at offset 571 is
   followed by the string `CLIP STUDIO` at 575, which is a `String` value
   carrying a pool index; the `8` that appears later in the body sits in front
   of eight bytes, which is a `Double`.
2. **A value therefore does not have a fixed width.** `null` takes no bytes,
   `Byte` and `SByte` take one, `UInt16` and `Int16` two, `Single` four,
   `Double` eight, and `String` four because it is a pool index. Reading the
   body at a flat four-byte stride therefore drifts out of alignment after the
   first short value, which is why the earlier reading of this body looked
   irregular.

The path that carries the timing is present literally as pool indices at
byte 1,195 onwards:

```
 1195  45 'Param'   1215  46 'ImageCelName'   1235  47 'Tag'
 1199   6 (Int32)  1219  47 'Tag'            1239  48 '6'
```

so `AnimInfo → Param → ImageCelName → Tag` with the value `"6"` is not an
inference from the property names: the pool indices spell it out at a known
offset.

**What is still not known** is the width of an array (`Int32[]`, `Double[]`
and the rest) and whether a record is terminated by a count or by a sentinel.
Until those two are settled the body cannot be walked from end to end, and an
animation cannot be written back.

### The size of a mixer body is fixed by the size of its pool

Ten documents of the sample were measured, and the length of the body is a
straight line in the number of pool entries, to the byte:

| pool entries | body bytes | | pool entries | body bytes |
|---|---|---|---|---|
| 57 | 1009 | | 65 | 1329 |
| 58 | 1049 | | 69 | 1489 |
| 59 | 1089 | | 72 | 1609 |
| 62 | 1209 | | 74 | 1689 |
| 64 | 1289 | | 88 | 2249 |

```
body bytes = 1009 + 40 * (pool entries - 57)
```

Every extra pool entry costs exactly **40 bytes** of body. Since a cell adds
one entry to the pool (its name — the names `1` to `6` are pool entries 57 to
61 and 48 of `Animation10.clip`) and 40 bytes to the body, the record for one
cell is **40 bytes**. The earlier note in this document that the keyframe
table is laid out in 256 byte records was a misreading of the data and is
withdrawn.

Reading the body as 32-bit integers **from the start of the body** does not
stay in step: the records are not aligned to four bytes. Reading at every
offset and checking the words against the pool is what finds them. The earlier
note that "every value sits in the upper half of the word" (`0x0010` for 16)
was this misalignment: `00 10 00 00` is not 16, it is what the bytes look like
when the real word `10 00 00 00` is read two bytes off its start.

### The FCurve record: where every cell sits

The `ImageCelName` curve of a track is what places the cells. It is a record
inside the body that is found by scanning every byte offset, because nothing
in this part of the document is aligned. The record is:

```
u32   the pool index of "FCurve"
u32   0
u32   the number of properties (1 to 8)
n x   u32 property name, u32 property value      Type = ImageCelName
u32   the number of fields (one per array)
n x   u32 the pool index of "Int32[]"
      u32 the width of the array plus 24
      u32 that number plus 4
      u32 the field name, u32 the field type, u32 how many values
      the values
      u32 0
      u32 0
```

Every field starts with those three metadata words. Their second word is the
payload plus 24 and their third is four more, which is a strong enough check
that a chance match in the body is not mistaken for a curve.

The fields of a cell curve are `Frame`, `Value`, `LeftSlope`, `RightSlope`,
`Interp` and `Tag`, all arrays of the same length:

| Field | Type | Meaning |
|---|---|---|
| `Frame` | `Double[]` | when the key starts, in 60 Hz ticks |
| `Value` | `Double[]` | the cell's index inside the animation folder |
| `Tag` | `String[]` | the pool index of the cell's name |
| `LeftSlope`, `RightSlope` | `Double[]` | unused for a cell, always 0 |
| `Interp` | `String[]` | `Constant`: a cell does not blend |

Measured on `Animation3.clip`, the Animation folder with nine cells:

```
Frame   0  4  8 10 16 18 20 22 24        (60 Hz ticks)
Tag     1  2  3  4  5  6  7  8  9
Value   0  1  2  3  4  5  6  7  8
```

At 30 fps a frame is two ticks, so the cells start on frames 0, 2, 4, 5, 8,
9, 10, 11 and 12 — **not** on consecutive frames. The rest of the file
confirms the unit: the 24 fps `Animation2.clip` steps by 2.5 ticks
(`0, 2.5, 5, 7.5, 10, 17.5`), which becomes the whole frames
`0, 1, 2, 3, 4, 7`.

The `TimeClip` of the same document carries `Start`, `End` and `Rate` as plain
doubles (`Rate` is 60). `End` is the last frame of the track, in the same
ticks, and it is what says how long the **last** cell is held: a cell stays on
screen until another replaces it. The corpus agrees with `TimeLine`:

```
Animation3.clip   End 248 -> 124 frames at 30 fps   BiggestEndFrame 124
Animation10.clip  End 240 -> 120 frames at 30 fps   BiggestEndFrame 120
Animation2.clip   End 300 -> 120 frames at 24 fps   BiggestEndFrame 120
```

So the rule for a reader is: a cell starts on `round(Frame * fps / 60)`
frames after the first frame of the document, and lasts until the next key;
the last cell lasts until `End`.

### The frames of a document: where a track stops

Three numbers decide when a cell is on screen, and all three were measured
against the documents of the corpus (`H:\a`: `Animation2`, `Animation5`,
`Animation15`, `bleach (2)`).

**`TimeLine.EndFrame` is a count of frames, not the last frame.** With
`StartFrame = 0` it is also the 1-based number of the last frame of the
timeline:

| document | fps | `StartFrame` | `EndFrame` | the track of the cells |
|---|---|---|---|---|
| `Animation15` | 24 | 0 | 120 | 0..300 ticks = 120 frames |
| `Animation5` | 30 | 0 | 25 | 0..254 ticks = 127 frames |
| `Animation2` | 30 | 0 | 18 | 0..36 ticks = 18 frames |
| `bleach (2)` | 24 | 0 | 101 | 0..252.5 ticks = 101 frames |

`TimeLine.BiggestEndFrame` is a different number: it is the largest end of
any track of the document (`Animation5` has `EndFrame` 25 and
`BiggestEndFrame` 127, because its track runs on past the timeline).

**The `End` of a track is a boundary, not a frame.** The `TimeClip` of a
track holds `Start`, `End` and `Rate` as plain doubles, and `End` is where
the track stops: the frame it ends on is the first frame that is *not*
shown. `Animation15` runs from tick 0 to tick 300 at 24 fps, which is 120
frames of 2.5 ticks, and the last cell it shows is frame 120 - the frame
that starts at tick 300 is not shown.

**The cells of a track are keys, and a key can sit on any frame.** The
`ImageCelName` curve of `Animation15` holds keys at ticks 7.5, 15 and 22.5,
which are frames 3, 6 and 9 at 24 fps - not frames 1, 2 and 3. The name of
a cell says nothing about the frame it shows, and a cell whose name is a
number is not the frame it shows.

Together these three facts fix the timing of a document:

- a cell shows from the frame of its key until the next key starts;
- the last cell of a track shows until the track stops, and the track stops
  at the end of the timeline if it runs on past it;
- the frame of a key is `1 + round(tick * fps / 60)`, the ticks being 60 Hz.

The writer writes the same numbers back: the range of a track ends on the
boundary after the last frame it shows, and the cells of a row are written
in the order Clip Studio writes them (by number, a letter after its number),
which is the order they play in.

### What else a document with an animation carries

A blank document is an illustration. A document with an animation is
different, and Clip Studio Paint reads these settings when it opens the
file, so they are taken from the document the animation is written from:

| where | what | in a blank document | in a document with an animation |
|---|---|---|---|
| `Canvas` | `TimeLineFrameDisplay` | missing (0) | 1 - the timeline counts its frames from 1 |
| `Canvas` | `TimeLineEditMode` | missing | 1 |
| `Canvas` | `CropFrame*` | missing | the rectangle of the page inside the canvas |
| `Project` | `DefaultPageSettingType` | `Illust` | `Animation` |
| `Project` | `DefaultPageUseCropFrame` | 0 | 1 |
| `Project` | `DefaultPagePaper*` | black | the colour of the paper |

`TimeLineFrameDisplay` is what makes the frame counter of Clip Studio Paint
read `21 / 1 / 25` rather than `20 / 0 / 25`: without it the same document
shows the frames from zero, and the current frame of the document is read
as it is stored.

### Writing an animation: what is known and what is missing

An animation document needs three things: a `TimeLine` row, a chain of
`Track` rows, and a mixer blob for every track. The schema of the first two
is known exactly, because it was read out of real documents:

```
TimeLine(_PW_ID, MainId, BankId, NextTimeLine, NextScenario, FirstTrack,
         TimeLineUuid, TimeLineName, SceneIndexForName, CutIndexForName,
         CurrentFrame, FrameRate, StartFrame, EndFrame, GuidelineFrameRate,
         LabelFirstIndex, SmallestStartFrame, BiggestEndFrame)

Track(_PW_ID, MainId, BankId, ItemId, TrackNextIndex, TrackActionMixerSize,
      TrackActionMixer, TrackActionMixer2Size, TrackActionMixer2,
      TrackValueMap, TrackOpen, TrackContentOpen, TrackUuid,
      LayerUuidWithTrack, TrackKind, TrackOptionFlag)
```

The tracks of one timeline form a list: `TimeLine.FirstTrack` names the
first one and each `Track.TrackNextIndex` names the next. A track hangs on
the layer whose uuid is in `LayerUuidWithTrack`.

The mixer blob and the action document are described above, and so is the
`FCurve` record. A **writer** needs a document to put a curve into: a new
track needs the whole `TimeClip`/`Param` tree, and CSP validates a document
well enough that guessing that tree is not worth the risk. The way around it
is to borrow one: the `.clip` a project was imported from already holds a
track with a cell curve, so that track is the skeleton.

What *is* settled is the document itself. `public/core/clip-mixer.js` reads
every mixer of `Animation3.clip` and `Animation2.clip`, rebuilds it from its
parts and gets the same bytes back (10 of 10 and 4 of 4). That means the
string pool, the word after it, the body and the checksum are all understood:

- the checksum is the standard CRC-32 of every byte from offset 16 to the end
  (checked on all 14 documents), so a rebuilt document can always be stamped
  valid again;
- a curve record can be replaced on its own, with more keys or fewer, without
  touching anything outside it - the same edit CSP makes when a key is added
  by hand. `tools/mixer-roundtrip.mjs` replaces the `ImageCelName` curve of
  `Animation3.clip` with the same keys, one more and one fewer, and reads each
  result back;
- the external chunk that carries a document is the 40 byte locator, the
  big-endian length of what follows, the little-endian compressed length and
  the zlib stream, and it round-trips;
- `TrackActionMixerSize` (and its `2` sister) is the length of the *unpacked*
  document, not of the compressed blob.

One subtlety cost a day: the string pool of a document is written from the
pool the record was built with, so a curve whose cell names are **not yet in
the pool** needs the longer pool handed to the writer as well. Without it the
tag values point past the end of the pool and the curve reads back empty.

The record grammar was also walked end to end by `tools/binc2.mjs`, which
re-encodes all fourteen documents byte for byte. Its rules (struct, typed
leaf, array leaf, string leaf, counted item) are recorded in "Inside the
mixer blobs" below.

The three words before a field are `[Int32[]]`, `[total - 8]` and
`[total - 4]`, where `total` is the size of the field including those three
words, the name, the type, the count and the trailing `[0][0]`. A `Double[]`
of nine values says 96 and 100, and a `Double` of one value says 28 and 32.

### Writing a whole animation

`createClipBuffer(project, { animation })` writes the timeline of a project
into a new file. `animation` is the skeleton to copy from: the `.clip` the
project was imported from, or `true` for the bundled document that holds a
real animation (`public/assets/clip-animation-template.clip`, a copy of
`Animation2.clip`).

The skeleton gives the writer the parts of the format it does not understand:
the definitions of the `TimeLine` and `Track` tables, the row of a cell track
and the two action documents of that track. Everything else is written from
the project.

#### The model Clip Studio Paint uses

Measured on `Animation2.clip` and `Animation3.clip`:

- A **cell is a layer**. The cells of a row live inside an *animation
  folder* (`LayerType = 0`, `LayerFolder = 1`, `AnimationFolder = 1`), and
  the name of the cell is the name of that layer. In `Animation2.clip` the
  folder "Animation folder" holds the layers `1`, `1a`, `2`, `2a`, `3`, `4` -
  the same names the `Tag` values of the cell curve carry.
- Every animation folder has **its own track** of kind 2000, bound to the
  folder through `LayerUuidWithTrack` (the 16 bytes of the layer's uuid
  without its dashes). `Animation3.clip` has three of them: one for the
  animation folder and one for each of the folders "Folder 1" and "Folder 2".
- The **paper has a track of kind 2003** that carries the range of the whole
  timeline: `Start`, `End` and `Rate` as plain doubles (`Rate` is 60, the
  timebase of the document). The same three numbers sit in the `TimeClip` and
  in the `TimeInfo` of the document, and a writer sets them together.
- The frames of the timeline are counted from zero: `TimeLine.StartFrame` is
  the frame before the first one, `TimeLine.EndFrame` is the *number* of
  frames, and a key time is `(frame - 1) * 60 / fps` ticks. `Animation2.clip`
  has 120 frames at 24 fps, so the range runs from 0 to 300 ticks.
- A cell holds until the next cell starts, which is what the `Interp` value
  `Constant` says. The `Value` of a key is the number of the cell among the
  plain cells of its folder: `Animation2.clip` numbers its plain cells
  `1`, `2`, `3`, `4` as 0, 1, 2, 3, while the two cells that are folders of
  their own carry a number of their own.

#### What the writer does

- The `TimeLine` and `Track` tables are created with the definitions of the
  skeleton, and the rows of the skeleton are copied.
- A project layer that holds drawings becomes a **row**: an animation folder
  with one child layer per drawing, each holding the picture of that drawing,
  and a track of kind 2000 whose `ImageCelName` curve names the cells and
  gives the frame each one starts on. A group whose children are cells (the
  shape a document that came from Clip Studio has) is a row as well, and its
  cells are the layers that are already there.
- The cell names are the names of the drawings, or their number in the layer
  when a drawing has no name - the same rule the exposure sheet uses.
- Both mixers of a track are written: the version 0110 one and the version
  0100 one. Each is spliced in its own flavour, so whichever of the two
  Clip Studio reads, it reads the same cells.
- The range of every track is the range of the project: `Start` is the tick of
  the first frame, `End` the tick of the frame behind the last one, `Rate` 60.
- The mixer blobs become external chunks of their own, and the
  `ExternalChunk` offsets are written again.

#### The camera

The camera is written on the same rule as a cell track: its six curves are
spliced into the two mixers of the camera track the skeleton carries, in the
flavour each mixer uses, so everything of a camera track beyond its curves is
copied rather than made up.

- The track is a `Track` row of kind **2005**, and `LayerUuidWithTrack` names
the camera layer: the folder of the project whose layer says `camera`, which
is written as a layer of type 512 with `LayerFolder = 1`. The reader marks
that folder when it imports a document, so a document that came from Clip
Studio Paint gets its camera layer back.
- The project stores a camera as a window (`x`, `y`, `width`, `height`,
`rotation`), while the curves store the half size of the frame, its middle
and the zoom. The writer picks the zoom of **100 %**, where the frame is the
window itself, so the fold the reader does gives the same window back:
`centreX = width / 2`, `positionX = x + width / 2`, and the same on Y. A
camera written at another zoom would read back as the same window only to
within the rounding of the fold.
- The keys become the `Frame` ticks and the `Value`s of all six curves. The
times are the 60 Hz ticks of the document, like the cells, and the range of
the track runs from the first key to the boundary after the last one.
- The camera curves carry no easing (`clip-format-study.md` above), so the
`interp` of a key is not written; a camera read back travels at a constant
speed between its keys.
- A skeleton without a camera track has no tree to copy, and the bundled
animation template has no camera, so a project exported from it gets no
camera track. The camera of a document is written back when that document is
the skeleton - which is the case that matters, because that is where the
camera came from.

`tools/clip-roundtrip-corpus.mjs` compares the cells of a round trip; the
camera has its own test in `test/clip-camera-export.test.js`, which checks the
layer of type 512, the track of kind 2005, the key it is bound to and the
values that come back on import.

#### Which layer is a row

A row is a folder whose children are cells, but a cell can be a folder of its
own: the cells of "Folder 1" in `Animation3.clip` each hold layers of their
own, and those layers are cells of the cell, not rows of their own. So a
folder that sits inside another folder of cells is a cell, and a layer that
sits inside a row is a cell too. Only the outermost folder of cells is a
row.

A layer of the project that holds **more than one** drawing is a row as well:
its drawings become the cells of an animation folder, one layer each. A layer
with a single drawing stays an ordinary layer, so a project without an
animation exports as a document without one.

#### Checked in Clip Studio Paint

`tools/clip-export-animation.mjs` imports `Animation3.clip` and writes it out
again; `tools/clip-export-cells.mjs` makes a project with three cells of its
own and writes that. Clip Studio Paint opens both, and their timelines show

```
Folder 2 : 7 cel        3 4 5      (cells 1 1a 2 2a 3 4 5)
Folder 1 : 5 cel        3 4 5      (cells 1a 2 3 4 5)
Animation folder : 9 cel 5 6 7 8 9  (cells 1 2 3 4 5 6 7 8 9)
```

and

```
Dots : 3 cel            first second third   (frames 0, 2 and 4)
```

which are the cells and the frames the files record. The layer panel of the
second one shows the folder "Dots : 3" with the three cells below it.

`TrackValueMap` is kept inside the database rather than outside it. Its shape
is a small property bag: `u32 8`, a `u32` entry count, then per entry
`u32 size`, a UTF-16 big endian key, a UTF-16 big endian text, `u32 kind` and
the value. The one that was read out of track 12 is 54 bytes and holds
`ImageCelName` -> `"9"` with value `8`. The writer copies it as it is: CSP
reads the cells from the curve and not from this map.

#### The two flavours of a mixer document

A track carries two action documents, and they are not the same format:

- The **0110** document writes three words in front of every array field:
  the pool index of `Int32[]`, the size of the field and that size plus
  four. The reader checks them, and the writer writes them.
- The **0100** document writes the same record without those three words:
  the field follows the field count directly, as
  `[name][type][count][values][0][0]`, and its times are `Single[]` where
  the newer flavour uses `Double[]`.

The reader of TVMini only understands the 0110 flavour, so a 0100 document
reads as a track without cells. The writer understands both: `locateCurve`
walks the record in either flavour, and the record is rebuilt in the flavour
it was found in. Splicing a document with the plan it already carries gives
the document back byte for byte - that was checked on all eight cell
documents of `Animation2.clip` and `Animation3.clip`.

The pool of a document is written from the pool the record was built with, so
a curve whose cell names are **not yet in the pool** needs the longer pool
handed to the writer as well. Without it the tag values point past the end
of the pool and the curve reads back empty.

## The paper

The paper is not a picture. Clip Studio Paint reads its colour from the
document settings and from the draw colour of the paper layer, and each
channel sits in the **top byte of a 32 bit word**:

| Column | Meaning |
|---|---|
| `Project.DefaultPagePaperRed` | the red channel, in the top byte |
| `Project.DefaultPagePaperGreen` | the green channel, in the top byte |
| `Project.DefaultPagePaperBlue` | the blue channel, in the top byte |
| `Layer.DrawColorMainRed` and its two sisters | the same, on the paper layer |

A white paper therefore has `0xffffffff` in every one of them, and the
`Layer` row of the paper also carries `DrawColorEnable = 1` and
`DrawToRenderOffscreenType = 61`.

The initial colour in the `Offscreen.Attribute` of the paper layer holds
the same colour as a packed `RRGGBBAA` word, but Clip Studio Paint does
**not** read the paper from it: a document whose initial colour says
magenta and whose settings say white is drawn with a white paper. The
settings are what the application reads.

This was found by measurement, not by reading the program: writing
`0x11000000`, `0x00220000` and `0x00003300` into the three channels and
looking at the canvas in Clip Studio Paint gave red `0x11`, green `0x00`
and blue `0x00`, which says the top byte of each word is the channel and
nothing else.

The reader now uses that: the three project settings become the background
colour of the imported project through `paperColorOf`, and the paper row is
no longer turned into a layer. It used to be, and every export then wrote
the template's real paper **and** an empty raster layer named `Paper` — two
paper rows in a file that came from one. Measured on `Animation10.clip`
before and after the change.

The `LayerType = 800` row, "(Story Information)", is treated the same way:
it is the document's own metadata, not a layer to paint on. Both rows stay
in the layer tree the reader reports, so nothing about the document is lost;
they are only left out of the project.

## How another program reads all of this

A commercial program that reads `.clip` and `.tvpp` was measured with the
same method, and what it says about the format is written down here. The
program is closed and its code is not used; what follows is the *shape* of
the format as that program understands it, which is a fact about the format
and not about the program.

**The queries it runs** are the clearest statement of what a reader needs.
It reads the layer list with one query that joins `Layer` to `Mipmap`,
`MipmapInfo` and `Offscreen`, and takes:

```
MainId, LayerName, LayerOpacity, LayerComposite, LayerVisibility,
LayerFolder, LayerNextIndex, LayerFirstChildIndex, LayerOffsetX,
LayerOffsetY, LayerRenderOffscrOffsetX, LayerRenderOffscrOffsetY,
the offscreen's Attribute, the external id, AnimationFolder, LayerUuid,
LayerType, LayerRenderMipmap, LayerClip
```

The external id is taken as `substr(BlockData, 9, 32)`, which is the
thirty-two hex digits that follow the eight-letter prefix — the same thing
this application works out by hand.

It reads the mask of a layer with a second query of the same shape, over
`LayerLayerMaskMipmap`, together with `LayerMasking`, `LayerMaskOffsetX`,
`LayerMaskOffsetY`, `LayerMaskOffscrOffsetX` and `LayerMaskOffscrOffsetY`.
So a mask is an ordinary mipmap chain of its own, and it is **not** the
chain the layer is painted with.

It reads the animation with

```
SELECT MainId, FirstTrack, FrameRate, StartFrame, EndFrame, TimeLineName FROM TimeLine
SELECT MainId, TrackNextIndex, TrackKind, TrackActionMixerSize,
       the external id of the mixer, LayerUuidWithTrack FROM Track
```

so the mixer is reached by the same external-id mechanism as the pixels.

**The model of an animation folder is not what the names suggest.** The
program does not read a cell's name to learn its frame. It reads a
*folder* that holds *strips*, and a strip is a range of time that holds
*keys*, and a key is a frame with a tag. Its own words for these are
"strip", "key" and "cel":

| What it calls it | What it says about it |
|---|---|
| a **cel** | a row with a checksum and a size: `row=%d crc=%08x size=%dx%d` |
| a **strip** | a range of time in a folder: `strip=%d time=%d..%d source=%.6g..%.6g keys=%d` |
| a **key** | a frame and a tag: `key=%d frame=%d tag='%s'` |
| a **component** | a part of a layer that is either raster or vector |

So the cell names `1`, `1a`, `2` that appear in the layer table are the
*names* of the cels, and the frame a cel sits on comes from the timing
that goes with it, not from its name. This application reads the name
instead, which is why its cells land on the wrong frame.

**A layer has a canvas of its own.** The program calls it a "fixed
canvas" and keeps an "origin" with it, and it *refuses* a layer whose
origin is not zero:

```
raster layer '%s' has invalid fixed canvas %dx%d origin=%d,%d expected=%dx%d origin=0,0
```

and it says the same about the paper and the camera:

```
%s paper=%dx%d camera=%dx%d offset=%.0f,%.0f
```

The paper of the document and the window the camera frames are two
different sizes, and there is an offset between them.

**A cel of an animation may be raster or vector**, and a component that
mixes the two is split:

```
folder='%s' split mixed component=%d into raster/vector
```

This matches what this application found the hard way: a vector layer
keeps no raster at all, and the raster of a vector object is a separate
offscreen that is reached by the layer rather than by the mipmap chain.

**What is still not known.** The program does not say how the mixer body
is laid out, so the part that is missing here is still missing. What it
does say is that the answer is a tree of strips, keys and cels rather
than a flat list of cells, and that a cel's frame comes from the timing.

## How CSP writes a file

Putting it together, the method CSP uses is:

1. Build the SQLite image with the tables above, in the order above.
2. Put every large value that belongs to an external column into its own
   `CHNKExta` chunk, and record the id and the file offset of that chunk in
   `ExternalChunk`.
3. Write the container: the 24 byte header, `CHNKHead` with the offset of the
   database chunk and a fresh document id, the `CHNKExta` chunks, the
   `CHNKSQLi` chunk, and an empty `CHNKFoot`.
4. Write the size of the file into the header.

TVMini's writer does the same thing, with one difference that makes it
possible to start from a blank document: it takes a real CSP file as a
template and rewrites the database inside it, rather than building the
twenty-one tables from scratch. The container it writes follows the layout
above exactly, and it hands out a new document id for every export.

## What is not decoded

These are real parts of the format that this reader does not read, and it says
so in its own output:

- The vector layers, the masks and the text layer attributes.
- The camera and object tracks of an animation (`ImagePosition`, `ImageScale`
  and the like): the cell curve is read, the motion curves are not.
- The 3D models and the time lapse blobs.
- The `ElemScheme` and `ParamScheme` settings.

Nothing is ever written back into a source file: reading a `.clip` never
changes it.

## Inside the mixer blobs: the CELSYS document

The two 40-byte blob pointers of an animation track resolve to a zlib
envelope (40 byte locator, u64 big-endian total at offset 48, u32
little-endian compressed length at offset 56) whose body inflates to a
CELSYS `binc` document.

The total at offset 48 is **four plus the compressed length** - the length of
what follows the compressed length word, not the length of the unpacked
document. Measured on the fourteen documents of `Animation2.clip` and
`Animation3.clip`: 419 against 415 compressed bytes, 486 against 482, 600
against 596, 700 against 696, and so on. The length of the *unpacked*
document is a column of its own, `TrackActionMixerSize` (and its `2`
sister), and that one is the document's own length.

Document layout: `"cmt "`, a version tag (`0100` or `0110`), `"binc"`,
a u32 checksum (CRC-32 over the document bytes from offset 16 onward), then
a string pool (u32 count followed by one-byte-length + bytes strings), a u32
word total, and a little-endian word stream.

### The record grammar (confirmed by exact round-trip)

The word stream is a forest of records. `tools/binc2.mjs` now parses all
fourteen mixer documents of Animation2.clip and Animation3.clip (both
versions, 0100 and 0110) and re-encodes each one byte for byte, which is the
experimental guarantee behind these rules.

- Header: in 0100 the stream begins with 2 extra words ([0][1]); in 0110
  with 4. The header words are captured verbatim and re-emitted.
- Pool indices 0..21 are always the type names (null, Byte, SByte, UInt16,
  Int16, UInt32, Int32, Single, Double, String, ... through Matrix44[]).
  In 0110 the mid list differs: 10/11/14 become Double2, Double3 and
  Double[] instead of the Float/Single variants, and pool indices shift by
  one where 0100 carries an extra `"2.0.0"` row.
- Typed leaf: [name idx >= 22][type 1..21][value in natural size][aux two
  words]. Every leaf the tools observed carries aux (0, 0), and the codec
  rejects anything else, which prunes false parses. `Byte` stores 1 byte;
  everything else stores 2/4/8/16/64 bytes by type.
- Array leaf: same, with type 14..21 and a u32 element count before the raw
  elements. `Double[]` elements are 8 bytes (observed in 0110 Frame/Value
  curves); `Single[]` are 4.
- String leaf: [name][pool index] - two words, no aux.
- Counted item: [count <= 63][name][count x u32][optional (0,0) aux]. The
  body top level uses it for `Param [Int32, UInt16]` in front of the FCurve
  card.
- Struct: [name][0][extra 0?][count][count records]. The 3 word form ends
  after the count (General, ActionNodeClip, Version-Information); the 4 word
  form has one extra zero word (TimeClip, MotionClip, MotionBlend, TimeInfo,
  AnimInfo). AnimInfo normally carries 0 children and is followed by the
  FCurve card as top level records.
- 0110 triplets: a [16][x][y] triplet can appear before nearly any record
  and also *between* the words of a record. Observed positions: before a
  struct/leaf (usually right after the small lead word), and inside the
  counted item between the count word and the name word (0100
  `[2][Param][6][3]` becomes 0110 `[2][triplet][Param][6][3]`). The codec
  captures every triplet verbatim as the record's prefix and re-emits it in
  the same position, so no triplet semantics are needed.
  In front of an **array field** the triplet is not a prefix but the field's
  own header: `[Int32[]]`, the size of the field, that size plus four. A
  version 0100 document writes no such header, which is why the fields of
  the two flavours sit at different offsets.
- Lead words: small words (1, 2, 5, 0, 6 ...) can stand before a named
  record; they are captured as 4 byte prefixes and re-emitted verbatim.

### Round-trip results

`node tools/binc2.mjs <file>` decodes every TrackActionMixer / mixer2 blob,
parses the document with the grammar above and re-encodes the tree:

- Animation2.clip: pass=4 fail=0, all four re-encodes byte identical.
- Animation3.clip: pass=10 fail=0, all ten re-encodes byte identical.

`node tools/binc2.mjs <file> dump` prints the record tree with byte spans;
set BINC2_TRACE=1 to log every candidate the search yields.

### What the FCurve card holds (Animation2 track 2, kind 2000)

After AnimInfo the stream carries, as top level records:
`[2][Param][6][3]`, `Name = "ImageCelName"`, `Tag = "4"`,
`FCurve (1) { Type = "" }` (a struct whose one child is the string leaf
`Type = "ImageCelName"`), then six array leaves - `Frame`, `Value`,
`LeftSlope`, `RightSlope` (Single[]/Double[]), `Interp` (String[], six
`"Constant"`), `Tag` (String[], the cel names per keyframe, e.g.
`"1","1a","2","2a","3","4"`). TimeClip's `Start`/`End`/`Rate` doubles sit in
the kind-2003 track with Start=0, End=300, Rate=60, and TimeInfo's `Rate`
double repeats the frame rate. These are exactly the nodes a writer must
splice to rewrite timing, frame count and the cell plan.

