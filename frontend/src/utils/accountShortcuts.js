// Account shortcuts do not depend on whether the folder drawer is mounted. Disabled
// accounts do not occupy a number, matching the available account actions in the palette.
export function accountForShortcut(action, state) {
  const number = /^goAccount([1-9])$/.exec(action)?.[1];
  if (!number) return null;
  return (state.accounts || []).filter(account => account.enabled !== false)[Number(number) - 1] || null;
}

export function runAccountShortcut(action, state) {
  const account = accountForShortcut(action, state);
  if (!account) return false;
  state.setShowContacts(false);
  state.setSearchQuery('');
  state.setSelectedAccount(account.id, 'INBOX');
  return true;
}
