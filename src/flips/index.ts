/** The flip engine (docs/flip-plan.md): build the inputs once, run, store. */
export { chipHouses } from './houses.ts';
export { buildFlipInputs, type FlipInputs } from './inputs.ts';
export { runFlips, type FlipRunResult } from './run.ts';
export { persistFlips } from './persist.ts';
export type { Flip, HeldBack, FlipRunReport } from './types.ts';
