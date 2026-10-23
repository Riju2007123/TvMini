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

The tools that looked at the paper of a brush (`sut-grain-probe.mjs`,
`sut-grain-xml.mjs`, `sut-grain-dump.mjs`, `sut-grain-survey.mjs`) and the one
that drew with the flow, the hardness and the thickness
(`brush-style-check.mjs`) were removed when those settings left this program.
What they found is written down below, and the format still holds them: a
brush of Clip Studio Paint that is brought in here keeps its picture, its size
and its strength, and the rest is left alone.

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
| `BrushInterval` | how far apart the dabs are, as a share of the width (10 = a tenth) |
| `TextureImage` | a short description of the picture, used by Clip Studio Paint itself |
| `TextureDensity`, `TextureScale2`, `TextureRotate`, `TextureReverseDensity` | how the paper of the brush is used: how strong, how large, how far turned, and whether it is turned over |

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

## The paper of a brush

Clip Studio Paint calls the paper of a brush its **texture**. A brush that is
drawn on paper keeps a second material in the file, and that material says it
is a `PaperTexture`:

```xml
<datalist key="systemtag">
  <data>Resizable</data>
  <data>PaperTexture</data>
</datalist>
<datalist key="foldertag">
  <data>単色パターン:テクスチャ</data>
</datalist>
```

**The grain is the alpha of `thumbnail/thumbnail.png` in that material.** The
picture is black, and the pattern is in the channel that says how much paint
is left: where the alpha is high the paper takes the paint, where it is low
the paper shows through. The picture in `data/material.layer` is the same kind
of picture, but it is written in the chunked form that cannot be read (see
"the picture of the tip"), so the thumbnail is used here too.

The other numbers of the texture say how it is used:

| column | what it says | an example |
|---|---|---|
| `TextureDensity` | how strong the paper is, 0–100 | `rough pen 3` 24 |
| `TextureScale2` | how large the paper is, in percent | `rough pen 3` 92 |
| `TextureRotate` | how far the paper is turned, in degrees | most brushes 0 |
| `TextureReverseDensity` | 1 turns the picture over: the holes paint | `CAT PEN 2` 1 |
| `TextureCompositeMode`, `TextureForPlot` | how Clip Studio Paint mixes the texture | read, not used |

`TextureImage` is not the picture: it is a name, written in UTF-16, that points
at the material (`…:data:material.layer`). It is how Clip Studio Paint knows
which of the materials of the file is the paper.

A brush that has no `PaperTexture` material has no paper of its own
(`Real G-Pen 2`, `Flat marker`), even though its `TextureDensity` column still
holds the number a new brush starts with (50). The column only means something
when there is a material to go with it.

What was measured on this machine (`tools/sut-grain-survey.mjs`):

| brush | paper | strength | size | turned over |
|---|---|---|---|---|
| `rough pen 3` | 251×251, alpha 41–248 | 24 | 92 | no |
| `アニメーター専用リアル風鉛筆` | 300×300 | 89 | 32 | no |
| `CAT PEN 2` | 300×300, alpha 22–233 | 100 | 100 | yes |
| `Thick Paint One` | 225×300, alpha 31–174 | 20 | 25 | yes |
| `Real G-Pen 2` | none | – | – | – |

## The paint of a brush

The numbers of the brush are used, not only read. TVMini reads:

* **the flow**: how much paint one dab leaves, and the dabs build up on each
  other when it is below 100;
* **the hardness**: how hard the edge of the tip is;
* **the thickness**: how thick the tip is, so a flat nib draws a thinner line
  across itself than along itself;
* **the spacing**: how far apart the dabs are (`BrushInterval`, a share of the
  width; a brush that says nothing gets a dab every quarter of its width,
  which is what this program drew before);
* **the paper**: the picture and its strength, size and turn.

The paper is kept apart from the stroke, in the place of the document, so the
same brush drawn twice leaves the same holes in the same places. The picture
of the paper is made smaller when it is read — 160 pixels on its longest side,
with 16 steps of alpha — because it is kept with every stroke that is drawn on
it, the way the picture of a tip is. That is about 17 000 characters of text
for each stroke.

A brush that is brought into the program brings its paper with it, and the
panel says so: the card of such a brush says `· paper`, and the rows of the
flow, the hardness, the thickness and the paper are set to the numbers of the
brush.

## Reading a brush

`public/core/sut.js` opens the database, asks for the name and the settings,
and then looks for the picture: the thumbnail of the material that says it is
a brush shape (`BrushPattern`). The picture is found by looking for the PNG
inside the file, so a brush works even when the container around it is not
understood.

The paper is looked for the same way: the material that says `PaperTexture` is
the paper, and its thumbnail is the pattern. The words are searched for in the
raw text of the XML of every material, because the way the XML is written
changes from one material to the next (some write `<data>PaperTexture</data>`,
some write the same word inside a list of words), and the name of the file is
not a sign of anything (`data/material.layer` and `data/material_0.layer` both
happen in the same file).

The settings of the brush are kept as well: its size, how strong it paints,
how much paint one dab leaves, how hard the edge of the tip is, how thick the
tip is, how far apart the dabs are and the paper.

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

The paper of a brush is **not** written back, and the paper of a brush that is
brought in is **not** used. A brush that is written out here is written without
a `PaperTexture` material, because the name that Clip Studio Paint uses to
point at a material (`TextureImage`) is a BLOB whose layout was not worked
out, and a file that points at nothing would be worse than a file without a
paper. The brush itself (its size, its strength and its picture) is written,
with the flow, the hardness and the thickness at the values Clip Studio Paint
starts every brush with, so it comes back into Clip Studio Paint as the same
brush, drawing on plain paper.

## What was checked

* The file we write has the same tables and the same columns as a brush that
  Clip Studio Paint wrote (`tools/sut-compare.mjs`), and 146 of the settings
  are the same; the ones that differ are the numbers of the brush and the
  small graphs Clip Studio Paint keeps for its own sliders.
* The picture of the tip comes back out of the file we write, with its name
  and its size (`tools/sut-roundtrip.mjs` and `test/sut-write.test.js`).
* The paper of a brush was read out of the file, with its strength, its size,
  its turn and the way it is turned over, for the brushes above. That reading
  is kept in this note for the record; the program does not use the paper any
  more.
* The whole way through the program — the panel, bringing a brush in, and
  writing one out — was done in a real browser (`tools/brush-check.mjs`).
* A brush of Clip Studio Paint was brought into the program in a real browser,
  with its paper: the card of the brush said `· paper`, the rows of the panel
  took the numbers of the brush (size 80, flow 79, paper 24 for `rough pen 3`),
  and the same line drawn with the paper turned off held 11 percent more ink
  than the line drawn with it (7 143 811 against 6 471 949). The paper is not
  used any more, so a brush that is brought in now keeps its picture, its
  size and its strength only.

What was **not** checked here: the file was not imported into Clip Studio
Paint itself. The menus of Clip Studio Paint cannot be driven by a script, so
that last step is left to a person: drag the `.sut` file onto the brush list
in the Material palette of Clip Studio Paint.
