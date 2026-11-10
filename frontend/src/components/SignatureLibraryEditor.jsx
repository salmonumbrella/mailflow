import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { newClientKey } from '../utils/scheduledCompose.js';
import SignatureEditor from './SignatureEditor.jsx';
import { composerHtmlToText, composerTextToHtml } from '../utils/composerBodyMode.js';

export default function SignatureLibraryEditor({ account, value, onChange, disabled = false }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(value.signatures[0]?.id || '');
  const [sender, setSender] = useState('main');
  const [nameDialog, setNameDialog] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState('');
  const current = value.signatures.find(s => s.id === selected);
  const defaults = value.defaults.find(d => d.senderKey === sender);
  const patch = change => { if (!disabled) onChange({ ...value, ...change }); };
  const patchRecord = change => patch({ signatures: value.signatures.map(s => s.id === selected ? { ...s, ...change } : s) });
  function saveName(event) {
    event.preventDefault(); const name = nameDialog.name.trim();
    if (!name || name.length > 80) { setError(t('signatureLibrary.nameRequired', 'Enter a signature name of 1–80 characters.')); return; }
    if (value.signatures.some(s => s.id !== nameDialog.id && s.name.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase())) { setError(t('signatureLibrary.duplicateName', 'A signature with this name already exists.')); return; }
    const id = nameDialog.id || newClientKey();
    patch({ signatures: nameDialog.id ? value.signatures.map(s => s.id === id ? { ...s, name } : s) : [...value.signatures, { id, name, content: '', isPlainText: false }] });
    setSelected(id); setNameDialog(null); setError('');
  }
  return <fieldset disabled={disabled} className="mf-signature-library">
    <legend>{t('signatureLibrary.savedSignatures', 'Saved signatures')}</legend>
    <p>{t('signatureLibrary.snapshotNote', 'Changes apply to future messages. Existing drafts keep their saved signature.')}</p>
    <div className="mf-signature-library-manager">
      <div className="mf-signature-library-names" role="group" aria-label={t('signatureLibrary.names', 'Signatures')}>
        {!value.signatures.length && <p>{t('signatureLibrary.empty', 'No signatures')}</p>}
        {value.signatures.map(s => <div key={s.id}>
          <button type="button" aria-pressed={s.id === selected} onClick={() => setSelected(s.id)}>{s.name}</button>
          <button type="button" aria-label={`${t('signatureLibrary.rename', 'Rename signature')} ${s.name}`} onClick={() => { setNameDialog({ id: s.id, name: s.name }); setError(''); }}>{t('signatureLibrary.renameShort', 'Rename')}</button>
          <button type="button" aria-label={`${t('signatureLibrary.delete', 'Delete signature')} ${s.name}`} onClick={() => setDeleting(s)}>{t('signatureLibrary.deleteShort', 'Delete')}</button>
        </div>)}
        <button type="button" disabled={value.signatures.length >= 100} onClick={() => { setNameDialog({ name: '' }); setError(''); }}>{t('signatureLibrary.create', 'Create new')}</button>
      </div>
      {current && <div className="mf-signature-library-editor">
        <label><input type="checkbox" checked={current.isPlainText} onChange={e => patchRecord({ isPlainText: e.target.checked, content: e.target.checked ? composerHtmlToText(current.content) : composerTextToHtml(current.content) })} />{t('signatureLibrary.literalText', 'Plain-text signature')}</label>
        {current.isPlainText ? <textarea aria-label={t('signatureLibrary.text', 'Signature text')} value={current.content} onChange={e => patchRecord({ content: e.target.value })} />
          : <SignatureEditor disabled={disabled} key={`${current.id}:${current.isPlainText}`} value={current.content} onChange={content => patchRecord({ content })} />}
      </div>}
    </div>
    <h3>{t('signatureLibrary.defaults', 'Signature defaults')}</h3>
    <label>{t('signatureLibrary.sender', 'Sender')} <select aria-label={t('signatureLibrary.sender', 'Sender')} value={sender} onChange={e => setSender(e.target.value)}><option value="main">{account.email_address}</option>{(account.aliases || []).map(a => <option key={a.id} value={a.id}>{a.email}</option>)}</select></label>
    {defaults && <div className="mf-signature-library-defaults">{[['newSignatureId', t('signatureLibrary.newDefault', 'For new emails use')], ['replySignatureId', t('signatureLibrary.replyDefault', 'On reply/forward use')]].map(([key, label]) => <label key={key}>{label}<select aria-label={label} value={defaults[key] || ''} onChange={e => patch({ defaults: value.defaults.map(d => d.senderKey === sender ? { ...d, [key]: e.target.value || null } : d) })}><option value="">{t('signatureLibrary.none', 'No signature')}</option>{value.signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>)}</div>}
    {nameDialog && <form data-signature-editor className="mf-gmail-settings-editor" onSubmit={saveName} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setNameDialog(null); } }}>
      <h3>{nameDialog.id ? t('signatureLibrary.rename', 'Rename signature') : t('signatureLibrary.nameNew', 'Name new signature')}</h3>
      <label>{t('signatureLibrary.name', 'Signature name')}<input autoFocus maxLength={80} value={nameDialog.name} onChange={e => setNameDialog({ ...nameDialog, name: e.target.value })} /></label>
      {error && <p role="alert">{error}</p>}<button type="submit">{t('signatureLibrary.done', 'Done')}</button><button type="button" onClick={() => setNameDialog(null)}>{t('signatureLibrary.cancel', 'Cancel')}</button>
    </form>}
    {deleting && <div data-signature-editor role="alert" className="mf-gmail-settings-editor" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setDeleting(null); } }}><p>{t('signatureLibrary.deleteQuestion', 'Delete signature')} “{deleting.name}”?</p><p>{t('signatureLibrary.deleteNote', 'Defaults using this signature will become No signature. Existing drafts are unchanged.')}</p><button type="button" onClick={() => {
      const signatures = value.signatures.filter(s => s.id !== deleting.id);
      patch({ signatures, defaults: value.defaults.map(d => ({ ...d, newSignatureId: d.newSignatureId === deleting.id ? null : d.newSignatureId, replySignatureId: d.replySignatureId === deleting.id ? null : d.replySignatureId })) });
      if (selected === deleting.id) setSelected(signatures[0]?.id || ''); setDeleting(null);
    }}>{t('signatureLibrary.confirmDelete', 'Delete signature')}</button><button type="button" onClick={() => setDeleting(null)}>{t('signatureLibrary.cancel', 'Cancel')}</button></div>}
  </fieldset>;
}
