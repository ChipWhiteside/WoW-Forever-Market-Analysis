import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlizzardClient } from '../src/blizzard/client.ts';

export const tempDir = () => mkdtempSync(join(tmpdir(), 'wowf-test-'));

/** A fake Blizzard: route by path, honour If-Modified-Since against a per route Last-Modified. */
export function fakeBlizzard(routes: Record<string, () => { body: unknown; lastModified?: string; status?: number }>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname === 'oauth.battle.net') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), { status: 200 });
    const route = routes[url.pathname];
    if (!route) return new Response('', { status: 404 });
    const r = route();
    const ims = (init?.headers as Record<string, string> | undefined)?.['If-Modified-Since'];
    if (ims && r.lastModified && ims === r.lastModified) return new Response(null, { status: 304, headers: { 'last-modified': r.lastModified } });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.lastModified ? { 'last-modified': r.lastModified } : {} });
  }) as typeof fetch;
  return { client: new BlizzardClient('id', 'secret', 'us', fetchFn), calls };
}
