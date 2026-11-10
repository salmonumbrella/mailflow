import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { gmailAttachmentMetadata } from '../utils/gmailAttachmentMetadata.js';
import { previewKind } from '../utils/attachmentPreview.js';
import { fileIcon } from '../utils/attachmentUi.jsx';
import { GmailAttachmentContext } from './GmailAttachmentContext.js';

const contain = event => event.stopPropagation();
const suppress = event => { event.preventDefault(); event.stopPropagation(); };
const modified = event => event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;

export default function GmailAttachmentChips({ message, density }) {
  const { t } = useTranslation();
  const activate = useContext(GmailAttachmentContext);
  if (density !== 'default') return null;
  const metadata = gmailAttachmentMetadata(message);
  if (!metadata) return null;
  const label = t('gmail.attachments.cachedDetails', 'Cached attachments for this message only; details may be incomplete.');
  const overflowLabel = t('gmail.attachments.someNotShown', 'Additional cached attachment details are not shown.');
  const content = item => <>
    <span className="mailflow-gmail-attachment-icon" aria-hidden="true">{fileIcon(item.type)}</span>
    <bdi className="mailflow-gmail-attachment-name" dir="auto">{item.filename}</bdi>
  </>;
  return <ul className="mailflow-gmail-attachment-chips" aria-label={label} title={label}>
    {metadata.items.map(item => <li key={item.part} className={activate ? 'mailflow-gmail-attachment-entry' : 'mailflow-gmail-attachment-chip'} title={item.filename}>
      {activate ? <button type="button" className="mailflow-gmail-attachment-chip" data-attachment-part={item.part}
        title={item.filename}
        aria-label={previewKind(item)
          ? t('gmail.attachments.previewFile', { name: item.filename, defaultValue: 'Preview {{name}}' })
          : t('gmail.attachments.downloadFile', { name: item.filename, defaultValue: 'Download {{name}}' })}
        onClick={event => {
          suppress(event);
          if (event.button !== 0 || modified(event) || event.detail > 1) return;
          activate(message, metadata, item, event.currentTarget);
        }}
        onDoubleClick={suppress} onContextMenu={suppress} onAuxClick={suppress} onDragStart={suppress}
        onPointerDown={contain} onMouseDown={contain} onTouchStart={contain} onTouchEnd={contain}
        onKeyDown={event => {
          contain(event);
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!event.repeat && !modified(event)) activate(message, metadata, item, event.currentTarget);
          }
        }}
        onKeyUp={event => {
          contain(event);
          if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
        }}
      >{content(item)}</button> : content(item)}
    </li>)}
    {metadata.hasMore && <li className="mailflow-gmail-attachment-overflow" aria-label={overflowLabel} title={overflowLabel}>…</li>}
  </ul>;
}
