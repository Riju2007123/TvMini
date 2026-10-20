import test from "node:test";
import assert from "node:assert/strict";
import { FILE_KINDS, saveFile } from "../public/core/storage.js";

/**
 * The dialog of the browser has to be told which kind of file is wanted.
 *
 * Without that the dialog offers every file type there is, and the name it
 * suggests has no extension that says what the file is.
 */
test("every kind of file the app writes has a type and an extension", () => {
  for (const [key, kind] of Object.entries(FILE_KINDS)) {
    assert.equal(typeof kind.description, "string", `${key} needs a description`);
    assert.ok(kind.description.length > 0, `${key} needs a description`);
    assert.match(kind.mime, /^[a-z]+\/[a-z0-9.+-]+$/i, `${key} needs a mime type`);
    assert.ok(Array.isArray(kind.extensions) && kind.extensions.length > 0, `${key} needs an extension`);
    for (const extension of kind.extensions) {
      assert.match(extension, /^\.[a-z0-9]+$/i, `${key} has a bad extension`);
    }
  }
});

test("the save dialog is asked for the one kind of file that is wanted", async () => {
  const asked = [];
  const before = globalThis.window;
  globalThis.window = {
    showSaveFilePicker: async (options) => {
      asked.push(options);
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
  };

  try {
    for (const [key, kind] of Object.entries(FILE_KINDS)) {
      asked.length = 0;
      const result = await saveFile(`name.${kind.extensions[0].slice(1)}`, new Uint8Array([1, 2, 3]), key);
      assert.equal(result, null, "a cancelled dialog saves nothing");
      assert.equal(asked.length, 1);
      const options = asked[0];
      assert.ok(options.suggestedName.includes(kind.extensions[0]));
      assert.ok(Array.isArray(options.types), `${key} must name the kind of file`);
      assert.equal(options.types.length, 1);
      assert.equal(options.types[0].description, kind.description);
      assert.deepEqual(options.types[0].accept[kind.mime], kind.extensions);
    }
  } finally {
    if (before === undefined) delete globalThis.window;
    else globalThis.window = before;
  }
});
