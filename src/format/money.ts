/** 12345 copper -> "1g 23s 45c". Drops leading zero units, keeps copper when it is the only unit. */
export function money(copper: number | null | undefined): string {
  if (copper == null || !Number.isFinite(copper)) return '?';
  const neg = copper < 0;
  let c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000); c -= g * 10000;
  const s = Math.floor(c / 100); c -= s * 100;
  const parts: string[] = [];
  if (g) parts.push(`${g}g`);
  if (s) parts.push(`${s}s`);
  if (c || parts.length === 0) parts.push(`${c}c`);
  return (neg ? '-' : '') + parts.join(' ');
}
