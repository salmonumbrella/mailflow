import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { useNativeLabels } from '../hooks/useNativeLabels.js';
import { labelTree } from '../utils/nativeLabels.js';

export default function NativeLabelNavigation({ accountId, collapsed, more }) {
  const { t } = useTranslation();
  const { snapshot, status, error, refresh } = useNativeLabels(accountId);
  const active = useStore(state => state.activeLabel);
  const navigate = useStore(state => state.setActiveLabel);
  const [moreLabels, setMoreLabels] = useState(false);
  const [closed, setClosed] = useState(new Set());
  if (!accountId) return null;
  const labels = labelTree(snapshot?.labels || []);
  const counts = new Map((snapshot?.counts || []).map(count => [count.labelId, count]));
  const hiddenParents = new Set();
  return <section aria-label={t('gmail.nativeLabels.title', "MailFlow labels")} data-native-label-navigation>
    {!collapsed && <div className="gmail-native-folders-heading">{t('gmail.labelNavigation.labels', "Labels")} <small title={t('gmail.labelNavigation.countScope', "Counts include only verified messages in the synchronized cache, excluding Spam and Trash.")}>{t('gmail.labelNavigation.cachedMail', "· cached mail")}</small></div>}
    <button type="button" className="gmail-native-nav-row" aria-label={t('gmail.memberships.manage', "Manage labels")} title={t('gmail.labelNavigation.manageTitle', "Create, edit or remove MailFlow labels")} onClick={() => window.dispatchEvent(new CustomEvent('mailflow:manage-native-labels', { detail: { accountId } }))}><span aria-hidden="true">＋</span>{!collapsed && <span>{t('gmail.memberships.manage', "Manage labels")}</span>}</button>
    {!collapsed && snapshot?.coverage?.priorGenerationMemberships > 0 && <p role="status" style={{ padding: '0 16px', fontSize: 12 }}>{t('gmail.labelNavigation.priorGeneration', "Some label associations belong to earlier mailbox generations and are not included.")}</p>}
    {error && <div role="alert" style={{ padding: '8px 16px', fontSize: 12 }}>{error} <button type="button" onClick={refresh}>{t('gmail.labelNavigation.retry', "Retry labels")}</button></div>}
    {status === 'loading' && !snapshot && !collapsed && <p role="status" style={{ padding: '0 16px', fontSize: 12 }}>{t('gmail.labelNavigation.loading', "Loading labels…")}</p>}
    {labels.map(label => {
      const count = counts.get(label.id);
      const selected = active?.accountId === accountId && active.labelId === label.id && active.storageGeneration === snapshot.storageGeneration;
      const normallyVisible = label.visibility !== 'hide' && (label.visibility !== 'unread' || count?.unread > 0);
      const parentHidden = hiddenParents.has(label.parentId);
      if (parentHidden || closed.has(label.id) || !normallyVisible && !more && !moreLabels && !selected) hiddenParents.add(label.id);
      if (!selected && (parentHidden || !normallyVisible && !more && !moreLabels)) return null;
      const children = labels.some(child => child.parentId === label.id);
      const title = `${label.path || label.name} · ${count ? t('gmail.labelNavigation.counts', 'Synchronized messages: {{total}}; unread: {{unread}}', { total: count.total, unread: count.unread }) : t('gmail.labelNavigation.countsUnavailable', "Counts unavailable")}${count?.unresolvedMemberships ? ` · ${t('gmail.labelNavigation.awaitingLocations', 'Memberships awaiting verified locations: {{memberships}}', { memberships: count.unresolvedMemberships })}` : ''}`;
      return <div key={label.id} style={{ display: 'flex', alignItems: 'center', paddingLeft: collapsed ? 0 : label.depth * 12 }}>
        {!collapsed && children && <button type="button" aria-label={closed.has(label.id) ? t('gmail.labelNavigation.expand', 'Expand {{name}}', { name: label.name }) : t('gmail.labelNavigation.collapse', 'Collapse {{name}}', { name: label.name })} aria-expanded={!closed.has(label.id)} onClick={() => setClosed(current => { const next = new Set(current); if (next.has(label.id)) next.delete(label.id); else next.add(label.id); return next; })} style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>{closed.has(label.id) ? '▸' : '▾'}</button>}
        <button type="button" data-native-label-id={label.id} aria-current={selected ? 'page' : undefined} title={title} aria-label={title}
          className={`gmail-native-nav-row${selected ? ' gmail-native-nav-active' : ''}`} onClick={() => navigate({ accountId, storageGeneration: snapshot.storageGeneration, labelId: label.id })}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill={label.color || 'none'} stroke={label.color || 'currentColor'} strokeWidth="1.7" aria-hidden="true"><path d="M3 5h11l7 7-7 7H3Z" /></svg>
          {!collapsed && <><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label.name}</span>{count?.unread > 0 && <span className="gmail-native-nav-count">{count.unread}</span>}{count?.unresolvedMemberships > 0 && <span aria-label={t('gmail.labelNavigation.unresolved', "Some memberships await verified message locations")}>?</span>}</>}
        </button>
      </div>;
    })}
    {labels.some(label => label.visibility === 'hide' || label.visibility === 'unread' && !(counts.get(label.id)?.unread > 0)) && <button type="button" className="gmail-native-nav-row" aria-label={moreLabels ? t('gmail.labelNavigation.fewer', "Fewer labels") : t('gmail.labelNavigation.more', "More labels")} aria-expanded={moreLabels} onClick={() => setMoreLabels(value => !value)}>{moreLabels ? '⌃' : '⌄'}{!collapsed && <span>{moreLabels ? t('gmail.labelNavigation.fewer', "Fewer labels") : t('gmail.labelNavigation.more', "More labels")}</span>}</button>}
    {status === 'ready'  && !labels.length && !collapsed && <p style={{ padding: '0 16px', fontSize: 12 }}>{t('gmail.labelNavigation.empty', "No labels yet.")}</p>}
  </section>;
}
