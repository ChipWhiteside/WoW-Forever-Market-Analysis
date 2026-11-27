export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  // Phase 2 login: a 401 means the cookie is missing or old; the app shows the login page.
  if (res.status === 401 && path !== '/api/login') dispatchEvent(new Event('wowf-signed-out'));
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

/** Phase 2: who is signed in. authRequired is false in local mode unless SITE_PASSWORD is set. */
export interface Me { authRequired: boolean; username: string | null }
/** One "I did this" or "Sold" row (GET /api/ledger). Money in copper. */
export interface LedgerAction {
  id: number; action: 'did' | 'sold'; did_id: number | null; flip_key: string; username: string; at: number; units: number;
  expected_cost: number | null; expected_profit: number | null; received: number | null; item_id: number | null; name: string | null; kind: string | null; house_id: number | null;
  soldUnits?: number; soldReceived?: number;
}
export interface LedgerPerson { username: string; flipsDone: number; unitsDone: number; unitsSold: number; spent: number; received: number; realised: number; expected: number; realisedVsExpected: number | null }
/** Online only: a write saved on GitHub that counts at the next hourly update (src/cloud/inbox.ts PendingAction). */
export interface PendingAction {
  key: string; at: number; username: string; action: 'did' | 'sold' | 'other';
  flipKey: string | null; didId: number | null; units: number | null; received: number | null; name: string | null; what: string;
}
export interface Ledger { me: string; people: LedgerPerson[]; mine: LedgerAction[]; history: LedgerAction[]; pending?: PendingAction[] }
