import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { BlobInfo, BlobStore } from './store.ts';

/**
 * Everything the cloud stores is sealed with AES-256-GCM (Chip's repository is public, so release assets and the
 * data-inbox branch are world readable). The key is DATA_KEY: 32 random bytes in base64, the same value in the
 * repository secret and in Vercel. Without it cloud mode refuses to start (fail closed).
 *
 * Sealed layout: "WFE1" (4 bytes) | IV (12 bytes) | ciphertext | GCM tag (16 bytes). A wrong key or any changed byte
 * fails the tag check, so a tampered file is an error, never wrong data. The object's name is the GCM additional
 * data, so each sealed file opens only under its own name: a copy saved under another name (a replayed inbox event)
 * fails the tag check too (verification G13).
 */
const MAGIC = Buffer.from('WFE1');
const IV = 12, TAG = 16;

export function dataKey(env: Record<string, string | undefined>): Buffer {
  const raw = env.DATA_KEY?.trim();
  if (!raw) throw new Error('DATA_KEY is missing. Cloud mode stores only encrypted data, so it will not start without it (docs/setup-online.md).');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`DATA_KEY must be 32 bytes in base64 (it decodes to ${key.length}). Make one with: openssl rand -base64 32`);
  return key;
}

/** `name` is bound to the ciphertext: unseal must be given the same name. */
export function seal(plain: Uint8Array, key: Buffer, name = ''): Uint8Array {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name, 'utf8'));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, iv, body, c.getAuthTag()]));
}

export function unseal(sealed: Uint8Array, key: Buffer, name = ''): Uint8Array {
  const b = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (b.length < MAGIC.length + IV + TAG || !b.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed Gold Finder file');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(4, 4 + IV));
  d.setAuthTag(b.subarray(b.length - TAG));
  d.setAAD(Buffer.from(name, 'utf8'));
  try { return new Uint8Array(Buffer.concat([d.update(b.subarray(4 + IV, b.length - TAG)), d.final()])); }
  catch { throw new Error('could not decrypt: wrong DATA_KEY, a changed file or a file copied under another name'); }
}

/** A store whose every object is sealed under its key on the way in and checked on the way out. Names and sizes stay visible. */
export class SealedStore implements BlobStore {
  constructor(readonly inner: BlobStore, private key: Buffer) {}
  async get(key: string) { const r = await this.inner.get(key); return r && { ...r, body: unseal(r.body, this.key, key) }; }
  put(key: string, body: Uint8Array) { return this.inner.put(key, seal(body, this.key, key), 'application/octet-stream'); }
  delete(key: string) { return this.inner.delete(key); }
  list(prefix: string): Promise<BlobInfo[]> { return this.inner.list(prefix); }
}
