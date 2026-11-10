import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import i18next from 'i18next';

const localeDirectory = new URL('./', import.meta.url);
const locales = Object.fromEntries(readdirSync(localeDirectory)
  .filter(name => name.endsWith('.json'))
  .map(name => [name.slice(0, -5), JSON.parse(readFileSync(new URL(name, localeDirectory), 'utf8'))]));

const recoveryCopy = {
  draftSourceUnavailable: 'This draft could not be verified. Keep your text, then refresh Drafts and review the saved copies before saving or removing it.',
  draftRetainedTitle: 'Original draft kept',
  draftRetainedBody: 'The original draft could not be safely removed. Refresh Drafts and review the saved copies.',
  draftSeparateConfirm: 'Save the current text as a separate draft? Existing saved copies will be kept. Review Drafts afterwards.',
  draftSeparateCopy: 'Save as separate draft',
};

describe('Draft source recovery translations', () => {
  it('covers the recovery keys and defaults actually used by ComposeModal', () => {
    const source = readFileSync(new URL('../components/ComposeModal.jsx', import.meta.url), 'utf8');
    const calls = source.matchAll(/\bt\(\s*['"]compose\.(draft(?:Source|Retained|Separate)\w+)['"],\s*\{\s*defaultValue:\s*(['"])(.*?)\2\s*\}\s*\)/g);
    assert.deepEqual(Object.fromEntries([...calls].map(match => [match[1], match[3]])), recoveryCopy);
  });

  it('provides distinct, placeholder-free recovery copy in every supported locale', () => {
    for (const [key, english] of Object.entries(recoveryCopy)) {
      assert.equal(locales.en.compose[key], english);
      const translations = new Set();
      for (const [language, locale] of Object.entries(locales)) {
        const value = locale.compose[key];
        assert.equal(typeof value, 'string', `${language} is missing ${key}`);
        assert.ok(value.trim(), `${language} has an empty ${key}`);
        assert.ok(!translations.has(value), `${language} repeats an untranslated ${key}`);
        translations.add(value);
        assert.doesNotMatch(value, /{{|}}/, `${language} adds a placeholder to ${key}`);
      }
    }
  });

  for (const [language, locale] of Object.entries(locales)) {
    it(`${language} resolves draft recovery text without English fallback`, async () => {
      const instance = i18next.createInstance();
      await instance.init({
        lng: language,
        fallbackLng: false,
        resources: { [language]: { translation: locale } },
        interpolation: { escapeValue: false },
      });

      for (const key of Object.keys(recoveryCopy)) {
        const translationKey = `compose.${key}`;
        assert.equal(instance.exists(translationKey), true, `${language} cannot resolve ${key}`);
        const rendered = instance.t(translationKey, { returnDetails: true });
        assert.equal(rendered.res, locale.compose[key]);
        assert.equal(rendered.usedLng, language);
      }
    });
  }
});
