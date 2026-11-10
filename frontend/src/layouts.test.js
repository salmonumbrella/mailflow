// Run with: node --test src/layouts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, DEFAULT_LAYOUT, normalizeLayout } from './layouts.js';

describe('normalizeLayout', () => {
  it('passes through every currently-valid preset key', () => {
    for (const key of Object.keys(LAYOUTS)) {
      assert.equal(normalizeLayout(key), key);
    }
  });

  it('coerces removed/legacy presets to the default (#207)', () => {
    for (const stale of ['classic', 'wide_reader', 'wide_list']) {
      assert.equal(normalizeLayout(stale), DEFAULT_LAYOUT);
    }
  });

  it('coerces unknown, empty, null, and undefined keys to the default', () => {
    assert.equal(normalizeLayout('nonsense'), DEFAULT_LAYOUT);
    assert.equal(normalizeLayout(''), DEFAULT_LAYOUT);
    assert.equal(normalizeLayout(null), DEFAULT_LAYOUT);
    assert.equal(normalizeLayout(undefined), DEFAULT_LAYOUT);
  });

  it('has a default that is itself a valid preset', () => {
    assert.ok(LAYOUTS[DEFAULT_LAYOUT], 'DEFAULT_LAYOUT must exist in LAYOUTS');
  });
});

// #596: List first is a full-width list with no reading pane beside it.
describe('List first', () => {
  it('shares list-first navigation with the opt-in Superhuman workspace', () => {
    assert.equal(normalizeLayout('list'), 'list');
    assert.deepEqual(Object.keys(LAYOUTS).filter(k => LAYOUTS[k].listFirst), ['list', 'superhuman']);
    assert.equal(LAYOUTS.list.listWidth, null, 'no fixed list width: the list takes the content area');
  });
});


describe('Superhuman workspace', () => {
  it('is an opt-in compact list-first layout without a fixed list width', () => {
    assert.notEqual(DEFAULT_LAYOUT, 'superhuman');
    assert.equal(normalizeLayout('superhuman'), 'superhuman');
    assert.equal(LAYOUTS.superhuman.listFirst, true);
    assert.equal(LAYOUTS.superhuman.listWidth, null);
    assert.equal(LAYOUTS.superhuman.direction, 'row');
    assert.ok(LAYOUTS.superhuman.rowPy < LAYOUTS.list.rowPy);
  });
});
