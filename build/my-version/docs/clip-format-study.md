# The native `.clip` format, and how Clip Studio Paint writes it

This note records the method a `.clip` file uses, so that TVMini's reader and
writer can be built on the real format instead of a guess. Everything here was
read out of real Clip Studio Paint documents and confirmed against the shipped
`CLIPStudio.exe`.

The code that implements this lives in:

| File | What it does |
|---|---|
| `public/core/clip.js` | the reader: the container, the database, the pixels |
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

## The animation

`TimeLine` holds the frame rate and the frame range. `Track` holds the
keyframes, in two opaque blobs, `TrackActionMixer` and `TrackActionMixer2`,
with a `TrackKind` that says what the track animates (2000 and 2003 were seen).
The `TrackValueMap` column maps the values onto the frames.

TVMini reads the timeline and reports the tracks, but it does not decode the
mixers. The writer writes a static document: the bundled template has no
`TimeLine` table at all, so an export carries the timing of the template
rather than the timing of the project.

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

### What a track animates

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
- The animation mixers, so a document's motion is reported but not replayed.
- The 3D models and the time lapse blobs.
- The `ElemScheme` and `ParamScheme` settings.

Nothing is ever written back into a source file: reading a `.clip` never
changes it.
