/**
 * The pieces of satellite.js the worker needs. The package entry also
 * re-exports its WASM bulk propagator, which stalls Turbopack's production
 * build of the worker, so we import the plain-JS modules directly.
 */
export { twoline2satrec } from "../../../node_modules/satellite.js/dist/io.js";
export { sgp4 } from "../../../node_modules/satellite.js/dist/propagation/sgp4.js";
export { gstime } from "../../../node_modules/satellite.js/dist/propagation/gstime.js";
export { eciToGeodetic } from "../../../node_modules/satellite.js/dist/transforms.js";
export type { SatRec } from "satellite.js";
