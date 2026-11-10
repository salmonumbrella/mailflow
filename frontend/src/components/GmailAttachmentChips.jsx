import { useTranslation } from 'react-i18next';
import { gmailAttachmentMetadata } from '../utils/gmailAttachmentMetadata.js';
import { fileIcon } from '../utils/attachmentUi.jsx';

export default function GmailAttachmentChips({ message, density }) {
  const { t } = useTranslation();
  if (density !== 'default') return null;
  const metadata = gmailAttachmentMetadata(message);
  if (!metadata) return null;
  const label = t('gmail.attachments.cachedDetails', 'Cached attachments for this message only; details may be incomplete.');
  const overflowLabel = t('gmail.attachments.someNotShown', 'Additional cached attachment details are not shown.');
  return <ul className="mailflow-gmail-attachment-chips" aria-label={label} title={label}>
    {metadata.items.map(item => <li key={item.part} className="mailflow-gmail-attachment-chip" title={item.filename}>
      <span className="mailflow-gmail-attachment-icon" aria-hidden="true">{fileIcon(item.type)}</span>
      <bdi className="mailflow-gmail-attachment-name" dir="auto">{item.filename}</bdi>
    </li>)}
    {metadata.hasMore && <li className="mailflow-gmail-attachment-overflow" aria-label={overflowLabel} title={overflowLabel}>…</li>}
  </ul>;
}
