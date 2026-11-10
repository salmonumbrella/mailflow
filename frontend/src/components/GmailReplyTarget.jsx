import { useCallback } from 'react';

export default function GmailReplyTarget({ onTarget, messageId, messageMid, threadId, accountId }) {
  const attach = useCallback(element => {
    onTarget?.(element ? { element, messageId, messageMid, threadId, accountId } : null);
  }, [onTarget, messageId, messageMid, threadId, accountId]);
  return <div ref={attach} className="mailflow-inline-reply-target" />;
}
