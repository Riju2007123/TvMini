/**
 * Node wrapper for the platform-independent `.tvpp` reader and writer in
 * `public/core/tvpp.js`. Kept in `src/` so `server.js` imports a plain
 * Node-facing module, exactly like the `.clip` wrappers.
 */
export { createTvppBuffer, readTvpp, decodeTvppLayers, importTvppBytes } from "../public/core/tvpp.js";
