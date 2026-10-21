import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import i18next from 'i18next';

const resources = Object.fromEntries(readdirSync(new URL('.', import.meta.url))
  .filter(name => name.endsWith('.json')).map(name => [name.slice(0, -5), {
    translation: JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')),
  }]));
const i18n = i18next.createInstance();
await i18n.init({ lng: 'en', fallbackLng: false, resources });
const examples = {
  en: ['Expand conversation', 'Collapse conversation', ['messages', 'messages', 'messages', 'messages']],
  cs: ['Rozbalit konverzaci', 'Sbalit konverzaci', ['zprávy', 'zpráv', 'zpráv', 'zpráv']],
  pl: ['Rozwiń konwersację', 'Zwiń konwersację', ['wiadomości', 'wiadomości', 'wiadomości', 'wiadomości']],
  ru: ['Развернуть переписку', 'Свернуть переписку', ['сообщения', 'сообщений', 'сообщения', 'сообщений']],
};
for (const [lng, [expand, collapse, nouns]] of Object.entries(examples)) {
  test(`${lng}: plural forms and count interpolation describe both actions`, () => {
    for (const [index, count] of [2, 5, 22, 107].entries()) {
      for (const [action, verb] of [['expand', expand], ['collapse', collapse]]) {
        assert.equal(i18n.t(`messageList.${action}Conversation`, { lng, count }), `${verb} (${count} ${nouns[index]})`);
      }
    }
  });
}

test('every locale provides its plural forms and interpolates counts without fallback', () => {
  for (const [lng, { translation }] of Object.entries(resources)) {
    const locale = lng === 'zhCN' ? 'zh-CN' : lng === 'ptBR' ? 'pt-BR' : lng;
    for (const action of ['expand', 'collapse']) {
      const key = `${action}Conversation`;
      for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
        assert.equal(typeof translation.messageList[`${key}_${category}`], 'string', `${lng}: ${key}_${category}`);
      }
      for (const count of [1, 2, 5, 22, 107, 10000]) {
        const label = i18n.t(`messageList.${key}`, { lng, count });
        assert.ok(label.includes(String(count)), `${lng}: ${label}`);
        assert.ok(!label.includes('{{') && !label.includes('messageList.'), `${lng}: ${label}`);
      }
    }
  }
});
