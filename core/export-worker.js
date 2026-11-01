/**
 * The heavy part of a `.clip` export, run off the page.
 *
 * Building a `.clip` occupies the processor for a while on a document with
 * many layers, and on a page that would hold everything back: the timers of
 * the status bar, the pointer and the tabs of the browser. This worker does
 * the build instead, and hands the finished bytes back.
 *
 * One message in, one message out; the worker is dropped afterwards.
 */
import { createClipBuffer, clipExportScale } from "./clip-write.js";

self.onmessage = async ({ data }) => {
  try {
    const scale = data.scale ?? clipExportScale(data.project.width, data.project.height);
    const built = await createClipBuffer(data.project, {
      name: data.name,
      animation: data.animation ?? null,
      scale,
    });
    // The bytes of the result are an own block of memory on the way out, so
    // that the ownership of them can be moved with the message and no copy
    // of the file is kept in the worker.
    let bytes = built.buffer;
    if (!(bytes instanceof Uint8Array)) {
      bytes = new Uint8Array(bytes);
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    self.postMessage(
      {
        ok: true,
        buffer: copy,
        width: built.width,
        height: built.height,
        stageWidth: built.stageWidth,
        stageHeight: built.stageHeight,
        scale: built.scale,
        layers: built.layers,
        tracks: built.tracks,
        // Where the seconds went, so a slow document can be told apart
        // from a slow machine.
        timings: built.timings,
      },
      [copy.buffer],
    );
  } catch (error) {
    self.postMessage({
      ok: false,
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack) : null,
    });
  }
};
