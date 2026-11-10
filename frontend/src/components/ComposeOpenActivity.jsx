import { useTranslation } from 'react-i18next';
import { useEffect, useId, useState } from 'react';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { OPEN_ACTIVITY_NOTICE } from '../utils/openActivity.js';

export default function ComposeOpenActivity({ checked, onChange, plaintextEmail, disabled, owner }) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(null);
  const [error, setError] = useState('');
  const id = useId();
  useEffect(() => {
    let live = true;
    api.get('/open-activity/capabilities').then(result => {
      if (live && useStore.getState().user?.id === owner) setAvailable(result.available === true);
    }).catch(() => { if (live) setError(t("openActivity.checkFailed", "Could not check open activity availability.")); });
    return () => { live = false; };
  }, [owner, t]);
  return <details style={{ padding: '7px 14px', fontSize: 12, borderTop: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
    <summary style={{ cursor: 'pointer' }}>{checked && !plaintextEmail ? t("openActivity.on", "Open activity on") : t("openActivity.off", "Open activity off")}</summary>
    <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9 }}>
      <input type="checkbox" checked={checked && !plaintextEmail} aria-describedby={id}
        disabled={disabled || plaintextEmail || (!checked && available !== true)}
        onChange={event => onChange(event.target.checked)} />
      {t("openActivity.record", "Record image loads for this message")}
    </label>
    <p id={id} style={{ margin: '6px 0', lineHeight: 1.5 }}>{t('openActivity.notice', OPEN_ACTIVITY_NOTICE)}</p>
    <p style={{ margin: '6px 0' }}>{t("openActivity.draftNotice", "Ordinary drafts and undone sends reopen with this off. Previously opted-in scheduled messages retain the visible choice.")}</p>
    {plaintextEmail ? <p>{t("openActivity.plaintext", "Unavailable for plain-text email.")}</p>
      : error ? <p role="status">{error}</p>
        : available === false ? <p>{t("openActivity.unconfigured", "A public HTTPS APP_URL is required. This server is not configured for open activity.")}</p>
          : available === null ? <p role="status">{t("openActivity.checking", "Checking availability…")}</p> : null}
  </details>;
}
