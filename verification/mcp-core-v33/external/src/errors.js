// A problem with what a tool was asked to do, explained in words the model can act on.
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

// The token cannot be used by this server at all (it lacks the read scope).
export class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeError';
  }
}

export const NEEDS_READ_SCOPE =
  'This token needs the read scope: mailflow-mcp has to find messages before it can organize them or draft replies. ' +
  'Create a token with read (plus organize or draft if you want them) in MailFlow under Settings → Security → API tokens.';
