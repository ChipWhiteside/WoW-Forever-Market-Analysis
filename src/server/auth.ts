import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Login (docs/phase2-plan.md item 5). A shared password plus a free text username, remembered in an HttpOnly cookie
 * signed with HMAC SHA256 for 90 days. Off unless SITE_PASSWORD is set; then every /api route except login and me
 * needs the cookie. With login off, a login still records a name so the ledger can say who did what.
 */
export const COOKIE = 'wowf_session';
export const SESSION_DAYS = 90;
const SESSION_MS = SESSION_DAYS * 86_400_000;
/** The name actions carry when login is off and nobody gave one. */
export const LOCAL_USER = 'local';

export interface AuthConfig { password?: string | null; secret?: string | null }

export interface Auth {
  required: boolean;
  sign(username: string, now?: number): string;
  verify(token: string | null | undefined, now?: number): string | null;
  checkPassword(p: string): boolean;
  /** The username on the request's cookie, or null. */
  userOf(cookieHeader: string | undefined, now?: number): string | null;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function makeAuth(cfg: AuthConfig = {}): Auth {
  const password = cfg.password || null;
  // SESSION_SECRET when set. Otherwise derived from the password, so changing the password ends every session.
  // With neither, a random secret per process: names last until a restart, which is fine for local mode.
  const secret = cfg.secret || (password ? createHash('sha256').update(`wowf-session:${password}`).digest('hex') : randomBytes(32).toString('hex'));
  const mac = (body: string) => createHmac('sha256', secret).update(body).digest('base64url');
  const sign = (username: string, now = Date.now()) => { const body = `${b64u(username)}.${now + SESSION_MS}`; return `${body}.${mac(body)}`; };
  const verify = (token: string | null | undefined, now = Date.now()): string | null => {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [u, exp, sig] = parts as [string, string, string];
    const want = Buffer.from(mac(`${u}.${exp}`));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (!/^\d+$/.test(exp) || Number(exp) <= now) return null;
    const name = Buffer.from(u, 'base64url').toString('utf8');
    return cleanName(name);
  };
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return {
    required: !!password,
    sign, verify,
    checkPassword: p => !password || timingSafeEqual(digest(p), digest(password)),
    userOf: (h, now) => verify(readCookie(h, COOKIE), now),
  };
}

/** Free text, trimmed, 1 to 32 characters, no control characters. null when nothing usable is left. */
export function cleanName(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  return t || null;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isHttps = (req: FastifyRequest) => req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https';
function cookieHeader(req: FastifyRequest, value: string, maxAgeSec: number) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

declare module 'fastify' { interface FastifyRequest { user: string | null } }

/** The username a write records: the cookie's name, or "local" when login is off and nobody signed in. */
export const actor = (req: FastifyRequest) => req.user ?? LOCAL_USER;

export function registerAuth(app: FastifyInstance, auth: Auth): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.user = auth.userOf(req.headers.cookie);
    const path = req.url.split('?')[0]!;
    if (!auth.required || !path.startsWith('/api/') || path === '/api/login' || path === '/api/me') return;
    if (!req.user) return reply.code(401).send({ error: 'Sign in first.', login: true });
  });

  app.post<{ Body: { username?: unknown; password?: unknown } }>('/api/login', async (req, reply) => {
    const name = cleanName(req.body?.username);
    if (!name) return reply.code(400).send({ error: 'Type a name.' });
    if (!auth.checkPassword(typeof req.body?.password === 'string' ? req.body.password : '')) return reply.code(401).send({ error: 'Wrong password.' });
    reply.header('set-cookie', cookieHeader(req, auth.sign(name), SESSION_MS / 1000));
    return { ok: true, username: name };
  });
  app.get('/api/me', async req => ({ authRequired: auth.required, username: req.user }));
  app.post('/api/logout', async (req, reply) => {
    reply.header('set-cookie', cookieHeader(req, '', 0));
    return { ok: true };
  });
}
