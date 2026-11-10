import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';

const helpArticles = [
  ['Find messages and attachments', 'Use the mail search field to search your connected accounts. Try from:person@example.com or has:attachment. Open search options to combine criteria.'],
  ['Create a signature', 'Open Settings and choose General to manage the signature for each connected mail account. Select a signature while composing a message.'],
  ['Manage connected accounts', 'MailFlow connects to your own mail providers. Account connection and server settings are managed in MailFlow settings, not in a Google account menu.'],
  ['Change appearance and notifications', 'Open Settings to change your MailFlow preferences. The header status is a local indicator only and does not mute notifications.'],
  ['Keep your account secure', 'Use your mail provider to change its password. Your MailFlow profile and provider account are separate identities. Never include passwords in feedback.'],
];
const categories = ['Change notification settings', 'Find messages or attachments', 'Send or receive email', 'Manage an account', 'Report spam or block someone', 'Other'];

export default function GmailSupport({ topic = 'help', onClose, storageKey = 'mailflow.feedback' }) {
  const { t } = useTranslation();
  const articles = helpArticles.map(([title, body], index) => [t(`gmail.support.article${index}.title`, title), t(`gmail.support.article${index}.body`, body)]);
  const root = useRef(null);
  const [screen, setScreen] = useState(topic);
  const [query, setQuery] = useState('');
  const [article, setArticle] = useState(null);
  const [intent, setIntent] = useState(null);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [review, setReview] = useState(false);
  const [screenshot, setScreenshot] = useState(false);
  const [emailUpdates, setEmailUpdates] = useState(false);
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { root.current?.querySelector('button')?.focus(); }, [screen, intent, review, article, saved]);
  const title = screen === 'training' ? t('gmail.support.training', 'Training') : screen !== 'feedback' ? t('gmail.support.help', 'Help') : !intent ? t('gmail.support.feedback', 'Feedback') : intent === 'issue' ? t('gmail.support.report_an_issue', 'Report an issue') : t('gmail.support.suggest_an_idea', 'Suggest an idea');
  const canSubmit = description.trim() && (intent !== 'issue' || category);
  const back = () => {
    setNotice(''); setError('');
    if (article) setArticle(null);
    else if (review) setReview(false);
    else if (intent) setIntent(null);
    else { setScreen('help'); setQuery(''); }
  };
  const save = () => {
    if (!canSubmit) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ intent, category: intent === 'issue' ? category : '', description: description.trim(), emailUpdates, screenshot: screenshot ? 'blank-local-preview' : null, createdAt: new Date().toISOString() }));
      setSaved(true); setError('');
    } catch {
      setError(t('gmail.support.storage_error', 'Feedback could not be saved because browser storage is unavailable. Your text remains here; you can copy it before closing.'));
    }
  };
  const keyDown = event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...root.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea,select,a[href]')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
  };
  return createPortal(<div className={`mailflow-gmail-support-backdrop ${screen !== 'feedback' ? 'is-help' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={root} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="mailflow-gmail-support" onKeyDown={keyDown}>
      <header>
        {(article || intent || screen !== 'help' || query) && !saved && <button type="button" aria-label={t('gmail.support.back', "Back")} onClick={back}>←</button>}
        <h2>{title}</h2><button type="button" aria-label={t('gmail.support.close_title', { defaultValue: 'Close {{title}}', title })} onClick={onClose}>×</button>
      </header>
      <div className="mailflow-gmail-support-content">
        {screen !== 'feedback' ? <>
          {article ? <article><h3>{article[0]}</h3><p>{article[1]}</p></article> : <>
            {screen === 'training' && <p>{t('gmail.support.learn_the_mailflow_features_available_in_this_mailbox', "Learn the MailFlow features available in this mailbox. Google training and account services are not connected.")}</p>}
            <label>{t('gmail.support.search_help', "Search Help")}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <h3>{t('gmail.support.popular_help_resources', "Popular help resources")}</h3>
            {articles.filter(item => item.join(' ').toLowerCase().includes(query.toLowerCase())).map(item => <button className="mailflow-gmail-help-resource" key={item[0]} onClick={() => setArticle(item)}>{item[0]} <span aria-hidden="true">›</span></button>)}
            {!articles.some(item => item.join(' ').toLowerCase().includes(query.toLowerCase())) && <p role="status">{t('gmail.support.no_matching_help_articles_try_another_search', "No matching help articles. Try another search.")}</p>}
            <hr /><h3>{t('gmail.support.need_more_help', "Need more help?")}</h3>
            {[t('gmail.support.forum', 'Visit help forum'), t('gmail.support.community', 'Ask the Help Community')].map(text => <button className="mailflow-gmail-help-resource" key={text} onClick={() => setArticle([text, t('gmail.support.community_notice', 'An online community is not connected here. No question has been posted. Contact the administrator of your MailFlow installation for help.')])}>{text}</button>)}
            <button className="mailflow-gmail-help-resource" onClick={() => setScreen('feedback')}>{t('gmail.support.send_feedback', "Send feedback")}</button>
          </>}
        </> : saved ? <div role="status"><h3>{t('gmail.support.feedback_saved_locally', "Feedback saved locally")}</h3><p>{t('gmail.support.your_latest_feedback_is_saved_for_this_browser', "Your latest feedback is saved for this browser tab’s session. Nothing was sent to Google, MailFlow, or your administrator. No screenshot, account information, or system information was collected.")}</p><button onClick={onClose}>{t('gmail.support.done', "Done")}</button></div> : !intent ? <>
          <p>{t('gmail.support.keep_feedback_in_this_browser_session_this_form', "Keep feedback in this browser session. This form does not send a report.")}</p>
          <button className="mailflow-gmail-help-resource" onClick={() => setIntent('issue')}>{t('gmail.support.report_an_issue', "Report an issue")}<span aria-hidden="true">⚑</span></button>
          <button className="mailflow-gmail-help-resource" onClick={() => setIntent('idea')}>{t('gmail.support.suggest_an_idea', "Suggest an idea")}<span aria-hidden="true">✧</span></button>
        </> : <>
          {review ? <div className="mailflow-gmail-feedback-review"><h3>{t('gmail.support.review_local_feedback', "Review local feedback")}</h3>{intent === 'issue' && <p><strong>{t('gmail.support.category', "Category:")}</strong> {category}</p>}<p className="mailflow-gmail-feedback-description">{description}</p><p>{t('gmail.support.no_account_or_system_information_will_be_collected', "No account or system information will be collected.")}</p></div> : <>
            {intent === 'issue' && <label>{t('gmail.support.what_were_you_trying_to_do_required', "What were you trying to do? (required)")}<select aria-label={t('gmail.support.issue_category', "Issue category")} value={category} required onChange={event => setCategory(event.target.value)}><option value="">{t('gmail.support.choose_an_option', "Choose an option")}</option>{categories.map((item, index) => <option key={item} value={item}>{t(`gmail.support.category${index}`, item)}</option>)}</select></label>}
            <label>{intent === 'issue' ? t('gmail.support.describe_issue', 'Describe your issue (required)') : t('gmail.support.describe_idea', 'Describe your suggestion (required)')}<textarea aria-label={t('gmail.support.feedback_description', "Feedback description")} value={description} required maxLength={10000} onChange={event => setDescription(event.target.value)} /></label>
            <p className="mailflow-gmail-support-note">{t('gmail.support.please_do_not_include_passwords_or_sensitive_information', "Please do not include passwords or sensitive information.")}</p>
          </>}
          <button onClick={() => setScreenshot(!screenshot)} aria-pressed={screenshot}>{screenshot ? t('gmail.support.remove_screenshot', 'Remove screenshot preview') : t('gmail.support.add_screenshot', 'Add blank screenshot preview')}</button>
          {screenshot && <div className="mailflow-gmail-blank-preview" role="img" aria-label={t('gmail.support.blank_local_screenshot_preview_no_mail_captured', "Blank local screenshot preview; no mail captured")}>{t('gmail.support.blank_local_preview_no_mail_captured', "Blank local preview. No mail captured.")}</div>}
          <label className="mailflow-gmail-check"><input type="checkbox" checked={emailUpdates} onChange={event => setEmailUpdates(event.target.checked)} />{t('gmail.support.allow_email_updates_preference_only', "Allow email updates (preference only)")}</label>
          <p className="mailflow-gmail-support-note">{t('gmail.support.this_choice_is_saved_locally_it_does_not', "This choice is saved locally. It does not subscribe you to email updates.")}</p>
          <div className="mailflow-gmail-support-legal">{['Account and system information', 'Privacy', 'Terms', 'Legal Help'].map((label, index) => <button key={label} onClick={() => setNotice(label === 'Legal Help' ? t('gmail.support.legal_notice', 'Legal support is not connected. This local form cannot submit legal requests.') : t('gmail.support.privacy_notice', 'Only the fields you enter here are saved to this tab’s browser session. Nothing is transmitted and no account or system information is collected.'))}>{t(`gmail.support.legal${index}`, label)}</button>)}</div>
          {notice && <div role="status"><p>{notice}</p><button onClick={() => setNotice('')}>{t('gmail.support.dismiss_notice', "Dismiss notice")}</button></div>}
          {error && <p role="alert">{error}</p>}
        </>}
      </div>
      {screen === 'feedback' && intent && !saved && <footer><button onClick={review ? save : () => setReview(true)} disabled={!canSubmit}>{review ? t('gmail.support.save_locally', 'Save feedback locally') : t('gmail.support.next_review', 'Next: Review')}</button></footer>}
    </section>
  </div>, document.body);
}
