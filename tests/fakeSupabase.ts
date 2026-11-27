import { createHash } from 'node:crypto';

/** A fake Supabase Storage REST server behind a mocked fetch, for src/cloud/supabaseStore.ts (see tests/unit/cloud-store.test.ts). */
export const SUPABASE_URL = 'https://proj.supabase.co';
export const SUPABASE_KEY = 'service-key-123';
const KEY = SUPABASE_KEY;

/** A fake Supabase Storage server for one bucket. `oldErrors` answers misses and conflicts as 400 with statusCode in the body. */
export function fakeSupabase(opts: { bucket?: string; oldErrors?: boolean } = {}) {
  const bucket = opts.bucket ?? 'gold-finder';
  const objects = new Map<string, { body: Uint8Array; etag: string; type: string; at: number }>();
  const calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const err = (code: number, error: string, message: string) => opts.oldErrors
    ? new Response(JSON.stringify({ statusCode: String(code), error, message }), { status: 400, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ statusCode: String(code), error, message }), { status: code, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, path: url.pathname, headers });
    if (headers.apikey !== KEY || headers.authorization !== `Bearer ${KEY}`) return new Response(JSON.stringify({ statusCode: '403', error: 'Unauthorized' }), { status: 400 });
    const p = url.pathname;
    const listPrefix = `/storage/v1/object/list/${bucket}`;
    const objPrefix = `/storage/v1/object/${bucket}`;
    if (method === 'POST' && p === listPrefix) {
      const q = JSON.parse(String(init.body)) as { prefix: string; limit: number; offset: number };
      const folder = q.prefix ? `${q.prefix}/` : '';
      const names = new Map<string, { name: string; id: string | null; updated_at: string | null; metadata: unknown }>();
      for (const [k, o] of objects) {
        if (!k.startsWith(folder)) continue;
        const rest = k.slice(folder.length);
        const slash = rest.indexOf('/');
        if (slash === -1) names.set(rest, { name: rest, id: `id-${k}`, updated_at: new Date(o.at).toISOString(), metadata: { size: o.body.length, eTag: `"${o.etag}"`, mimetype: o.type } });
        else names.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null, updated_at: null, metadata: null });
      }
      const rows = [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(q.offset, q.offset + q.limit);
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'DELETE' && p === objPrefix) {
      const q = JSON.parse(String(init.body)) as { prefixes: string[] };
      const gone = q.prefixes.filter(k => objects.delete(k));
      return new Response(JSON.stringify(gone.map(name => ({ name }))), { status: 200 });
    }
    if (!p.startsWith(`${objPrefix}/`)) return err(404, 'not_found', 'route not found');
    const key = p.slice(objPrefix.length + 1).split('/').map(decodeURIComponent).join('/');
    const o = objects.get(key);
    if (method === 'GET' || method === 'HEAD') {
      if (!o) return method === 'HEAD' ? new Response(null, { status: opts.oldErrors ? 400 : 404 }) : err(404, 'not_found', 'Object not found');
      return new Response(method === 'HEAD' ? null : o.body as unknown as BodyInit, { status: 200, headers: { etag: `"${o.etag}"`, 'content-length': String(o.body.length), 'content-type': o.type } });
    }
    if (method === 'POST') {
      if (o && headers['x-upsert'] !== 'true') return err(409, 'Duplicate', 'The resource already exists');
      const body = new Uint8Array(init.body as Uint8Array);
      objects.set(key, { body, etag: createHash('md5').update(body).digest('hex'), type: headers['content-type'] ?? 'application/octet-stream', at: Date.now() });
      return new Response(JSON.stringify({ Key: `${bucket}/${key}` }), { status: 200 });
    }
    return err(405, 'method', 'not allowed');
  }) as typeof fetch;
  return { fetchFn, objects, calls, bucket };
}

