import { describe, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { hydrateCachedAttachmentMetadata, normalizeCachedAttachmentMetadata } from './messageAttachmentReadModel.js';

const source = { messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222',
  storageGeneration: '33333333-3333-4333-8333-333333333333', entityId: '44444444-4444-4444-8444-444444444444',
  folder: 'INBOX', uidValidity: '10', uid: '7' };
const message = { id: source.messageId, account_id: source.accountId, storage_generation: source.storageGeneration,
  entity_id: source.entityId, folder: source.folder, uid_validity: source.uidValidity, uid: source.uid, has_attachments: true };
const pdf = { part: '2', filename: 'Actual report.pdf', type: 'application/pdf', size: 500, disposition: 'attachment' };
const metadata = entries => normalizeCachedAttachmentMetadata(source, { entries, cached_count: entries.length });

describe('bounded cached attachment projection', () => {
  it('keeps actual names and part references, whitelists fields, and never claims complete or exact sizes', () => {
    const result = metadata([{ ...pdf, content: 'SECRET', contentBase64: 'SECRET', url: 'https://secret.test/',
      body_html: 'SECRET', contains: [{ filename: 'inner.exe' }], source: { messageId: 'spoofed' } }]);
    expect(result).toEqual({ state: 'partial', scope: 'message', source, items: [
      { part: '2', filename: 'Actual report.pdf', type: 'application/pdf', size: 500 },
    ], omittedCount: 0, providerComplete: false, inlineClassification: 'partial', sizeIsExact: false });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('spoofed');
  });

  it('filters known inline and calendar entries regardless of misleading MIME parameters or filename case', () => {
    expect(metadata([pdf,
      { ...pdf, part: '3', shownInline: true }, { ...pdf, part: '4', disposition: ' INLINE; filename=x' },
      { ...pdf, part: '5', inline: true }, { ...pdf, part: '6', type: 'Text/Calendar; charset=UTF-8' },
      { ...pdf, part: '7', filename: 'Invite.ICS  ' }, { ...pdf, part: '8', type: 'application/ics' },
      { ...pdf, part: '9', filename: 'meeting.vcs' }, { ...pdf, part: '10', type: 'text/x-vcalendar' },
    ])).toMatchObject({ items: [{ part: '2' }], omittedCount: 8 });
  });

  it('rejects malformed part/name entries without manufacturing filenames or MIME types', () => {
    expect(metadata([null, [], 'bad', {}, { ...pdf, part: '../../1' }, { ...pdf, part: '1.HEADER' },
      { ...pdf, part: '01' }, { ...pdf, filename: '' }, { ...pdf, filename: {} },
      { ...pdf, filename: 'x'.repeat(513) }, { ...pdf, part: '2'.repeat(129) },
    ])).toMatchObject({ state: 'unknown', items: [], omittedCount: 11 });
    expect(metadata([{ ...pdf, type: {}, size: '500' }]).items[0]).toEqual({ part: '2', filename: pdf.filename, type: null, size: null });
  });

  it('cleans controls/bidi without interpreting markup, preserves duplicate names but rejects ambiguous duplicate parts', () => {
    const result = metadata([{ ...pdf, part: '1', filename: 'file\u202E\u0001.pdf' },
      { ...pdf, part: '3' }, { ...pdf, part: '4' }, { ...pdf, part: '5' }, { ...pdf, part: '5', filename: 'different.exe' },
      { ...pdf, part: '6', filename: '<img src=x onerror=alert(1)>.pdf' }]);
    expect(result.items.map(i => i.part)).toEqual(['1', '3', '4', '6']);
    expect(result.items[0].filename).toBe('file.pdf');
    expect(result.items.at(-1).filename).toBe('<img src=x onerror=alert(1)>.pdf');
    expect(result.omittedCount).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, {}, '500'])('treats invalid/zero advisory size %s as unknown', size => {
    expect(metadata([{ ...pdf, size }]).items[0].size).toBeNull();
  });

  it('bounds scanned entries, display count and fields; omitted count is cached entries, not more displayable files', () => {
    const result = metadata(Array.from({ length: 140 }, (_, i) => ({ ...pdf, part: String(i + 1) })));
    expect(result.items).toHaveLength(20); expect(result.omittedCount).toBe(120);
    expect(result.state).toBe('partial');
    expect(metadata([{ ...pdf, type: 'x'.repeat(129) }]).items[0].type).toBeNull();
  });

  it('does not mistake empty/invalid/unavailable metadata for a complete empty attachment list', () => {
    expect(metadata([])).toMatchObject({ state: 'unknown', items: [], omittedCount: 0, source });
    expect(normalizeCachedAttachmentMetadata(source, { entries: [], cached_count: null })).toMatchObject({ state: 'unknown', items: [], omittedCount: null });
    expect(normalizeCachedAttachmentMetadata(null, null)).toMatchObject({ state: 'unavailable', source: null, items: [], omittedCount: null });
  });
});

describe('cache hydration batches', () => {
  it('skips empty or invalid identities without touching the database and preserves paperclips', async () => {
    const execute = vi.fn();
    expect(await hydrateCachedAttachmentMetadata('owner', [], execute)).toEqual([]);
    for (const bad of [{}, { ...message, entity_id: null }, { ...message, uid: '7;drop table messages' },
      { ...message, uid_validity: 4294967296 }, { ...message, folder: 'x'.repeat(501) },
      { ...message, account_id: 'bad' }, { ...message, storage_generation: null }]) {
      const row = (await hydrateCachedAttachmentMetadata('owner', [bad], execute))[0];
      expect(row.attachmentMetadata.state).toBe('unavailable');
      expect(row.has_attachments).toBe(bad.has_attachments);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('sends only immutable locators, uses one query per 200 rows and keeps source rows separate', async () => {
    const execute = vi.fn(async (_sql, [, json]) => ({ rows: JSON.parse(json).map(row => ({
      request_index: row.request_index, entries: [pdf], cached_count: 1,
    })) }));
    const rows = await hydrateCachedAttachmentMetadata('owner', Array.from({ length: 401 }, () => ({ ...message, body_html: 'do not transmit' })), execute);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(rows.every(row => row.attachmentMetadata.source.messageId === message.id)).toBe(true);
    expect(rows.every(row => row.attachmentMetadata.items[0].part === '2')).toBe(true);
    for (const [, params] of execute.mock.calls) {
      expect(JSON.parse(params[1])).toHaveLength(Math.min(200, 401 - JSON.parse(params[1])[0].request_index));
      expect(params[1]).not.toContain('do not transmit');
    }
  });

  it('does not reuse stale/raw attachment fields or metadata if verification returns no row', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const input = { ...message, attachmentMetadata: { items: [pdf], source }, attachments: [pdf] };
    const row = (await hydrateCachedAttachmentMetadata('owner', [input], execute))[0];
    expect(row.attachmentMetadata).toMatchObject({ state: 'unavailable', source: null, items: [] });
    expect(row.has_attachments).toBe(true);
    expect(row).not.toHaveProperty('attachments');
    expect(input.attachments).toEqual([pdf]);
  });
});
