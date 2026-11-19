export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}
export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export interface Play {
  key: string; detector: string; house_id: number; house_name: string; faction: string; item_id: number; item_name: string | null;
  quality: string | null; icon_url: string | null; item_class?: string | null; item_subclass?: string | null; state: 'new' | 'live' | 'fading' | 'gone'; profit: number; peak_profit: number;
  confidence: 'high' | 'medium' | 'low'; summary: string; detail: Record<string, any>; first_seen: number; last_seen: number; data_at: number;
  snapshots_seen: number; gone_at: number | null; user_status: string | null;
}
export interface HouseHealth { id: number; name: string; lastPublish: number | null; ageMin: number | null; status: 'ok' | 'late' | 'missing'; lastError: string | null }
export interface Health { at: number; status: 'ok' | 'warn' | 'error'; houses: HouseHealth[]; suspects: string[]; gapsToday: number; message: string }
