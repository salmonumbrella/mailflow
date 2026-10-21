import { useTranslation } from 'react-i18next';
import { classifyFastmailAddress } from '../utils/fastmailAddressKind.js';

export default function FastmailAddressIndicator({ account, email, inventory }) {
  const { t } = useTranslation();
  const kind = classifyFastmailAddress({ account, email, inventory });
  if (kind !== 'masked' && kind !== 'alias') return null;
  const label = t(`addressIndicator.${kind}`);
  return (
    <span role="img" aria-label={label} title={label} style={{
      display: 'inline-flex', verticalAlign: 'middle', flexShrink: 0,
      marginInlineStart: 4, color: 'var(--text-secondary)',
    }}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'masked' ? (
          <>
            <path d="M3 6c3 1 6 1 9 0 3 1 6 1 9 0v5c0 4-3 7-6 7l-3-3-3 3c-3 0-6-3-6-7Z" />
            <path d="M6 10h3m6 0h3" />
          </>
        ) : (
          <>
            <path d="M4 5h10l6 7-6 7H4Z" />
            <circle cx="8" cy="12" r="1" />
          </>
        )}
      </svg>
    </span>
  );
}
