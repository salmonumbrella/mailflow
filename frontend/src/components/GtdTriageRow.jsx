import SuperhumanMessageRow from './SuperhumanMessageRow.jsx';
import { resolveRowDisplay, agingLabel } from '../utils/gtd.js';
import GtdEntryRow from './GtdEntryRow.jsx';
import RowHoverActions from './RowHoverActions.jsx';
import { rememberGtdRailSelection } from '../utils/gtdHotkeys.js';
import { registerHoveredGtdRow } from '../utils/gtdHoveredRow.js';

// A GTD entry row with triage wired on: the presentational GtdEntryRow plus this
// surface's affordances — a right-click context menu and the bottom-right hover action
// cluster. Shared by both GTD row surfaces: the right-sidebar section rows
// (GtdSidebarContent, variant="sidebar") and the GTD tab browse list that replaces the
// inbox message list (GtdTabList, variant="list"). `variant` is passed straight through
// to GtdEntryRow to pick its size table; every action here stays section-scoped via
// doneStates so "done"/"move"/"delete" only touch the section the row belongs to.
export default function GtdTriageRow({ thread, sectionKey, variant, selected, onOpen, rowActions, hoverQuickActions = true, t, onHighlight, showMessagePreviews = true }) {
  const isWaiting = sectionKey === 'waiting';
  // The label states this row's "done" strips: a Waiting row clears its own kinds
  // (leaving GTD labels in other sections alone); other sections clear their own state.
  const { kinds, unread, sender, days, stale } = resolveRowDisplay(thread, sectionKey);
  const doneStates = isWaiting ? kinds : [sectionKey];

  // Open the shared context menu carrying this row's section-scoped doneStates, so its
  // "done" and "move" strip only the section the row belongs to.
  const openMenuAt = (x, y, defaultMoveView = false) =>
    rowActions.openMenu({ x, y, message: thread, doneStates, defaultMoveView });

  const open = () => { rememberGtdRailSelection(thread, sectionKey); onOpen(); };
  const contextMenu = e => { e.preventDefault(); openMenuAt(e.clientX, e.clientY); };
  const renderHoverActions = () => (
    <RowHoverActions
      message={thread}
      isRead={!unread}
      background="var(--bg-tertiary)"
      onMarkRead={(e, m) => { e.stopPropagation(); rowActions.setRead(m, !m.is_read); }}
      onStar={(e, m) => { e.stopPropagation(); rowActions.toggleStar(m); }}
      onDelete={(e, m) => { e.stopPropagation(); rowActions.deleteRow(m, doneStates); }}
      onMove={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, true); }}
      rowActionCtx={{ message: thread, done: e => { e.stopPropagation(); rowActions.done(thread, doneStates); } }}
    />
  );

  if (variant === 'superhuman') return <SuperhumanMessageRow
    message={{ ...thread, from_name: sender, is_read: !unread, snippet: thread.gist || thread.snippet }}
    selected={selected} onSelect={open} onHighlight={onHighlight} onContextMenu={contextMenu}
    onStar={(e) => { e.stopPropagation(); rowActions.toggleStar(thread); }}
    showMessagePreviews={showMessagePreviews} hoverQuickActions={hoverQuickActions}
    renderHoverActions={renderHoverActions}
    rowMeta={isWaiting && days != null ? <span className="sh-gtd-aging" data-stale={stale}>{agingLabel(days)}</span> : null}
  />;

  return (
    <GtdEntryRow
      thread={thread}
      sectionKey={sectionKey}
      variant={variant}
      selected={selected}
      t={t}
      onClick={open}
      onContextMenu={contextMenu}
      onHoverTargetEnter={variant === 'sidebar' ? () => registerHoveredGtdRow({
        message: thread, sectionKey,
        classify: (message, state) => rowActions.classifyRow(message, state),
        // In GTD, archive is the existing Done transition: archive the inbox copy and
        // remove the label(s) represented by this sidebar row.
        archive: (message, states) => rowActions.done(message, states),
      }) : undefined}
      renderHoverActions={hoverQuickActions ? renderHoverActions : undefined}
    />
  );
}
