import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Download a file once and re-download only when it changed (ETag / If-None-Match).
 * Returns the parsed JSON and whether it changed.
 */
export async function fetchCached<T>(url: string, path: string, fetchFn: typeof fetch = fetch): Promise<{ data: T; changed: boolean }> {
  const etagPath = path + '.etag';
  const headers: Record<string, string> = {};
  if (existsSync(path) && existsSync(etagPath)) headers['If-None-Match'] = readFileSync(etagPath, 'utf8');
  let res: Response;
  try {
    res = await fetchFn(url, { headers });
  } catch (err) {
    if (existsSync(path)) return { data: JSON.parse(readFileSync(path, 'utf8')) as T, changed: false };
    throw err;
  }
  if (res.status === 304 && existsSync(path)) return { data: JSON.parse(readFileSync(path, 'utf8')) as T, changed: false };
  if (!res.ok) {
    if (existsSync(path)) return { data: JSON.parse(readFileSync(path, 'utf8')) as T, changed: false };
    throw new Error(`GET ${url} returned ${res.status}`);
  }
  const text = await res.text();
  const data = JSON.parse(text) as T;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const etag = res.headers.get('etag');
  if (etag) writeFileSync(etagPath, etag);
  return { data, changed: true };
}
