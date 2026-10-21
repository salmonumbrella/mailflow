import { ToolError } from './errors.js';
import { MailflowError } from './mailflowClient.js';
import { accountLabel } from './format.js';

export async function loadAccounts(client) {
  const accounts = await client.listAccounts();
  if (!Array.isArray(accounts)) {
    throw new MailflowError("MailFlow's account list was not a list (check MAILFLOW_URL).", { code: 'not_mailflow' });
  }
  return accounts;
}

export function isUnified(account) {
  return account.enabled !== false && account.include_in_unified_inbox !== false;
}

export function findAccount(accounts, accountId) {
  const wanted = String(accountId).toLowerCase();
  const account = accounts.find(entry => String(entry.id).toLowerCase() === wanted);
  if (!account) throw new ToolError(`No MailFlow account has account_id=${accountId} (list_accounts shows them).`);
  return account;
}

// MailFlow quietly falls back to the unified inbox for an unknown or disabled account, so both
// are refused here instead of returning some other account's mail.
export function requireEnabledAccount(accounts, accountId) {
  const account = findAccount(accounts, accountId);
  if (account.enabled === false) {
    throw new ToolError(`Account ${accountLabel(account)} (account_id=${account.id}) is disabled in MailFlow; enable it there or choose another account.`);
  }
  return account;
}

function labels(list) {
  return list.map(account => `${accountLabel(account)} (account_id=${account.id})`).join(', ');
}

export function unifiedScope(accounts) {
  return {
    included: accounts.filter(isUnified),
    notUnified: accounts.filter(account => account.enabled !== false && account.include_in_unified_inbox === false),
    disabled: accounts.filter(account => account.enabled === false),
  };
}

// Says exactly which accounts a unified request covered, and which it left out and why.
export function describeUnifiedScope(accounts, { snoozed = false, verb = 'Covers' } = {}) {
  const { included, notUnified, disabled } = unifiedScope(accounts);
  const covered = snoozed ? [...included, ...notUnified] : included;
  const left = [];
  if (!snoozed && notUnified.length) left.push(`${labels(notUnified)} — not in the unified inbox; name it with accountId`);
  if (disabled.length) left.push(`${labels(disabled)} — disabled`);
  const head = covered.length ? `${verb} ${labels(covered)}.` : `${verb} no account.`;
  return left.length ? `${head} Not included: ${left.join('; ')}.` : head;
}

export function accountNames(accounts) {
  return new Map(accounts.map(account => [String(account.id).toLowerCase(), accountLabel(account)]));
}
