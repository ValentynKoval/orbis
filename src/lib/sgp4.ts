/**
 * The pieces of satellite.js we use, imported from its plain-JS modules. The
 * package entry also re-exports a WASM bulk propagator, which stalls
 * Turbopack's production build of the Web Worker, so nothing may import
 * "satellite.js" directly.
 */
export { twoline2satrec } from "../../node_modules/satellite.js/dist/io.js";
export { sgp4 } from "../../node_modules/satellite.js/dist/propagation/sgp4.js";
export { gstime } from "../../node_modules/satellite.js/dist/propagation/gstime.js";
export { ecfToLookAngles, eciToEcf, eciToGeodetic } from "../../node_modules/satellite.js/dist/transforms.js";
export type { SatRec } from "satellite.js";
