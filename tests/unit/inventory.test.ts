import { describe, it, expect } from 'vitest';
import { parseInventoryLine } from '../../src/craft/inventory.ts';

describe('pasted materials list', () => {
  it.each([
    ['Copper Ore 400', 'Copper Ore', 400], ['Copper Ore: 400', 'Copper Ore', 400], ['Copper Ore x400', 'Copper Ore', 400],
    ['Copper Ore x 400', 'Copper Ore', 400], ['400 Copper Ore', 'Copper Ore', 400], ['400x Copper Ore', 'Copper Ore', 400],
    ['1,200 Rough Stone', 'Rough Stone', 1200], ['Rough Stone 1,200', 'Rough Stone', 1200], ['  Tin Bar   37 ', 'Tin Bar', 37],
  ])('%s', (line, name, count) => expect(parseInventoryLine(line)).toEqual({ name, count }));
  it('ignores blank lines and lines with no number', () => {
    expect(parseInventoryLine('   ')).toBeNull();
    expect(parseInventoryLine('Copper Ore')).toBeNull();
  });
});
