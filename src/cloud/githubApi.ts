/**
 * GitHub's REST API with fetch only: the transport for the blob store (src/cloud/githubStore.ts) and the Refresh
 * button's workflow dispatch. Every call sends `Authorization: Bearer <token>`.
 *
 * GitHub's docs could not be reached from the build session (November 27, 2026). The endpoints and answers here are
 * from knowledge of the REST API, version 2022-11-28, and the first real run proves them (docs/verification.md G1 to G7):
 * - Rate limits answer 403 or 429. A primary limit sends x-ratelimit-remaining 0 and x-ratelimit-reset (epoch seconds);
 *   a secondary limit sends retry-after (seconds). A wait of a minute or less is waited out, up to 3 tries; a longer
 *   one is an error that says when to try again.
 * - 5xx answers are retried twice, after 1 and 2 seconds.
 */
export interface GitHubConfig {
  token: string;
  /** owner/name */
  repo: string;
  fetchFn?: typeof fetch;
  api?: string;
  uploads?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class GitHubApiError extends Error {
  constructor(message: string, readonly status: number, readonly rateLimited = false) { super(message); this.name = 'GitHubApiError'; }
}

export interface RequestOpts {
  json?: unknown;
  raw?: Uint8Array;
  contentType?: string;
  accept?: string;
  uploads?: boolean;
  /** Statuses the caller handles itself (404 for missing, 409 for a contents conflict); everything else not 2xx throws. */
  allow?: number[];
}

const MAX_WAIT_MS = 60_000;

export class GitHub {
  readonly repo: string;
  private fetchFn: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private api: string;
  private uploads: string;

  constructor(private cfg: GitHubConfig) {
    if (!cfg.token) throw new Error('GITHUB_TOKEN is missing');
    if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo ?? '')) throw new Error(`GITHUB_REPO must be owner/name, got "${cfg.repo ?? ''}"`);
    this.repo = cfg.repo;
    this.fetchFn = cfg.fetchFn ?? fetch;
    this.sleep = cfg.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.api = cfg.api ?? 'https://api.github.com';
    this.uploads = cfg.uploads ?? 'https://uploads.github.com';
  }

  /** `path` starts with "/repos/{repo}" spelled as "~", e.g. "~/releases/tags/data". */
  async request(method: string, path: string, o: RequestOpts = {}): Promise<Response> {
    const url = `${o.uploads ? this.uploads : this.api}${path.replace(/^~/, `/repos/${this.repo}`)}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.token}`,
      accept: o.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'wowf-gold-finder',
    };
    let body: BodyInit | undefined;
    if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
    else if (o.raw) { headers['content-type'] = o.contentType ?? 'application/octet-stream'; body = o.raw as unknown as BodyInit; }
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchFn(url, { method, headers, body });
      if (res.ok || o.allow?.includes(res.status)) return res;
      const wait = rateLimitWait(res);
      if (wait !== null) {
        if (wait <= MAX_WAIT_MS && attempt < 3) { await res.body?.cancel().catch(() => {}); await this.sleep(wait); continue; }
        const at = new Date(Date.now() + wait).toISOString().slice(11, 16);
        throw new GitHubApiError(`GitHub rate limit on ${method} ${path}: try again after ${at} UTC`, res.status, true);
      }
      if (res.status >= 500 && attempt < 3) { await res.body?.cancel().catch(() => {}); await this.sleep(1000 * attempt); continue; }
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new GitHubApiError(`GitHub ${method} ${path} answered ${res.status}${text ? `: ${text}` : ''}`, res.status);
    }
  }

  async json<T>(method: string, path: string, o: RequestOpts = {}): Promise<{ status: number; body: T | null }> {
    const res = await this.request(method, path, o);
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return { status: res.status, body: null }; }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) as T : null };
  }
}

/** How long a rate limited answer asks to wait, in ms; null when the answer is not a rate limit. */
function rateLimitWait(res: Response): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const after = res.headers.get('retry-after');
  if (after && /^\d+$/.test(after)) return Number(after) * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) ? Math.max(0, reset * 1000 - Date.now()) : MAX_WAIT_MS + 1;
  }
  return res.status === 429 ? MAX_WAIT_MS + 1 : null;
}

/**
 * The Refresh button (brief item 5): start the collect workflow, or join a run that is already queued or running.
 * Endpoints assumed (verification G6):
 * - GET  ~/actions/workflows/{file}/runs?per_page=20  { workflow_runs: [{ id, status, conclusion, event, created_at, html_url }] }
 * - POST ~/actions/workflows/{file}/dispatches  { ref }  answers 204 with no body, so the new run is found by listing
 * - GET  ~/actions/runs/{id}
 */
export interface WorkflowRun { id: number; status: string; conclusion: string | null; event: string; created_at: string; html_url: string }
export const WORKFLOW = 'collect.yml';
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export async function listRuns(gh: GitHub, workflow = WORKFLOW): Promise<WorkflowRun[]> {
  const r = await gh.json<{ workflow_runs: WorkflowRun[] }>('GET', `~/actions/workflows/${workflow}/runs?per_page=20`);
  return r.body?.workflow_runs ?? [];
}

export async function dispatchOrJoin(gh: GitHub, opts: { ref: string; workflow?: string; findTries?: number; findEveryMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<{ joined: boolean; run: WorkflowRun | null; since: number }> {
  const wf = opts.workflow ?? WORKFLOW;
  const before = await listRuns(gh, wf);
  const active = before.find(r => ACTIVE.has(r.status));
  if (active) return { joined: true, run: active, since: Date.parse(active.created_at) };
  const since = Date.now();
  await gh.request('POST', `~/actions/workflows/${wf}/dispatches`, { json: { ref: opts.ref } });
  const seen = new Set(before.map(r => r.id));
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  for (let i = 0; i < (opts.findTries ?? 5); i++) {
    const run = (await listRuns(gh, wf)).find(r => !seen.has(r.id) && r.event === 'workflow_dispatch');
    if (run) return { joined: false, run, since };
    await sleep(opts.findEveryMs ?? 1000);
  }
  return { joined: false, run: null, since };
}

/** One run by id, or (no id) the newest dispatched run created since `since`, with 30 s of clock slack. */
export async function runStatus(gh: GitHub, q: { run?: number; since?: number }, workflow = WORKFLOW): Promise<WorkflowRun | null> {
  if (q.run) return (await gh.json<WorkflowRun>('GET', `~/actions/runs/${q.run}`, { allow: [404] })).body;
  const since = (q.since ?? 0) - 30_000;
  return (await listRuns(gh, workflow)).find(r => Date.parse(r.created_at) >= since) ?? null;
}
