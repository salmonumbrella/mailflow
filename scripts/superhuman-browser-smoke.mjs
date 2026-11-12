#!/usr/bin/env node
// Optional real-browser check. Requires an existing Playwright install and Chromium.
// No project dependency is added. Does not attach to any signed-in browser/profile.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixtureServer } from './superhuman-fixture-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = path.resolve(option('--output', path.join(root, 'artifacts/superhuman')));
const moduleName = option('--playwright', 'playwright');
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const executablePath = option('--executable', option('--chromium', undefined));
let browser;
const report = { browser: null, viewport: { width: 1440, height: 1000 }, scenarios: [] };
await mkdir(output, { recursive: true });

async function scenario(name, dist, superhuman) {
  const fixture = await createFixtureServer({ dist });
  const address = await fixture.listen(0);
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = await context.newPage();
  const result = { name, dist, errors: [], rejectedExternalRequests: [], screenshots: [], checks: [] };
  report.scenarios.push(result);
  page.on('pageerror', error => result.errors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    result.rejectedExternalRequests.push(route.request().url());
    return route.abort();
  });
  const capture = async view => {
    const filename = `${name}-${view}.png`;
    await page.screenshot({ path: path.join(output, filename), fullPage: false });
    result.screenshots.push(filename);
  };
  try {
    await page.goto(origin);
    await page.getByText('Launch review: final details', { exact: true }).first().waitFor();
    if (superhuman) {
      await page.keyboard.press('Control+k');
      await page.getByRole('option').filter({ hasText: 'Use Superhuman workspace' }).click();
      await page.locator('.superhuman-shell').waitFor();
      result.checks.push('Opted in using native command palette');
    }
    await capture('inbox');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
    await capture('commands');
    await page.keyboard.press('Escape');
    await page.getByText('Launch review: final details', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Reply', exact: true }).waitFor();
    await capture('reading');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).waitFor();
    await capture('reply');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    result.checks.push('Opened native reader and cancelled native reply without delivery');
    if (superhuman) {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      const search = page.locator('.sh-list-search input');
      await search.fill('launch');
      await page.waitForFunction(() => document.querySelectorAll('.sh-mail-row').length === 1);
      await capture('search');
      await search.fill('');
      await page.waitForFunction(() => document.querySelectorAll('.sh-mail-row').length === 5);
      await page.getByRole('button', { name: 'Folders and accounts', exact: true }).click();
      await page.locator('[data-mailbox-row]').filter({ hasText: 'alex@personal.example' }).click();
      await page.getByText('Saturday by the coast', { exact: true }).first().waitFor();
      assert.equal(await page.locator('.sh-mail-row').count(), 1);
      await capture('personal-inbox');
      result.checks.push('Search and account switching use native UI');
      await page.getByRole('button', { name: 'All Inboxes', exact: true }).click();
      await page.getByRole('button', { name: 'Compose', exact: true }).click();
      await page.getByRole('button', { name: 'Discard', exact: true }).waitFor();
      await capture('compose');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      result.checks.push('Opened and cancelled blank compose');
    }
    assert.deepEqual(fixture.state.sent, [], 'no send attempt in the scenario');
    assert.deepEqual(result.errors, [], 'no unhandled browser exceptions');
    result.completed = true;
  } catch (error) {
    result.completed = false;
    result.failure = error.stack;
    throw error;
  } finally {
    result.requests = fixture.state.requests;
    result.mutations = fixture.state.mutations;
    result.deliveryAttempts = fixture.state.sent;
    await context.close();
    await new Promise(resolve => fixture.server.close(resolve));
  }
}
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  report.browser = browser.version();
  const baseline = option('--before', undefined);
  if (baseline) await scenario('before', path.resolve(baseline), false);
  await scenario('after', path.resolve(option('--after', path.join(root, 'frontend/dist'))), true);
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await writeFile(path.join(output, 'browser-smoke-report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
}
