import { describe, it, expect } from 'vitest';
import { parseSkillLineAbility } from '../../src/datasets/recipes.ts';

const CSV = `AbilityVerb_lang,AbilityAllVerb_lang,ID,SkillLine,Spell,MinSkillLineRank,ClassMask,SupercedesSpell,AcquireMethod,TrivialSkillLineRankHigh,TrivialSkillLineRankLow,Flags
,,1631,164,2660,1,0,0,1,55,15,0
,,1600,186,2659,1,0,0,0,115,65,0
,"a, b",69,6,116,1,128,0,0,0,0,0`;

describe('SkillLineAbility thresholds (T3)', () => {
  it('Rough Sharpening Stone reads yellow 15, green 35, grey 55 (real wowf row)', () => {
    expect(parseSkillLineAbility(CSV).get(1631)).toEqual({ yellow: 15, green: 35, grey: 55, minRank: 1 });
  });
  it('Smelt Bronze reads 65, 90, 115 and spells with no thresholds are skipped', () => {
    const m = parseSkillLineAbility(CSV);
    expect(m.get(1600)).toMatchObject({ yellow: 65, green: 90, grey: 115 });
    expect(m.has(69)).toBe(false);
  });
});
