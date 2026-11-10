import { CSRF_HEADER, CSRF_VALUE } from '../../utils/api.js';

async function request(method, path, body) {
  const response = await fetch(`/api/private-notes/${path}`, {
    method, credentials: 'include',
    headers: { [CSRF_HEADER]: CSRF_VALUE, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 423) window.dispatchEvent(new CustomEvent('mailflow:locked'));
    if (response.status === 401) window.dispatchEvent(new CustomEvent('mailflow:session_expired'));
    throw Object.assign(new Error(data.error || 'Unable to save private notes.'), { status: response.status, data });
  }
  return data;
}

export const privateNotesApi = {
  get: messageId => request('GET', encodeURIComponent(messageId)),
  add: (messageId, body) => request('POST', encodeURIComponent(messageId), body),
  remove: (messageId, noteId, version) => request('DELETE', `${encodeURIComponent(messageId)}/${encodeURIComponent(noteId)}`, { version }),
};
