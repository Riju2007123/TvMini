# The brush of Clip Studio Paint (a `.sut` file)

Clip Studio Paint keeps a brush in a file with the extension `.sut`. TVMini
reads those files (so a brush made in Clip Studio Paint can be used here) and
now writes them too (so a brush made here can be used in Clip Studio Paint).

This is what was worked out from the brushes on this machine, by opening them
and looking inside. The tools that did the looking are in `tools/`:

| tool | what it does |
|---|---|
| `sut-inspect.mjs` | opens a `.sut` file and prints the tables and the rows |
| `sut-schema.mjs` | prints the tables and the values of a plain brush |
| `sut-shape.mjs` | shows where the pictures sit inside the material |
| `sut-tar.mjs` | lists the files inside the material |
| `sut-compare.mjs` | compares a brush of Clip Studio Paint with one of ours |
| `sut-roundtrip.mjs` | writes a brush and reads it back |
| `sut-inside.mjs`, `sut-texture.mjs`, `sut-catalog.mjs`, `sut-zip.mjs` | the first steps of the search, kept for the record |

## The file

A `.sut` file is a **SQLite database**. It holds three tables, and one more
when the brush has a picture:

| table | what is in it |
|---|---|
| `Manager` | what the file is: the version of the format, and the numbers of the brush |
| `Node` | the brush itself: its name (`NodeName`) and the settings that belong to it |
| `Variant` | the settings of the brush: one row for the brush as it is now, one row for the settings it starts with |
| `MaterialFile` | the picture of the tip of the brush, when it has one |

The tables and the columns are the same in every brush that was looked at
(187 columns in `Variant`, 24 in `Node`, 12 in `Manager` and 7 in
`MaterialFile`), so the shape of the file is stable.

The settings that matter for a brush are:

| setting | what it is |
|---|---|
| `BrushSize`, `BrushSizeUnit` | how wide the brush is (0 is pixels) |
| `Opacity` | how strong the brush paints |
| `BrushFlow` | how much paint one dab of the brush leaves |
| `BrushHardness` | how hard the edge of the tip is |
| `BrushThickness` | how much of the tip the stroke uses |
| `TextureScale2`, `TextureRotate` | how the picture of the tip is turned and sized |
| `TextureImage` | a short description of the picture, used by Clip Studio Paint itself |

Every other column has a value that a new brush starts with, and this program
writes those values too, so a brush written here looks the way a new brush in
Clip Studio Paint does.

## The picture of the tip

The picture is not in the tables. It sits in `MaterialFile`, and the file
there is a **TAR archive** with five files in it:

```
catalog.zip                 a small picture for the list of materials
info.zip                    a small picture
data/material_0.layer       the picture of the tip itself
thumbnail/thumbnail.png     a plain picture of the tip
icedata/layerData.xml       what the material is
```

The names are a little odd (`catalog.zip` holds a picture, not a ZIP file),
but this is what Clip Studio Paint writes.

**The tip of the brush is the picture in `thumbnail/thumbnail.png`.** The
picture in `data/material_0.layer` is written by Clip Studio Paint in a way
that cannot be read: its data does not fit the checks of the PNG format, and
decoding it gives a picture with nothing in it. The thumbnail is a plain
picture of the same tip, and it is the one that is used.

A brush can have more than one material: a brush that has a grain of paper
as well keeps that in another material. The material that holds the tip is
the one whose `icedata/layerData.xml` says `BrushPattern`; the others say
`PaperTexture` or something of their own. The thumbnail with the most paint
in it is the tip.

The XML says what the material is. A brush material is marked like this:

```xml
<datalist key="systemtag">
  <data>Resizable</data>
  <data>BrushPattern</data>
</datalist>
<datalist key="foldertag">
  <data>画像素材:ブラシ</data>
</datalist>
```

## Reading a brush

`public/core/sut.js` opens the database, asks for the name and the settings,
and then looks for the picture: the thumbnail of the material that holds the
shape of a brush. The picture is found by looking for the PNG inside the
file, so a brush works even when the container around it is not understood.

The settings of the brush are kept as well: its size, how strong it paints,
how much paint one dab leaves, how hard the edge of the tip is and the rest.
TVMini can use the size and the strength; the rest describe how Clip Studio
Paint draws the brush, which a picture of a tip cannot say.

## Drawing with a brush that has a picture

A brush with a picture paints that picture along the stroke, the way Clip
Studio Paint paints the shape of a brush. The picture is stamped a little
apart along the path, and it keeps its own shape: it is as tall as the
brush is wide, and its width follows from that, so a brush that is not round
does not become round.

The picture is only the shape of the tip, so the colour of the stroke is
mixed into it before it is painted.

## Writing a brush

`public/core/sut-write.js` writes the file:

1. a new SQLite database is made (`public/core/sqlite.js`, with `node:sqlite`
   under Node and `sql.js` in the browser);
2. the tables are made with the shape above;
3. the brush is put in: the manager, the node with the name, the row of
   settings, and the material with the picture when there is one;
4. the file image is handed back.

The TAR archive is written by `public/core/tar.js`.

## What was checked

* The file we write has the same tables and the same columns as a brush that
  Clip Studio Paint wrote (`tools/sut-compare.mjs`), and 146 of the settings
  are the same; the ones that differ are the numbers of the brush and the
  small graphs Clip Studio Paint keeps for its own sliders.
* The picture of the tip comes back out of the file we write, with its name
  and its size (`tools/sut-roundtrip.mjs` and `test/sut-write.test.js`).
* The whole way through the program — the panel, bringing a brush in, and
  writing one out — was done in a real browser (`tools/brush-check.mjs`).

What was **not** checked here: the file was not imported into Clip Studio
Paint itself. The menus of Clip Studio Paint cannot be driven by a script, so
that last step is left to a person: drag the `.sut` file onto the brush list
in the Material palette of Clip Studio Paint.
