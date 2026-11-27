import { randomBytes } from 'node:crypto';
import type { BlobInfo, BlobStore } from './store.ts';
import type { GitHub } from './githubApi.ts';
import { INBOX_PREFIX } from '../server/ledger.ts';

/**
 * The cloud blob store on GitHub (brief item 3), over the REST API with fetch only (src/cloud/githubApi.ts).
 * - A flat key ("wowf-1795703173000.db.gz", "results.json") is an asset on the release named `data`.
 * - A key under `events/` is a file on the branch `data-inbox`, through the contents API (the site's writes).
 * No lock: the Actions concurrency group serialises the cycle, and the site only adds inbox files.
 *
 * Endpoints assumed from the REST API (2022-11-28); the docs were not reachable from the build session, so the first
 * real run proves them (docs/verification.md G1 to G5):
 * - release      GET ~/releases/tags/data (404 when missing), else POST ~/releases { tag_name, name, prerelease }
 * - assets       GET ~/releases/{id}/assets?per_page=100&page=N  [{ id, name, size, state, updated_at }]
 * - upload       POST https://uploads.github.com/repos/{repo}/releases/{id}/assets?name=NAME  raw body; 422 when NAME exists
 * - download     GET ~/releases/assets/{id} with accept application/octet-stream: a 302 to a storage host that fetch
 *                follows, dropping the Authorization header on the cross origin hop (the fetch standard)
 * - rename       PATCH ~/releases/assets/{id} { name }
 * - delete       DELETE ~/releases/assets/{id}  204
 * - inbox list   GET ~/contents/events?ref=data-inbox  [{ name, path, sha, size, type }]; 404 when empty or no branch
 * - inbox file   GET ~/contents/{path}?ref=data-inbox  { content (base64), sha }
 * - inbox add    PUT ~/contents/{path} { message, content, branch }  201; 409 when the branch moved under it (retried);
 *                404 or 422 when the branch does not exist yet (created from the default branch, then retried)
 * - inbox remove DELETE ~/contents/{path} { message, sha, branch }
 * - branch       POST ~/git/trees { tree: [README] }, POST ~/git/commits { message, tree, parents: [] }, then
 *                POST ~/git/refs { ref: refs/heads/data-inbox, sha }: an orphan, 422 when it exists
 */
export const RELEASE_TAG = 'data';
export const INBOX_BRANCH = 'data-inbox';
export { INBOX_PREFIX };
const ASSET_NAME = /^[A-Za-z0-9._-]+$/;
const INBOX_KEY = /^events\/[A-Za-z0-9._-]+$/;

interface Asset { id: number; name: string; size: number; state?: string; updated_at?: string }
interface ContentEntry { name: string; path: string; sha: string; size: number; type: string }

export interface GitHubStoreOptions { tag?: string; branch?: string; sleep?: (ms: number) => Promise<void>; conflictTries?: number }

export class GitHubStore implements BlobStore {
  private releaseId: number | null = null;
  private assets: Map<string, Asset> | null = null;
  private shas = new Map<string, string>();
  private tag: string;
  private branch: string;
  private sleep: (ms: number) => Promise<void>;

