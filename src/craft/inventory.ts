/**
 * Read one line of a pasted materials list. Accepts "Copper Ore 400", "Copper Ore: 400", "Copper Ore x400",
 * "400 Copper Ore", "400x Copper Ore" and thousands separators ("1,200 Rough Stone").
 */
export function parseInventoryLine(line: string): { name: string; count: number } | null {
  const t = line.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  let m = t.match(/^(.*?[^\d\s,x×:])\s*(?:[:x×]\s*)?(\d[\d,]*)$/i);
  if (m) return { name: m[1]!.replace(/[:\s]+$/, '').trim(), count: Number(m[2]!.replace(/,/g, '')) };
  m = t.match(/^(\d[\d,]*)\s*[x×]?\s+(.+)$/i);
  if (m) return { name: m[2]!.trim(), count: Number(m[1]!.replace(/,/g, '')) };
  return null;
}
