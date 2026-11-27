import { createHash } from 'node:crypto';

/**
 * A fake GitHub REST API behind a mocked fetch, following the endpoints src/cloud/githubStore.ts and githubApi.ts
 * assume (their header comments). It keeps what was uploaded, so tests can look at the stored bytes, and it can be
 * told to answer conflicts and rate limits.
 */
export const REPO = 'chip/gold';
interface Asset { id: number; name: string; size: number; state: string; updated_at: string; bytes: Uint8Array }
interface Run { id: number; status: string; conclusion: string | null; event: string; created_at: string; html_url: string }

export function fakeGitHub(o: { token?: string } = {}) {
  const token = o.token ?? 'ghp_test';
  let nextId = 100;
  const releases: Array<{ id: number; tag: string; assets: Map<number, Asset> }> = [];
  const files = new Map<string, { sha: string; bytes: Uint8Array }>();
  const branches = new Set(['main']);
  const trees = new Map<string, string[]>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const refs = new Map<string, string>();
  const runs: Run[] = [];
  const calls: string[] = [];
  const knobs = {
    /** The next N contents writes answer 409. */
    conflicts: 0,
    /** Answers to give before the real one, e.g. a rate limit. */
    before: [] as Array<{ status: number; headers?: Record<string, string>; body?: string }>,
    /** What a dispatch does: by default a queued workflow_dispatch run appears. */
    onDispatch: null as null | (() => void),
  };
  const sha = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');
  const res = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(status === 204 || body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const view = (a: Asset) => ({ id: a.id, name: a.name, size: a.size, state: a.state, updated_at: a.updated_at });

  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${u.host === 'uploads.github.com' ? 'uploads:' : ''}${u.pathname}${u.search}`);
    const h = new Headers(init.headers);
    if (h.get('authorization') !== `Bearer ${token}`) return res(401, { message: 'Bad credentials' });
    const pre = knobs.before.shift();
    if (pre) return res(pre.status, pre.body ?? { message: 'rate limited' }, pre.headers);
    const base = `/repos/${REPO}`;
    if (!u.pathname.startsWith(base)) return res(404, { message: 'Not Found' });
    const p = u.pathname.slice(base.length);
    const body = async () => init.body == null ? null : typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const raw = () => new Uint8Array(init.body as unknown as Uint8Array);
    let m: RegExpExecArray | null;

    if (p === '' && method === 'GET') return res(200, { default_branch: 'main' });
    // Releases
    if ((m = /^\/releases\/tags\/([^/]+)$/.exec(p)) && method === 'GET') {
      const r = releases.find(x => x.tag === decodeURIComponent(m![1]!));
      return r ? res(200, { id: r.id, tag_name: r.tag }) : res(404, { message: 'Not Found' });
    }
    if (p === '/releases' && method === 'POST') {
      const b = await body();
      if (releases.some(x => x.tag === b.tag_name)) return res(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
      const r = { id: nextId++, tag: b.tag_name as string, assets: new Map<number, Asset>() };
      releases.push(r);
      return res(201, { id: r.id, tag_name: r.tag });
    }
    if ((m = /^\/releases\/(\d+)\/assets$/.exec(p))) {
      const r = releases.find(x => x.id === Number(m![1]));
      if (!r) return res(404, { message: 'Not Found' });
      if (method === 'GET') {
        const per = Number(u.searchParams.get('per_page') ?? 30), page = Number(u.searchParams.get('page') ?? 1);
        return res(200, [...r.assets.values()].slice((page - 1) * per, page * per).map(view));
      }
      if (method === 'POST' && u.host === 'uploads.github.com') {
        const name = u.searchParams.get('name')!;
        if ([...r.assets.values()].some(a => a.name === name)) return res(422, { message: 'Validation Failed', errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }] });
        const bytes = raw();
        const a: Asset = { id: nextId++, name, size: bytes.length, state: 'uploaded', updated_at: new Date().toISOString(), bytes };
        r.assets.set(a.id, a);
        return res(201, view(a));
      }
    }
    if ((m = /^\/releases\/assets\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      const r = releases.find(x => x.assets.has(id));
      const a = r?.assets.get(id);
      if (!a) return res(404, { message: 'Not Found' });
      if (method === 'GET') return h.get('accept') === 'application/octet-stream' ? new Response(a.bytes as unknown as BodyInit, { status: 200 }) : res(200, view(a));
      if (method === 'DELETE') { r!.assets.delete(id); return res(204); }
      if (method === 'PATCH') {
        const b = await body();
        if ([...r!.assets.values()].some(x => x.name === b.name && x.id !== id)) return res(422, { message: 'Validation Failed' });
        a.name = b.name; return res(200, view(a));
      }
    }
    // Branches
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(p)) && method === 'GET') return branches.has(m[1]!) ? res(200, { object: { sha: 'abc123' } }) : res(404, { message: 'Not Found' });
    if (p === '/git/trees' && method === 'POST') {
      const b = await body();
      const t = { sha: `tree${nextId++}`, paths: (b.tree as Array<{ path: string }>).map(x => x.path) };
      trees.set(t.sha, t.paths);
      return res(201, { sha: t.sha });
    }
    if (p === '/git/commits' && method === 'POST') {
      const b = await body();
      if (!trees.has(b.tree)) return res(422, { message: 'Tree SHA does not exist' });
      const c = `commit${nextId++}`;
      commits.set(c, { tree: b.tree, parents: b.parents });
      return res(201, { sha: c });
    }
    if (p === '/git/refs' && method === 'POST') {
      const b = await body();
      const name = String(b.ref).replace(/^refs\/heads\//, '');
      if (branches.has(name)) return res(422, { message: 'Reference already exists' });
      branches.add(name); refs.set(String(b.ref), String(b.sha)); return res(201, { ref: b.ref });
    }
    // Contents
    if ((m = /^\/contents\/(.+)$/.exec(p))) {
      const path = decodeURIComponent(m[1]!);
      if (method === 'GET') {
        const ref = u.searchParams.get('ref') ?? 'main';
        if (!branches.has(ref)) return res(404, { message: 'No commit found for the ref' });
        const f = files.get(path);
        if (f) return res(200, { name: path.split('/').pop(), path, sha: f.sha, size: f.bytes.length, type: 'file', encoding: 'base64', content: Buffer.from(f.bytes).toString('base64').replace(/(.{60})/g, '$1\n') });
        const dir = [...files].filter(([k]) => k.startsWith(`${path}/`));
        if (!dir.length) return res(404, { message: 'Not Found' });
        return res(200, dir.map(([k, v]) => ({ name: k.slice(path.length + 1), path: k, sha: v.sha, size: v.bytes.length, type: 'file' })));
      }
      const b = await body();
      if (!branches.has(b.branch)) return res(404, { message: `Branch ${b.branch} not found` });
      if (knobs.conflicts > 0) { knobs.conflicts--; return res(409, { message: `${b.branch} is at 1 but expected 2` }); }
      if (method === 'PUT') {
        if (files.has(path) && files.get(path)!.sha !== b.sha) return res(422, { message: '"sha" wasn\'t supplied.' });
        const bytes = new Uint8Array(Buffer.from(b.content, 'base64'));
        files.set(path, { sha: sha(bytes), bytes });
        return res(201, { content: { path, sha: sha(bytes) } });
      }
      if (method === 'DELETE') {
        const f = files.get(path);
        if (!f) return res(404, { message: 'Not Found' });
        if (f.sha !== b.sha) return res(409, { message: 'sha does not match' });
        files.delete(path); return res(200, { commit: {} });
      }
    }
    // Actions
    if ((m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(p)) && method === 'GET') return res(200, { total_count: runs.length, workflow_runs: [...runs].reverse() });
    if ((m = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p)) && method === 'POST') {
      if (knobs.onDispatch) knobs.onDispatch(); else addRun('queued', 'workflow_dispatch');
      return res(204);
    }
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(p)) && method === 'GET') {
      const r = runs.find(x => x.id === Number(m![1]));
      return r ? res(200, r) : res(404, { message: 'Not Found' });
    }
    return res(404, { message: `fake has no ${method} ${p}` });
  }) as typeof fetch;

  function addRun(status: string, event = 'schedule'): Run {
    const id = nextId++;
    const r: Run = { id, status, conclusion: status === 'completed' ? 'success' : null, event, created_at: new Date().toISOString(), html_url: `https://github.com/${REPO}/actions/runs/${id}` };
    runs.push(r);
    return r;
  }
  const assets = () => releases.flatMap(r => [...r.assets.values()]);
  /** Every byte the fake holds: asset bodies and inbox files. */
  const allBytes = () => [...assets().map(a => a.bytes), ...[...files.values()].map(f => f.bytes)];
  /** The tree paths and parents of a branch made through git/refs. */
  const branchCommit = (name: string) => { const c = commits.get(refs.get(`refs/heads/${name}`) ?? ''); return c && { parents: c.parents, paths: trees.get(c.tree) ?? [] }; };
  return { fetchFn, token, releases, assets, files, branches, runs, calls, knobs, addRun, allBytes, branchCommit };
}
