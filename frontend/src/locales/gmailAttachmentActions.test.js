import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import i18next from 'i18next';

const localeDirectory = new URL('./', import.meta.url);
const locales = Object.fromEntries(readdirSync(localeDirectory)
  .filter(name => name.endsWith('.json'))
  .map(name => [name.slice(0, -5), JSON.parse(readFileSync(new URL(name, localeDirectory), 'utf8'))]));

const actionCopy = {
  previewFile: 'Preview {{name}}',
  downloadFile: 'Download {{name}}',
  unavailable: 'This attachment changed or is no longer available. Refresh the list and review it before trying again.',
  tooLarge: 'This attachment is too large to download.',
  failed: 'Could not download this attachment. Try again.',
  retry: 'Try again',
  previewTooLarge: 'This file is too large to preview. You can download it instead.',
};

describe('Gmail attachment action translations', () => {
  it('provides distinct action and recovery copy in every supported locale', () => {
    for (const [key, english] of Object.entries(actionCopy)) {
      assert.equal(locales.en.gmail.attachments[key], english);
      const translations = new Set();
      for (const [language, locale] of Object.entries(locales)) {
        const value = locale.gmail.attachments[key];
        assert.equal(typeof value, 'string', `${language} is missing ${key}`);
        assert.ok(value.trim(), `${language} has an empty ${key}`);
        assert.ok(!translations.has(value), `${language} repeats an untranslated ${key}`);
        translations.add(value);
        const placeholders = value.match(/{{.*?}}/g) || [];
        assert.deepEqual(placeholders, key.endsWith('File') ? ['{{name}}'] : [],
          `${language} changes ${key} placeholders`);
      }
    }
  });

  for (const [language, locale] of Object.entries(locales)) {
    it(`${language} renders filename actions and recovery text without English fallback`, async () => {
      const instance = i18next.createInstance();
      await instance.init({
        lng: language,
        fallbackLng: false,
        resources: { [language]: { translation: locale } },
        interpolation: { escapeValue: false },
      });

      const name = 'Quarterly report <final> & résumé.pdf';
      for (const key of Object.keys(actionCopy)) {
        const translationKey = `gmail.attachments.${key}`;
        assert.equal(instance.exists(translationKey), true, `${language} cannot resolve ${key}`);
        const expected = locale.gmail.attachments[key].replace('{{name}}', name);
        const rendered = instance.t(translationKey, { name });
        assert.equal(rendered, expected);
        assert.doesNotMatch(rendered, /{{|}}/, `${language} leaves a raw placeholder in ${key}`);
      }
    });
  }

  it('does not claim enabled attachment previews are unavailable in quick settings', () => {
    assert.equal(locales.en.gmail.quick_settings.density_note,
      'Default and Comfortable currently use the same row spacing.');
  });
});
