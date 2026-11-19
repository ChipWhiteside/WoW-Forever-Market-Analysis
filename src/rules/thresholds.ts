/**
 * PROTECTED. Thresholds that decide what counts as a play. The overnight loop proposes changes
 * here from the calibration report, and only Chip approves them.
 */
/** Smallest profit per item worth Chip's time, copper. Settings key min_profit_each overrides it. */
export const MIN_PROFIT_EACH = 100;

export const MIN_GAIN = {
  /** smallest net gain per unit worth showing, copper */
  copper: 5,
  /** and at least this share of the buy price */
  share: 0.1,
};

/** O3 underpriced listing (spec 5, O3). */
export const UNDERPRICED = { belowTypical: 0.3, minDisappeared: 3, nearTypical: 0.1, windowHours: 72, minReadings: 24 };

/** O6 sell now. */
export const SELL_NOW = { aboveTypical: 0.5 };

/** Alerts (spec 8). */
export const ALERTS = { profitBar: 2500, regrowth: 0.25, quietStartHour: 23, quietEndHour: 7 };

/** A play whose profit shrank by more than this since the last snapshot is fading. */
export const FADING_SHARE = 0.25;
