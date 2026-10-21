// Keep the new Fastmail API credential inside core. Preserve existing plugin fields.
export function pluginAccount(account) {
  if (!account || typeof account !== 'object') return account;
  const copy = { ...account };
  delete copy.fastmail_api_token;
  return copy;
}

export function pluginContext(context) {
  return context?.account ? { ...context, account: pluginAccount(context.account) } : context;
}
