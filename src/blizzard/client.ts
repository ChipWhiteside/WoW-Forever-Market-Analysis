import type { z } from 'zod';

export class BlizzardError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) { super(message); }
}

export interface FetchResult<T> {
  status: number;
  /** null on 304 Not Modified or 404. */
  body: T | null;
  lastModified: string | null;
  bytes: number;
  ms: number;
}

type FetchFn = typeof fetch;

/**
 * Blizzard Game Data client for WoW Forever.
 * One token cached until shortly before expiry. Retries 429 and 5xx with backoff.
 * Sends If-Modified-Since when given, so an unchanged snapshot costs a 304 and no body.
 */
export class BlizzardClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly host: string;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    readonly region = 'us',
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.host = `https://${region}.api.blizzard.com`;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    // In the cloud build session a proxy injects the real credential, so placeholders are fine there.
    const id = this.clientId || 'proxy-injected';
    const secret = this.clientSecret || 'proxy-injected';
    const res = await this.fetchFn('https://oauth.battle.net/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    if (!res.ok) throw new BlizzardError(`Token request failed ${res.status}: ${text.slice(0, 200)}`, res.status, 'oauth');
    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new BlizzardError('Token response had no access_token', res.status, 'oauth');
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  url(path: string, namespace: 'static' | 'dynamic' | 'profile', extra: Record<string, string> = {}): string {
    const u = new URL(this.host + path);
    u.searchParams.set('namespace', `${namespace}-forever-${this.region}`);
    u.searchParams.set('locale', 'en_US');
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** GET a JSON resource and validate it against its contract. Throws on contract violation. */
  async get<S extends z.ZodTypeAny>(
    url: string,
    schema: S,
    opts: { ifModifiedSince?: string | null; retries?: number } = {},
  ): Promise<FetchResult<z.infer<S>>> {
    const retries = opts.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.getToken()}` };
      if (opts.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince;
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers });
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(backoff(attempt));
        continue;
      }
      const lastModified = res.headers.get('last-modified');
      if (res.status === 304) return { status: 304, body: null, lastModified: lastModified ?? opts.ifModifiedSince ?? null, bytes: 0, ms: Date.now() - started };
      if (res.status === 404) return { status: 404, body: null, lastModified, bytes: 0, ms: Date.now() - started };
      if (res.status === 401 && attempt < retries) { this.token = null; continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await res.text().catch(() => '');
        await sleep(backoff(attempt));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new BlizzardError(`GET ${redact(url)} returned ${res.status}: ${text.slice(0, 200)}`, res.status, url);
      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new BlizzardError(`Contract violation for ${redact(url)}: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`, res.status, url);
      }
      return { status: res.status, body: parsed.data, lastModified, bytes: text.length, ms: Date.now() - started };
    }
  }
}

const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const redact = (url: string) => url.replace(/access_token=[^&]+/, 'access_token=***');
