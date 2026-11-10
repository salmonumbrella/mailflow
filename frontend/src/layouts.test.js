// Run with: node --test src/layouts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, DEFAULT_LAYOUT, normalizeLayout, applyLayout } from './layouts.js';

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
  it('keeps the original full-width preset alongside the optional presentation presets', () => {
    assert.equal(normalizeLayout('list'), 'list');
    assert.deepEqual(Object.keys(LAYOUTS).filter(k => LAYOUTS[k].listFirst), ['list', 'gmail']);
    assert.equal(LAYOUTS.list.listWidth, null, 'no fixed list width: the list takes the content area');
  });
});


describe('Gmail layout', () => {
  it('is an opt-in list-first preset without changing the default', () => {
    assert.equal(DEFAULT_LAYOUT, 'comfortable');
    assert.equal(normalizeLayout('gmail'), 'gmail');
    assert.equal(LAYOUTS.gmail.listFirst, true);
    assert.equal(LAYOUTS.gmail.listWidth, null);
    assert.equal(LAYOUTS.gmail.direction, 'row');
  });

  it('applies the scoped appearance hook and removes it when another layout is selected', () => {
    const previousDocument = globalThis.document;
    const attributes = new Map();
    const properties = new Map();
    globalThis.document = {
      documentElement: {
        setAttribute: (name, value) => attributes.set(name, value),
        style: { setProperty: (name, value) => properties.set(name, value) },
      },
    };
    try {
      applyLayout('gmail');
      assert.equal(attributes.get('data-mailflow-layout'), 'gmail');
      assert.equal(properties.get('--layout-row-py'), '10px');
      assert.equal(properties.get('--layout-row-px'), '16px');
      applyLayout('wide', 620);
      assert.equal(attributes.get('data-mailflow-layout'), 'wide');
      assert.equal(properties.get('--list-width'), '620px');
      applyLayout('gmail');
      applyLayout('removed-layout');
      assert.equal(attributes.get('data-mailflow-layout'), DEFAULT_LAYOUT);
      assert.equal(properties.get('--list-width'), '360px');
    } finally {
      globalThis.document = previousDocument;
    }
  });
});
