import { describe, expect, it } from 'vitest';
import { chunkSearchText } from './searchIndex.js';

describe('lexical search chunks', () => {
  it('retains every character and token boundary for generated multilingual bodies', () => {
    let seed = 0x39d7;
    const draw = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const alphabet = ['hello', '世界', 'résumé', '🙂', 'we', 'running', 'a-b.c', ' ', '\n', '\t'];
    for (let run = 0; run < 80; run++) {
      const text = Array.from({ length: 500 + draw(16000) }, () => alphabet[draw(alphabet.length)]).join(' ');
      const chunks = chunkSearchText(text).map(c => c.text);
      expect(chunks.join('')).toBe(text);
      expect(chunks.every(c => [...c].length <= 32768 && c.length > 0)).toBe(true);
      expect(chunks.flatMap(c => c.match(/\S+/gu) || [])).toEqual(text.match(/\S+/gu) || []);
    }
  });

  it('preserves oversized tokens without creating a short searchable suffix', () => {
    for (const [glyph,size] of [['z',32769],['z',65537],['z',100000],['界',65537],['😀',65537]]) {
      const text = glyph.repeat(size) + ' latequartz';
      const chunks = chunkSearchText(text).map(c => c.text);
      expect(chunks.join('')).toBe(text);
      expect(chunks.every(c => [...c].length <= 32768)).toBe(true);
      expect(chunks.slice(0, -1).every(c => c.length > 2048)).toBe(true);
      expect(chunks.every(c => c.isWellFormed())).toBe(true);
      expect(chunks.at(-1)).toBe(' latequartz');
    }
    const compound = 'a'.repeat(32768) + '-foo-bar';
    expect(chunkSearchText(compound).map(c => c.text).join('')).toBe(compound);
    expect(chunkSearchText('')).toEqual([]);
  });
});
