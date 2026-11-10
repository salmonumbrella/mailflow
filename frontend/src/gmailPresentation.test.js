import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

for (const filename of ['gmail-layout.css', 'gmail-surfaces.css']) {
  const css = postcss.parse(readFileSync(new URL(filename, import.meta.url), 'utf8'));
  test(`${filename} cannot style any non-Gmail presentation`, () => {
    let rules = 0;
    css.walkRules(rule => {
      for (const selector of rule.selectors) {
        assert.ok(selector.startsWith('html[data-mailflow-layout="gmail"]'), `${filename}: unscoped selector ${selector}`);
      }
      rules += 1;
    });
    assert.ok(rules > 0);
  });

  test(`${filename} does not override mail or GTD visibility and pointer behavior`, () => {
    css.walkDecls(decl => {
      assert.notEqual(decl.prop, 'pointer-events', `${filename}: presentation must not intercept interactions`);
      assert.notEqual(decl.prop, 'visibility', `${filename}: presentation must not hide native controls`);
      if (decl.prop === 'display') assert.notEqual(decl.value, 'none', `${filename}: presentation must not remove native controls`);
    });
  });
}
