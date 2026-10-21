import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';

// One view's display memo, never shared with compose or send authorization.
// The producer owns provider detection and the opaque configuration revision.
export function useReaderSenderIdentities({ userId, account, configRevision, refreshKey = 0, sessionGeneration = 0, locked = false }) {
  const accountId = account?.id;
  const eligible = Boolean(userId && !locked && accountId && account.enabled === true
    && account.fastmail_verification_supported === true
    && typeof configRevision === 'string' && configRevision);
  const key = eligible ? JSON.stringify([userId, accountId, configRevision, refreshKey, sessionGeneration]) : null;
  const pending = useRef(null);
  const [display, setDisplay] = useState(null);

  useEffect(() => {
    setDisplay(null);
    if (!key) {
      pending.current = null;
      return;
    }
    let active = true;
    // Reuse the request during an effect replay as well as ordinary rerenders.
    if (pending.current?.key !== key) {
      pending.current = { key, promise: Promise.resolve().then(() => api.getSenderIdentities(accountId)) };
    }
    pending.current.promise.then(inventory => {
      if (!active || inventory?.accountId !== accountId || inventory.configRevision !== configRevision) return;
      setDisplay({ key, inventory });
    }, () => {
      if (active) setDisplay(null);
    });
    return () => { active = false; };
  }, [key, accountId, configRevision]);

  // A key change hides old evidence in this render, before effect cleanup runs.
  return key && display?.key === key ? display.inventory : undefined;
}
