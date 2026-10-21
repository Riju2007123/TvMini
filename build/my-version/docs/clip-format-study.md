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
`FCurve` record. What is still missing for a **writer** is the rest of the
body: the `TimeClip` and `Param` blocks are nested name/type/value trees whose
nesting rule has not been walked end to end, and CSP checks a checksum over
the document. The cell curve itself is understood, but it has to be embedded
in that tree. `createClipBuffer` therefore still refuses `animation: true`.

A malformed mixer is the one thing that could make Clip Studio Paint reject a
file that otherwise opens, and a static file that opens is worth more than an
animated file that does not. What the writer still needs is a byte-for-byte
round trip of a whole mixer, which is the next step: read a track's body and
write the same bytes back before trying to change anything inside it.

`TrackValueMap` is kept inside the database rather than outside it. Its shape
is a small property bag: a count, two numbers, the length of a key, the key in
UTF-16 big endian and the value. The one that was read out holds
`ImageCelName` with the value `1`.

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
envelope (40 byte locator, u64 big-endian total length at offset 48, u32
little-endian compressed length at offset 56) whose body inflates to a
CELSYS `binc` document.

Document layout: `"cmt "`, a version tag (`0100` or `0110`), `"binc"`,
a u32 checksum (CRC-32 over the document bytes from offset 16 onward), then
a string pool (u32 count followed by u32-byte-length + bytes strings), a u32
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

