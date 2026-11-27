import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { suspectKey } from '../../src/engine/engine.ts';
import { refusedList, REFUSED_KV } from '../../src/server/ledger.ts';
import { openDb, setKv } from '../../src/store/db.ts';
import { INBOX_PREFIX } from '../../src/cloud/githubStore.ts';

describe('suspected bug dedupe key', () => {
  it('drops counts and percentages, keeps the house and check', () => {
    expect(suspectKey('house 111 auctions: 45% of listings vanished in one hour, not counted as sales'))
      .toBe(suspectKey('house 111 auctions: 38% of listings vanished in one hour, not counted as sales'));
    expect(suspectKey('house 111 auctions: rows fell from 900 to 12')).toBe(suspectKey('house 111 auctions: rows fell from 850 to 40'));
    expect(suspectKey('house 111 auctions: zero listings')).not.toBe(suspectKey('house 116 auctions: zero listings'));
  });
});

describe('one owner for the refused list', () => {
  it('reads kv inbox_refused, and an empty or broken value is an empty list', () => {
    const db = openDb('/tmp', ':memory:');
    expect(refusedList(db)).toEqual([]);
    setKv(db, REFUSED_KV, JSON.stringify([{ key: 'events/a.json', reason: 'No such flip.' }]));
    expect(refusedList(db)[0]!.reason).toBe('No such flip.');
    setKv(db, REFUSED_KV, '{broken');
    expect(refusedList(db)).toEqual([]);
    expect(INBOX_PREFIX).toBe('events/');
  });
});

describe('pages show the server error', () => {
  it('api() throws the body error text, and Flips shows it', () => {
    expect(readFileSync('web/src/lib/api.ts', 'utf8')).toMatch(/b\?\.error/);
    expect(readFileSync('web/src/pages/flips.tsx', 'utf8')).toMatch(/\(error as Error\)\.message/);
  });
});
