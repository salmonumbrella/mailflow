import { useTranslation } from 'react-i18next';
import { useNativeLabels } from '../hooks/useNativeLabels.js';
import { useStore } from '../store/index.js';

// Values are stable definition UUIDs. Names are display-only, never identities.
export default function NativeRuleLabelSelect({ accountId, value, onChange, disabled, label, style }) {
  const { t } = useTranslation();
  const { snapshot, status, error, refresh } = useNativeLabels(accountId);
  const account = useStore(state => state.accounts.find(item => item.id === accountId));
  const labels = snapshot?.labels || [];
  const missing = value && snapshot && !labels.some(item => item.id === value);
  return <>
    <select aria-label={label} style={style} value={value || ''} disabled={disabled || !accountId || !snapshot || status !== 'ready'} onChange={event => onChange(event.target.value, snapshot.storageGeneration)}>
      <option value="">{t('nativeLabelRules.choose', { defaultValue: 'Choose a MailFlow label…' })}</option>
      {missing && <option value={value} disabled>{t('nativeLabelRules.missing', { defaultValue: 'Missing label. Repair this rule before enabling it.' })}</option>}
      {labels.map(item => <option key={item.id} value={item.id}>{`${account?.email_address || account?.name || accountId} · ${item.path || item.name}`}</option>)}
    </select>
    {missing && <span role="alert">{t('nativeLabelRules.missing', { defaultValue: 'Missing label. Repair this rule before enabling it.' })}</span>}
    {error && <span role="alert">{error} <button type="button" onClick={refresh}>{t('gmail.labelNavigation.retry', { defaultValue: 'Retry labels' })}</button></span>}
  </>;
}
