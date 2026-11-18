export function coins(copper: number | null | undefined): { g: number; s: number; c: number; neg: boolean } | null {
  if (copper == null || !Number.isFinite(copper)) return null;
  const neg = copper < 0; let c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000); c -= g * 10000; const s = Math.floor(c / 100); c -= s * 100;
  return { g, s, c, neg };
}
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)} days ago`;
}
export const DETECTOR_LABEL: Record<string, string> = {
  vendor_dump: 'Vendor dump', vendor_supply: 'Vendor supply', underpriced: 'Underpriced', cross_house: 'Cross house',
  craft: 'Craft', sell_now: 'Sell now', world_drop: 'World drop',
};
export const DETECTOR_VERB: Record<string, string> = {
  vendor_dump: 'Buy, then vendor', vendor_supply: 'Buy from vendor, list', underpriced: 'Buy, relist', cross_house: 'Buy, carry, list',
  craft: 'Craft, list', sell_now: 'List now', world_drop: 'Farm',
};
