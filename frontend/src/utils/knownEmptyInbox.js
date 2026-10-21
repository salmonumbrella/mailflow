// Provider totals support presentation while page zero revalidates. They do not
// replace the response, loading state, or continuation/retry state once it settles.
export function shouldKeepEmptyInbox({
  loadingMessages, messagesOffset, currentPage, selectedFolder,
  searchQuery, showGtdTab, accountSnapshots,
}) {
  const eligible = loadingMessages && messagesOffset === 0 && currentPage === 1
    && selectedFolder === 'INBOX' && !searchQuery.trim() && !showGtdTab
    && accountSnapshots.length > 0;
  if (!eligible) return false;
  for (const snapshot of accountSnapshots) {
    if (snapshot?.known !== true || snapshot.stale !== false
      || snapshot.pending !== false || snapshot.totalCount !== 0) return false;
  }
  return true;
}
