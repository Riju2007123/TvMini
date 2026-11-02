/**
 * What a file dropped on the window is, and what the program does with it.
 *
 * A drop carries plain files with no behaviour of their own, so the program
 * sorts them by extension into the kinds it can open: its own project, the
 * documents it imports (.clip, .tvpp, Flash), pictures that become cells,
 * and sounds. The rules live here, without the DOM, so the tests can drive
 * them; the page only reads the plan and hands each file to the importer it
 * names.
 *
 * A drop of several pictures becomes one sequence of cells, the same as
 * choosing several in the import dialog. A drop that mixes kinds is not a
 * wish that can be granted twice - the first file the program understands
 * wins, and the rest are reported back.
 */

/** The kinds a drop can carry, most specific first. */
export const DROP_KINDS = [
  { kind: "project", extensions: [".tvmini"] },
  { kind: "clip", extensions: [".clip"] },
  { kind: "tvpp", extensions: [".tvpp"] },
  { kind: "fla", extensions: [".fla", ".xfl"] },
  { kind: "pictures", extensions: [".png", ".gif", ".bmp", ".tga"] },
  { kind: "audio", extensions: [".wav", ".mp3", ".ogg", ".m4a", ".aac", ".flac", ".opus"] },
];

/** The one kind of drop that may carry several files at once. */
export const MULTI_DROP_KIND = "pictures";

/** What kind of file `name` is, or null when the program cannot use it. */
export function dropKind(name) {
  const clean = String(name ?? "").trim().toLowerCase();
  for (const target of DROP_KINDS) {
    if (target.extensions.some((extension) => clean.endsWith(extension))) return target.kind;
  }
  return null;
}

/**
 * Read a drop of `names` and answer what to do.
 *
 * The answer is `{ kind, entries, ignored }`: the kind to import, the
 * positions in `names` that go to it, and the names that were left out.
 * `kind` is null when not one file of the drop can be used.
 */
export function planDrop(names) {
  const list = Array.isArray(names) ? names : [];
  const kinds = list.map(dropKind);
  const ignored = list.filter((name, index) => kinds[index] === null);

  const known = [];
  for (let index = 0; index < list.length; index += 1) {
    if (kinds[index] !== null) known.push(index);
  }
  if (known.length === 0) return { kind: null, entries: [], ignored };

  // Every file a picture: the drop is a sequence of cells.
  if (known.every((index) => kinds[index] === MULTI_DROP_KIND)) {
    return { kind: MULTI_DROP_KIND, entries: known, ignored };
  }

  // Otherwise the first file the program understands stands for the drop.
  const first = known[0];
  return {
    kind: kinds[first],
    entries: [first],
    ignored: list.filter((_, index) => index !== first),
  };
}
