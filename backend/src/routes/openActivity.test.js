import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
vi.mock('../services/openActivity.js', () => ({ listOpenActivity: vi.fn(async () => []), messageOpenActivity: vi.fn(async () => null), recordOpenActivity: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [{ id: 'owner' }] })) }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
import router, { createOpenActivityPixelHandler, OPEN_ACTIVITY_GIF } from './openActivity.js';
import { listOpenActivity, messageOpenActivity } from '../services/openActivity.js';

const token = 'a'.repeat(43);
const direct = (handler, url, method = 'GET') => {
  const headers = {};
  const res = { set: values => Object.assign(headers, values), end: vi.fn() };
  handler({ url, method, get ip() { throw new Error('IP read'); }, get headers() { throw new Error('headers read'); }, get session() { throw new Error('session read'); } }, res);
  return { headers, res };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('cookie-free public image handler', () => {
  it('uniformly answers malformed, expired/unknown, query, method and valid requests without visitor data', async () => {
    const record = vi.fn(async () => {});
    const handler = createOpenActivityPixelHandler({ record });
    const responses = ['', '/%E0%A4%A.gif', '/short.gif', `/${token}.gif`, `/${token}.gif?email=somebody`, '/../../private', `/${'b'.repeat(43)}.gif`].map(path => direct(handler, path));
    responses.push(direct(handler, `/${token}.gif`, 'POST'));
    responses.push(direct(handler, `/${token}.gif`, 'HEAD'));
    for (const { headers, res } of responses) {
      expect(res.statusCode).toBe(200); expect(res.end).toHaveBeenCalledWith(OPEN_ACTIVITY_GIF);
      expect(headers).toEqual(responses[0].headers); expect(headers['Set-Cookie']).toBeUndefined();
    }
    await flush(); expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.every(args => args.length === 1)).toBe(true);
  });
  it('caps concurrency, duplicate tokens, rate and memory without delaying the image', async () => {
    let time = 100_000;
    let resolve;
    const record = vi.fn(() => new Promise(done => { resolve = done; }));
    const handler = createOpenActivityPixelHandler({ record, now: () => time });
    for (let i = 0; i < 20; i++) direct(handler, `/${String(i).padStart(43, 'a')}.gif`);
    await flush(); expect(record).toHaveBeenCalledTimes(4);
    resolve(); await flush();
    const fast = vi.fn(async () => {});
    const bounded = createOpenActivityPixelHandler({ record: fast, now: () => time });
    for (let i = 0; i < 150; i++) { direct(bounded, `/${String(i).padStart(43, 'a')}.gif`); await flush(); }
    expect(fast).toHaveBeenCalledTimes(120);
    time += 60_001; direct(bounded, `/${token}.gif`); await flush();
    expect(fast).toHaveBeenCalledTimes(121);
    direct(bounded, `/${token}.gif`); await flush(); expect(fast).toHaveBeenCalledTimes(121);
  });
  it('swallows database failures with the identical response', async () => {
    const handler = createOpenActivityPixelHandler({ record: vi.fn(async () => { throw new Error('DB down'); }) });
    expect(direct(handler, `/${token}.gif`).res.statusCode).toBe(200); await flush();
  });
});

let server, base, sessions = 0;
beforeAll(async () => {
  const app = express();
  app.use('/api/open-activity/pixel', createOpenActivityPixelHandler({ record: async () => {} }));
  app.use((req, res, next) => { sessions++; req.session = req.get('x-owner') ? { userId: req.get('x-owner') } : {}; next(); });
  app.use('/api/open-activity', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/open-activity`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
it('the real public mount never reaches session middleware, including malformed percent escapes', async () => {
  const before = sessions;
  for (const suffix of [`/${token}.gif`, '/%E0%A4%A.gif', '/unknown.gif']) {
    const response = await fetch(`${base}/pixel${suffix}`);
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(OPEN_ACTIVITY_GIF);
    expect(response.headers.has('set-cookie')).toBe(false);
  }
  expect(sessions).toBe(before);
});
it('private APIs require authentication and take ownership only from session, never a query owner', async () => {
  expect((await fetch(base)).status).toBe(401);
  const account = '22222222-2222-4222-8222-222222222222';
  const response = await fetch(`${base}?accountId=${account}&userId=other`, { headers: { 'x-owner': 'owner' } });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(listOpenActivity).toHaveBeenLastCalledWith('owner', account);
  await fetch(`${base}/message/33333333-3333-4333-8333-333333333333`, { headers: { 'x-owner': 'owner' } });
  expect(messageOpenActivity).toHaveBeenLastCalledWith('owner', '33333333-3333-4333-8333-333333333333');
  expect((await fetch(`${base}?accountId[]=x`, { headers: { 'x-owner': 'owner' } })).status).toBe(400);
});
