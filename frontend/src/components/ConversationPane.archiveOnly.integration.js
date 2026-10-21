import assert from 'node:assert/strict';

// Source-only test case for the root's named combined fixture. Bind the actual
// components/store/API and root-owned synthetic wire observations from that SAME
// source composition. This is not a module-fake SMTP/IMAP fixture or proof.
// No transport, guard, pendingReads helper, body or reply response is substituted.
export function registerArchiveOnlyNanaCase(test, actual) {
  for (const fixture of actual.archiveOnlyParents) {
    test(`archive-only Nana body and reply, raw thread ${fixture.rawThreadId === null ? 'NULL' : 'stored'}`,
      { timeout: 25000 }, async t => {
        const { React, createRoot, MessageList, ReadingPane, useStore, api, bodyCache, query,
          readImapEvents, readSmtpAcceptances } = actual;
        const completedSearches = [];
        const realSearch = api.search;
        t.mock.method(api, 'search', async (...args) => {
          const data = await realSearch(...args);
          completedSearches.push({ args, data });
          return data;
        });
        const host = document.body.appendChild(document.createElement('div'));
        const root = createRoot(host);
        t.after(async () => {
          await React.act(async () => root.unmount()); host.remove();
        });
        const waitFor = async (predicate, description) => {
          for (let turn = 0; turn < 200; turn += 1) {
            if (await predicate()) return;
            await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
          }
          assert.fail(description);
        };
        // Check physical provider identity in the actual synthetic DB. A normal
        // Inbox twin would make this an inadequate regression for the user case.
        const physical = await query(`SELECT id,account_id,folder,uid,is_archive_residue,thread_id,message_id
          FROM messages WHERE account_id=$1 AND provider_msgid=$2 AND NOT is_deleted`,
        [fixture.account.id, fixture.providerMsgid]);
        assert.equal(physical.rows.length, 1);
        assert.deepEqual(physical.rows[0], { id: fixture.messageId, account_id: fixture.account.id,
          folder: fixture.allMailPath, uid: fixture.uid, is_archive_residue: true,
          thread_id: fixture.rawThreadId, message_id: fixture.rawMessageId });
        const initialCounts = await api.getUnreadCounts();
        const unreadBefore = initialCounts.byAccount[fixture.account.id];
        assert.equal(typeof unreadBefore, 'number');
        const categorization = fixture.categorizationEnabled || fixture.account.categorization_enabled;
        const categoriesBefore = categorization ? await api.getCategoryCounts({ accountId: fixture.account.id }) : null;
        const openingBoundary = await actual.sealWireEvidenceBoundary();
        const beforeOpen = openingBoundary.imapBaseline;
        const smtpBefore = openingBoundary.smtpBaseline;
        bodyCache.clear();
        useStore.getState().setUser({ id: fixture.userId });
        useStore.getState().setLocked(false);
        useStore.setState({ accounts: [fixture.account], accountsReady: true,
          selectedAccountId: fixture.account.id, selectedFolder: 'INBOX', searchAllFolders: true,
          messages: [], searchResults: [], threadMessages: {}, searchQuery: '', selectedMessageId: null,
          conversationMode: 'pane', threadedView: true, markReadBehavior: 'immediate',
          categorizationEnabled: Boolean(categorization),
          composing: false, composeData: null, notifications: [], darkEmailBodies: false });
        useStore.getState().setUnreadCounts(initialCounts);
        // The real composer mounts only after the actual reply action creates its
        // store draft, in the same root as the list and reading pane.
        function ComposeSlot() {
          const composing = useStore(state => state.composing);
          const session = useStore(state => state.composeSession);
          return composing ? React.createElement(actual.ComposeModal, { key: session }) : null;
        }
        await React.act(async () => root.render(React.createElement(React.Fragment, null,
          React.createElement(MessageList), React.createElement(ReadingPane), React.createElement(ComposeSlot))));
        // This drives the real initial search effect, endpoint, issued-token guard
        // and grouped publication. Do not seed searchResults from a fake response.
        await React.act(async () => useStore.getState().setSearchQuery(fixture.bodyPhrase));
        await waitFor(() => !useStore.getState().isSearching && useStore.getState().searchResults.length,
          'complete-body phrase must find the All-Mail-only inbound parent');
        const match = useStore.getState().searchResults[0];
        assert.equal(match.id, fixture.messageId);
        assert.equal(match.matched_message_id, fixture.messageId);
        assert.equal(match.from_email, 'nana@synthetic.test');
        assert.equal(match.reply_thread_id, fixture.rawThreadId);
        assert.equal(match.thread_id, JSON.stringify([fixture.account.id, fixture.rawThreadId ?? fixture.messageId]));
        const row = host.querySelector(`[data-msgid="${fixture.messageId}"] [draggable]`);
        assert.ok(row);
        await React.act(async () => row.click());
        await waitFor(() => host.textContent.includes(fixture.bodyPhrase), 'actual selected body must open without a residue409');
        assert.equal(useStore.getState().selectedMessageId, fixture.messageId);
        const parentEvents = events => events.filter(event => event.accountId === fixture.account.id &&
          event.folder === fixture.allMailPath && String(event.uid) === String(fixture.uid));
        await waitFor(async () => {
          const events = parentEvents((await readImapEvents()).slice(beforeOpen.length));
          const selected = useStore.getState().searchResults.find(message => message.id === fixture.messageId);
          return selected?.is_read === true && events.some(event => event.command === 'STORE' &&
            event.flags.includes('\\Seen') && event.ok === true);
        }, 'opening must perform a successful Seen STORE on the actual All Mail UID');
        const opened = parentEvents((await readImapEvents()).slice(beforeOpen.length));
        assert.equal(opened.filter(event => event.command === 'STORE').length, 1);
        // This badge is INBOX STATUS. The parent exists only in All Mail, so
        // certification must restore the unchanged server truth, not a debit.
        await waitFor(() => {
          const state = actual.countWriteTracker.inspect();
          return state.inFlight === 0 && state.localIntents === 0 && state.opIds.length === 0;
        }, 'the real read/count operation must be certified before asserting the INBOX badge');
        assert.equal(useStore.getState().unreadCounts.byAccount[fixture.account.id], unreadBefore);
        if (categoriesBefore) {
          const certified = await api.getCategoryCounts({ accountId: fixture.account.id });
          assert.deepEqual(certified.counts, categoriesBefore.counts, 'All-Mail-only read does not change INBOX category truth');
          assert.deepEqual(useStore.getState().categoryCounts, categoriesBefore.counts,
            'the certified INBOX category badge must converge without a persistent debit');
        }
        // A fresh server observation and search/context replacement must converge,
        // without a second automatic read or another optimistic count debit.
        const freshCounts = await api.getUnreadCounts();
        assert.equal(freshCounts.byAccount[fixture.account.id], unreadBefore);
        await React.act(async () => useStore.getState().setUnreadCounts(freshCounts));
        const searchesBeforeRefresh = completedSearches.length;
        const rowsBeforeRefresh = useStore.getState().searchResults;
        await React.act(async () => window.dispatchEvent(new window.Event('mailflow:rules-ran')));
        await waitFor(() => completedSearches.length > searchesBeforeRefresh &&
          useStore.getState().searchResults !== rowsBeforeRefresh && !useStore.getState().isSearching,
        'a new actual search response must publish before fresh-search convergence is asserted');
        assert.equal(useStore.getState().unreadCounts.byAccount[fixture.account.id], unreadBefore);
        assert.equal(parentEvents((await readImapEvents()).slice(beforeOpen.length)).filter(event => event.command === 'STORE').length, 1);
        const replyLabel = actual.i18n.t('message.reply');
        const reply = [...host.querySelectorAll('button')].find(button =>
          button.textContent === replyLabel || button.title === replyLabel);
        assert.ok(reply, 'the residue read-only guard must leave reply available');
        assert.notEqual(reply.getAttribute('aria-disabled'), 'true');
        assert.equal(reply.disabled, false);
        await React.act(async () => reply.click());
        await waitFor(() => useStore.getState().composing, 'actual reply action must create a draft');
        const draft = useStore.getState().composeData;
        assert.deepEqual(draft.to, [{ name: 'Nana', email: 'nana@synthetic.test' }]);
        assert.match(draft.quotedBody, /Nana <nana@synthetic\.test> wrote:/);
        assert.ok(draft.quotedBody.includes(fixture.bodyPhrase));
        assert.equal(draft.threadId, fixture.rawThreadId);
        assert.equal(draft.inReplyTo, fixture.rawMessageId);
        assert.equal(draft.references, fixture.rawReferences);
        assert.equal((await readSmtpAcceptances()).length, smtpBefore.length, 'opening/reply-draft alone sends nothing');
        // The ns9r/root send case starts its separate counter window HERE. It must
        // send this actual draft to the fake SMTP exactly once, verify replay and
        // zero further STORE/structural mutations. Answered is NOT APPLICABLE.
        const sendBoundary = await actual.sealWireEvidenceBoundary();
        const afterOpen = { fixture, draft, ...sendBoundary };
        actual.completedBodyReplyStage.push(afterOpen);
        // The sole driver's real Compose send extension finishes while this
        // React root is still mounted; t.after remains its teardown owner.
        await actual.completeBodyReplyStage({ root, host, React, fixture, draft, afterOpen, waitFor });
      });
  }
}
