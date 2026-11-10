import { useTranslation } from 'react-i18next';
import { splitQuotedText } from '../utils/quotedContent.js';

export default function GmailQuotedText({ text, renderText = value => value }) {
  const { t } = useTranslation();
  return splitQuotedText(text).map((part, index) => part.quoted
    ? <details key={index}><summary style={{ cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '4px 0', whiteSpace: 'normal' }}>{t('gmailReader.quotedContent', { defaultValue: 'Quoted content' })}</summary>{renderText(part.text)}</details>
    : <span key={index}>{renderText(part.text)}</span>);
}
