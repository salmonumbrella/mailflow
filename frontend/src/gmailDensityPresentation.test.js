import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const css = postcss.parse(readFileSync(new URL('gmail-surfaces.css', import.meta.url), 'utf8'));
const gmail = 'html[data-mailflow-layout="gmail"]';
const compact = `${gmail}[data-gmail-density="compact"]`;
const ancestors = rule => {
  const result = [];
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule') result.unshift(`@${parent.name} ${parent.params}`);
  }
  return result;
};
function declarations(selector, within = []) {
  const result = {};
  css.walkRules(rule => {
    if (rule.selectors.includes(selector) && JSON.stringify(ancestors(rule)) === JSON.stringify(within)) {
      rule.walkDecls(decl => { result[decl.prop] = decl.value; });
    }
  });
  return result;
}

test('Gmail authored ordinary/compact desktop baselines account for inner content and padding', () => {
  const ordinary = declarations(gmail);
  const dense = declarations(compact);
  assert.equal(ordinary['--gmail-row-min-height'], '40px');
  assert.equal(ordinary['--gmail-row-padding-y'], '4px');
  assert.equal(ordinary['--gmail-row-content-min-height'], '32px');
  assert.equal(dense['--gmail-row-min-height'], '32px');
  assert.equal(dense['--gmail-row-padding-y'], '0px');
  for (const selector of ['.mailflow-message-row', '.mailflow-thread-message-row']) {
    const row = declarations(`${gmail} ${selector}`);
    assert.equal(row['min-height'], 'var(--gmail-row-min-height)');
    assert.match(row.padding, /^var\(--gmail-row-padding-y\)/);
  }
  assert.equal(declarations(`${gmail} .mailflow-message-list [data-msgid]:has(> .mailflow-message-row)`)['border-bottom'], '0');
  assert.equal(declarations(`${gmail} .mailflow-message-list [data-msgid]:has(> div > .mailflow-message-row)`)['border-bottom'], '0');
  assert.equal(declarations(`${gmail} .mailflow-thread-message-row`)['border-top'], '0');
  for (const selector of ['.mailflow-row-main', '.mailflow-row-content', '.mailflow-thread-message-content']) {
    assert.equal(declarations(`${gmail} ${selector}`)['min-height'], 'var(--gmail-row-content-min-height)');
  }
});

test('Gmail uses the recovered 700px mobile boundary and adapts narrow mail containers', () => {
  const mobile = ['@media (max-width: 700px)'];
  const narrow = ['@container mailflow-list (max-width: 539px)'];
  for (const [selectors, within] of [
    [[gmail, compact], mobile],
    [[`${gmail} .mailflow-message-row`, `${compact} .mailflow-message-row`], narrow],
    [[`${gmail} .mailflow-thread-message-row`, `${compact} .mailflow-thread-message-row`], narrow],
  ]) {
    const ordinary = declarations(selectors[0], within);
    const dense = declarations(selectors[1], within);
    assert.equal(ordinary['--gmail-row-min-height'], '64px');
    assert.equal(ordinary['--gmail-row-padding-y'], '8px');
    assert.equal(ordinary['--gmail-row-content-min-height'], '48px');
    assert.equal(dense['--gmail-row-min-height'], '56px');
    assert.equal(dense['--gmail-row-padding-y'], '4px');
  }
  const wide = ['@media (min-width: 701px)', '@container mailflow-list (min-width: 540px)'];
  assert.match(declarations(`${gmail} .mailflow-row-content`, wide)['grid-template-columns'], /160px/);
  assert.equal(declarations(`${gmail} .mailflow-row-content`)['grid-template-columns'], 'minmax(0, 1fr) minmax(0, 1fr)');
  assert.equal(declarations(`${gmail} .mailflow-row-sender`)['margin-bottom'], '0');
  assert.equal(declarations(`${gmail} .mailflow-row-subject`)['margin-bottom'], '0');
});

test('density is Gmail-only, keeps controls and font scaling, and does not invent comfortable geometry', () => {
  let densityRules = 0;
  css.walkRules(rule => {
    if (rule.selector.includes('data-gmail-density') || rule.nodes.some(node => node.prop?.startsWith('--gmail-row-'))) {
      for (const selector of rule.selectors) assert.ok(selector.startsWith(gmail), selector);
      densityRules += 1;
    }
    assert.doesNotMatch(rule.selector, /data-gmail-density="comfortable"/, 'attachment chips remain a separate prerequisite');
    if (/mailflow-(?:message-row|row-(?:main|content)|thread-message-(?:row|content))/.test(rule.selector)) {
      rule.walkDecls(decl => {
        assert.ok(!['height', 'max-height', 'font-family', 'transform', 'zoom'].includes(decl.prop), `${rule.selector}: ${decl.prop} must not clamp or replace native font scaling`);
        if (decl.prop === 'overflow') assert.notEqual(decl.value, 'hidden');
        if (decl.prop === 'min-height') assert.match(decl.value, /^var\(--gmail-row-(?:content-)?min-height\)$/);
      });
    }
  });
  assert.ok(densityRules >= 6);
  assert.equal(declarations(`${gmail} .mailflow-gmail-row-controls`).height, '32px');
  assert.equal(declarations(`${gmail} .mailflow-gmail-row-controls > button`).height, '32px');
  assert.equal(declarations(`${gmail} .mailflow-gmail-row-controls > input`).height, '16px');
  assert.equal(declarations(`${gmail} :is(.mailflow-message-list, .mailflow-message-toolbar, .compose-window) :is(button, input, select, textarea, [contenteditable="true"]):focus-visible`)['outline-offset'], '-2px');
});