  constructor(private gh: GitHub, private opts: GitHubStoreOptions = {}) {
    this.tag = opts.tag ?? RELEASE_TAG;
    this.branch = opts.branch ?? INBOX_BRANCH;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  // --- release assets -------------------------------------------------------------------------------------------

  private async release(): Promise<number> {
    if (this.releaseId) return this.releaseId;
    let r = await this.gh.json<{ id: number }>('GET', `~/releases/tags/${this.tag}`, { allow: [404] });
    if (!r.body) {
      const made = await this.gh.json<{ id: number }>('POST', '~/releases', { allow: [422], json: {
        tag_name: this.tag, name: this.tag, prerelease: true, make_latest: 'false',
        body: 'Encrypted data for Gold Finder, written by the hourly job. Do not edit or delete.' } });
      r = made.body ? made : await this.gh.json<{ id: number }>('GET', `~/releases/tags/${this.tag}`); // 422: made meanwhile
    }
    this.releaseId = r.body!.id;
    return this.releaseId;
  }

  private async loadAssets(): Promise<Map<string, Asset>> {
    const id = await this.release();
    const m = new Map<string, Asset>();
    for (let page = 1; ; page++) {
      const r = await this.gh.json<Asset[]>('GET', `~/releases/${id}/assets?per_page=100&page=${page}`);
      const rows = r.body ?? [];
      // A failed upload can leave an asset that is not "uploaded"; it is not readable, so it is not listed.
      for (const a of rows) if (!a.state || a.state === 'uploaded') m.set(a.name, a);
      if (rows.length < 100) break;
    }
    this.assets = m;
    return m;
  }

  private async upload(name: string, body: Uint8Array, contentType: string): Promise<Asset | null> {
    const id = await this.release();
    const r = await this.gh.json<Asset>('POST', `/repos/${this.gh.repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
      { uploads: true, raw: body, contentType, allow: [422] });
    return r.body; // null: 422, the name exists
  }

  private async deleteAsset(id: number): Promise<void> {
    await (await this.gh.request('DELETE', `~/releases/assets/${id}`, { allow: [404] })).body?.cancel().catch(() => {});
  }

  // --- inbox files ----------------------------------------------------------------------------------------------

  private contentsPath(key: string) { return `~/contents/${key.split('/').map(encodeURIComponent).join('/')}`; }

  /**
   * The inbox branch, made on the first write as an orphan: one commit with only a README, no parent. Its tree holds
   * no workflow files, so creating it needs Contents write only, never the Workflows permission a branch made from
   * main could need (verification G14), and no workflow or deploy ever runs from it.
   */
  private async ensureBranch(): Promise<void> {
    const tree = await this.gh.json<{ sha: string }>('POST', '~/git/trees', { json: { tree: [{ path: 'README.md', mode: '100644', type: 'blob',
      content: 'Encrypted inbox for Gold Finder: the site saves writes here and the hourly job applies them. Do not edit.\n' }] } });
    const commit = await this.gh.json<{ sha: string }>('POST', '~/git/commits', { json: { message: 'inbox', tree: tree.body!.sha, parents: [] } });
    await (await this.gh.request('POST', '~/git/refs', { allow: [422], json: { ref: `refs/heads/${this.branch}`, sha: commit.body!.sha } })).body?.cancel().catch(() => {});
  }

  /** A contents write, retried on 409 (another commit landed on the branch first) with a growing pause. */
  private async contentsWrite(method: 'PUT' | 'DELETE', key: string, json: Record<string, unknown>): Promise<void> {
    let madeBranch = false;
    const tries = this.opts.conflictTries ?? 5;
    for (let i = 1; ; i++) {
      const res = await this.gh.request(method, this.contentsPath(key), { json: { ...json, branch: this.branch }, allow: [404, 409, 422] });
      const status = res.status;
      const text = res.ok ? '' : await res.text().catch(() => '');
      if (res.ok) { await res.body?.cancel().catch(() => {}); return; }
      if (method === 'DELETE' && status === 404) return;
      if (status === 409 && i < tries) { await this.sleep(250 * i + Math.floor(Math.random() * 250)); continue; }
      if ((status === 404 || (status === 422 && /branch/i.test(text))) && method === 'PUT' && !madeBranch) { await this.ensureBranch(); madeBranch = true; continue; }
      throw new Error(`GitHub contents ${method} ${key} answered ${status}: ${text.slice(0, 200)}`);
    }
  }

  // --- BlobStore ------------------------------------------------------------------------------------------------

  async list(prefix: string): Promise<BlobInfo[]> {
    if (prefix.startsWith(INBOX_PREFIX)) {
      const r = await this.gh.json<ContentEntry[]>('GET', `~/contents/events?ref=${encodeURIComponent(this.branch)}`, { allow: [404] });
      const rows = (r.body ?? []).filter(e => e.type === 'file').map(e => ({ ...e, key: `${INBOX_PREFIX}${e.name}` })).filter(e => e.key.startsWith(prefix));
      for (const e of rows) this.shas.set(e.key, e.sha);
      return rows.map(e => ({ key: e.key, size: e.size, etag: e.sha, updatedAt: null })).sort((a, b) => a.key.localeCompare(b.key));
    }
    const m = await this.loadAssets();
    return [...m.values()].filter(a => a.name.startsWith(prefix))
      .map(a => ({ key: a.name, size: a.size, etag: String(a.id), updatedAt: a.updated_at ? Date.parse(a.updated_at) : null }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string | null } | null> {
    if (key.startsWith(INBOX_PREFIX)) {
      if (!INBOX_KEY.test(key)) throw new Error(`bad inbox key: ${key}`);
      const r = await this.gh.json<{ content: string; sha: string }>('GET', `${this.contentsPath(key)}?ref=${encodeURIComponent(this.branch)}`, { allow: [404] });
      if (!r.body) return null;
      this.shas.set(key, r.body.sha);
      return { body: new Uint8Array(Buffer.from(r.body.content, 'base64')), etag: r.body.sha };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const assets = attempt === 0 && this.assets ? this.assets : await this.loadAssets();
      const a = assets.get(key);
      if (!a) { if (attempt === 0 && this.assets) continue; return null; }
      const res = await this.gh.request('GET', `~/releases/assets/${a.id}`, { accept: 'application/octet-stream', allow: [404] });
      if (res.status === 404) { await res.body?.cancel().catch(() => {}); continue; } // replaced since the listing
      return { body: new Uint8Array(await res.arrayBuffer()), etag: String(a.id) };
    }
    return null;
  }

  /**
   * An inbox key adds a file (event names are unique, so there is never an older one to replace). An asset is
   * uploaded under its name; when the name exists, the new bytes go up under a temporary name first, then the old
   * asset is deleted and the new one renamed, so the old copy stays readable until the new one is complete.
   */
  async put(key: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    if (key.startsWith(INBOX_PREFIX)) {
      if (!INBOX_KEY.test(key)) throw new Error(`bad inbox key: ${key}`);
      await this.contentsWrite('PUT', key, { message: `inbox ${key.slice(INBOX_PREFIX.length)}`, content: Buffer.from(body).toString('base64') });
      return;
    }
    if (!ASSET_NAME.test(key)) throw new Error(`bad asset name: ${key}`);
    const assets = this.assets ?? await this.loadAssets();
    if (!assets.has(key)) {
      const made = await this.upload(key, body, contentType);
      if (made) { assets.set(key, made); return; }
      await this.loadAssets(); // 422: it exists after all (listed before an upload finished); replace it below
    }
    const old = this.assets!.get(key);
    const tmp = `${key}.${randomBytes(4).toString('hex')}.new`;
    const made = await this.upload(tmp, body, contentType);
    if (!made) throw new Error(`GitHub refused the upload of ${tmp}`);
    if (old) await this.deleteAsset(old.id);
    const renamed = await this.gh.json<Asset>('PATCH', `~/releases/assets/${made.id}`, { json: { name: key } });
    this.assets!.delete(tmp);
    this.assets!.set(key, renamed.body ?? { ...made, name: key });
  }

  async delete(key: string): Promise<void> {
    if (key.startsWith(INBOX_PREFIX)) {
      let sha = this.shas.get(key);
      if (!sha) { const got = await this.get(key); if (!got) return; sha = got.etag!; }
      await this.contentsWrite('DELETE', key, { message: `applied ${key.slice(INBOX_PREFIX.length)}`, sha });
      this.shas.delete(key);
      return;
    }
    const assets = this.assets ?? await this.loadAssets();
    const a = assets.get(key);
    if (!a) return;
    await this.deleteAsset(a.id);
    assets.delete(key);
  }
}
