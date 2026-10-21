# mailflow-mcp

An MCP server that lets Claude, and other MCP clients, work with the mail in a self-hosted [MailFlow](https://github.com/maathimself/mailflow): search and read it, organize it, and save drafts for you to review and send.

This is an independent companion project, not part of MailFlow. It talks to MailFlow only through MailFlow's HTTP API, with a MailFlow API token. Moves, folders and drafts therefore go through MailFlow's own handling and its own checks; nothing here touches IMAP or MailFlow's database.

- [Requirements](#requirements)
- [Create a token](#create-a-token)
- [What it can and cannot do](#what-it-can-and-cannot-do)
- [Tools](#tools)
- [Use it with Claude Code](#use-it-with-claude-code)
- [Use it with Claude Desktop](#use-it-with-claude-desktop)
- [Other MCP clients](#other-mcp-clients)
- [Remote mode (HTTP)](#remote-mode-http)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- **A MailFlow build with API tokens.** Tokens are proposed in [maathimself/mailflow#617](https://github.com/maathimself/mailflow/issues/617). Until a MailFlow release includes them, you need a MailFlow build that has the token feature. Against an older MailFlow this server stops with "This MailFlow server … has no API token support".
- **Node.js 20 or later** where the server runs.
- **git**, for the `npx github:…` install below (or use a local clone).

## Create a token

1. An administrator turns tokens on: MailFlow **Settings → Security → Allow API tokens on this server**. They are off by default.
2. In **Settings → Security → API tokens**, create a token. Give it **read**, plus **organize** and **draft** if you want those; organize and draft both need read, because this server finds messages before it acts on them, and it refuses a token without read.
3. Choose an expiry, up to a year, and confirm as MailFlow asks: with your two-factor code, your password, or, for an account that signs in through single sign-on, a sign-in through your provider in the last 10 minutes. A token confirmed through single sign-on lasts 30 days at most.
4. Copy the token (`mfat_…`). MailFlow shows it once.

Treat the token like a password: it opens your mailbox to whatever holds it, within its scopes. Revoke it in the same place when you no longer need it.

## What it can and cannot do

**The token sets the limits.** MailFlow checks every token request against a fixed list of routes and the token's scopes, so this server can do no more than its token allows, and it offers only the tools those scopes allow.

| Scope | Allows |
|---|---|
| read | accounts and folders, listing, searching and reading mail and conversations, unread counts, contact lookup |
| organize | mark read or unread, star, archive, move, snooze, set a category |
| draft | save a new draft in Drafts |

**It can never** send mail, delete mail, empty a folder, or change settings, rules, accounts or anything else in MailFlow. MailFlow refuses token moves into Trash, Junk, Drafts, Snoozed, All Mail, Starred and folders it does not sync, and refuses to move or archive drafts. Drafts are new, plain-text drafts only: an existing draft is never replaced. A person still presses Send in MailFlow.

**Email content is treated as untrusted.** A message can contain text written to manipulate the AI reading it. So:

- Every piece of text that came from an email (subjects, names, addresses, snippets, bodies, attachment names) is returned inside one `<untrusted-email-content id="…">` block per result, apart from the ids and facts MailFlow itself produced. The id is random and new for every result, the block ends only at the closing marker with the same id, and the model is told so, so an email cannot end the block early. Anything in an email that looks like the marker is removed as well, written with other dashes, widths, scripts or invisible characters included.
- The server's instructions tell the model never to follow instructions found in mail, never to call a tool because an email asks it to, and never to open links or load images from mail.
- HTML is converted to text here; remote images are never fetched.
- Reply recipients are built from MailFlow's structured address fields, never by pasting header text, so a crafted display name cannot add a recipient. A saved draft's result always lists To, Cc and Bcc, and points out a reply going to a Reply-To that is not the sender, recipients who were not on the original message at all, and Bcc addresses that are not the account's automatic Bcc, whether the recipients were worked out or given explicitly.
- Before saving a reply to an INBOX message it asks MailFlow whether a reply draft already exists, and when MailFlow cannot tell, it saves nothing unless told to (`allowDuplicateReply`).

**It is careful with changes.** Archive and move first load each message and skip, with the reason, drafts (as MailFlow defines them: the Draft flag, the Drafts folder or the account's own drafts mapping), snoozed mail, and (unless asked) mail in Sent, Trash or Junk; move also skips mail of an account other than the one named. A conversation read with `read_thread` is the one in the account asked about, so archiving "the conversation" does not reach the same email in your other accounts. Every organize tool reports which ids changed and why any did not. Writes are never retried; when a write may have gone through despite an error, the result says so. A call the client cancels (over stdio), or whose HTTP connection drops, sends nothing more to MailFlow; a write already on its way is left to finish.

**Your mail goes to your model.** Whatever the tools return is read by the AI model your MCP client uses, under that client's terms.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `list_accounts` | read | Accounts with their ids, send-as aliases, whether each is enabled and in the unified inbox, last sync and sync errors |
| `list_folders` | read | One account's folders: exact paths, roles, unread and total counts, which cannot be move targets and which MailFlow does not sync; `query` finds folders by part of their path |
| `list_messages` | read | One folder of one account, newest first (the Snoozed view soonest to come back first); without `accountId` the unified inbox or the Snoozed view |
| `search_mail` | read | MailFlow search with its operators (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `after:`, `before:`, `in:`, and `-` to negate any but `in:`) |
| `read_message` | read | One message: headers, attachment names, body as text (up to 40,000 characters) |
| `read_thread` | read | A whole conversation in one account, across its folders, with the newest bodies; `allAccounts` adds the copies in your other accounts |
| `unread_counts` | read | Unread mail per account, the unified total, snoozed mail and categories |
| `find_contacts` | read | Addresses by name, for drafting |
| `mark_read` | organize | Mark read or unread |
| `star` | organize | Star or unstar |
| `archive` | organize | Move to each account's archive folder |
| `move_messages` | organize | Move to another folder of the same account |
| `snooze`, `unsnooze` | organize | Snooze a message and its reply chain until a time (up to 30 days), or bring it back now |
| `set_category` | organize | Set MailFlow's category (primary, newsletter, promotion, automated, social) |
| `create_draft` | draft | Save a new message or a reply to Drafts |

Messages are identified by MailFlow's ids, which change when a message is moved or archived. Results also give each message's Message-ID and account, and `read_message` (or `read_thread`) with `messageId` and `accountId` finds it again.

Without `accountId`, listing and search cover the accounts in MailFlow's unified inbox, and each result says which accounts that was and which it left out. An unknown or disabled `accountId` is refused rather than quietly widened.

## Use it with Claude Code

```sh
claude mcp add --transport stdio mailflow \
  --env MAILFLOW_URL=https://mail.example.com \
  --env MAILFLOW_TOKEN=mfat_… \
  -- npx -y github:Monkey7539/mailflow-mcp#v0.1.1
```

- The `#v0.1.1` pins a release: updating means changing that ref to a newer tag. Without a ref (`github:Monkey7539/mailflow-mcp`), npx runs whatever the main branch holds at that moment, including changes you have not looked at, so pin it.
- Never add it with `--scope project` while the token is written into the command: project scope saves it in `.mcp.json`, which is meant to be committed. Use the default (local) scope or `--scope user`.
- On Windows, a local clone is more dependable than npx:

  ```sh
  git clone https://github.com/Monkey7539/mailflow-mcp.git
  cd mailflow-mcp
  git checkout v0.1.1
  npm ci
  claude mcp add --transport stdio mailflow --env MAILFLOW_URL=https://mail.example.com --env MAILFLOW_TOKEN=mfat_… -- node C:/path/to/mailflow-mcp/src/cli.js
  ```

`/mcp` in Claude Code shows whether it connected. If it did not, run the same command in a terminal: the server prints the reason on stderr.

## Use it with Claude Desktop

Add an entry to `claude_desktop_config.json` (Settings → Developer → Edit config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "mailflow": {
      "command": "npx",
      "args": ["-y", "github:Monkey7539/mailflow-mcp#v0.1.1"],
      "env": {
        "MAILFLOW_URL": "https://mail.example.com",
        "MAILFLOW_TOKEN": "mfat_…"
      }
    }
  }
}
```

On Windows, npx may also need `"APPDATA": "C:\\Users\\you\\AppData\\Roaming"` in `env`. With a local clone (see above), use `"command": "node"` and `"args": ["C:\\path\\to\\mailflow-mcp\\src\\cli.js"]` instead.

## Other MCP clients

Any client that starts stdio servers can run it: the command is `npx -y github:Monkey7539/mailflow-mcp#v0.1.1` (or `node <clone>/src/cli.js`), with `MAILFLOW_URL` and `MAILFLOW_TOKEN` in its environment. It logs to stderr only; stdout carries the protocol. When stdin closes it answers every request it has already read, then exits, so a script can pipe its requests in.

## Remote mode (HTTP)

`mailflow-mcp http` serves MCP's Streamable HTTP transport at `/mcp`, for clients that connect to a URL instead of starting a process. It holds no token of its own: each request must carry the caller's own token (`Authorization: Bearer mfat_…`), which is passed through to MailFlow, and each request gets its own MCP server bound to that token. It is stateless and answers JSON.

The intended setup runs it as a container beside MailFlow, reachable only through your reverse proxy over HTTPS:

1. Check out this repository next to MailFlow's, and start MailFlow with the overlay in [`deploy/docker-compose.mcp.yml`](deploy/docker-compose.mcp.yml). It runs the container read-only and without capabilities, publishes it on the host's `127.0.0.1:8787` only, and gives it a network of its own that the MailFlow backend joins, so it can reach the backend but not Redis or Postgres. Set `MCP_ALLOWED_HOSTS` to your MCP host name.
2. Point a host name at it through your reverse proxy, over HTTPS; [`deploy/nginx-mcp.conf`](deploy/nginx-mcp.conf) is an example for nginx, with a path-based alternative. `MCP_TRUST_PROXY_HOPS` must equal the number of proxies in front of the container (1 in that example), or the client address MailFlow's rate limits see is wrong.
3. Connect a client:
   - **Claude Code:** `claude mcp add --transport http mailflow https://mcp.example.com/mcp --header "Authorization: Bearer mfat_…"`
   - **claude.ai custom connectors:** request-header authentication is a beta available to a limited set of organisations. It works only if the "Add custom connector" dialog shows a **Request headers** section: choose **No sign-in**, header `Authorization`, value `Bearer mfat_…` (or just `mfat_…`). Never put a personal token in a Team or Enterprise organisation's connector, where everyone would share it. Without that section, use Claude Code or the local stdio server instead. OAuth sign-in is future work.

Keep the endpoint behind HTTPS: the token travels in every request.

The HTTP mode answers:

| Request | Answer |
|---|---|
| `POST /mcp` | MCP over JSON, for a request carrying a valid token |
| `GET /healthz` | 200 `{ "ok": true }` while MailFlow's `/api/health` answers, else 503; used by the container healthcheck |
| `GET` or `DELETE /mcp` | 405: there is no SSE stream or session to end |
| anything else | 404 |

It refuses, before anything reaches MailFlow: a missing or malformed token (401), a `Host` not in `MCP_ALLOWED_HOSTS` or an `Origin` not in `MCP_ALLOWED_ORIGINS` on `/mcp` (403), a token in the URL, percent-encoded or not (400), and a body over 1 MB (413). A token MailFlow rejected is not sent to it again for a minute, or, when MailFlow turned it away for too many failed attempts, for as long as MailFlow said to wait. After 30 failed requests in a minute from one address, requests from there without a well-formed token, or with one MailFlow refused, get 429; a well-formed token MailFlow has not refused always goes through, so junk from an address many clients share cannot lock their tokens out (MailFlow limits failed token attempts itself). A token without the read scope gets 403. It logs one line per request (method, path, status, time; `aborted` when the caller left before the answer) and never a token or mail. When a caller goes away mid-call, the call stops: nothing more is sent to MailFlow for it.

## Configuration

| Variable | Mode | Default | Meaning |
|---|---|---|---|
| `MAILFLOW_URL` | both | (required) | MailFlow's address, e.g. `https://mail.example.com`. `http://` is accepted only to loopback, private, link-local and single-label container names such as `backend`. |
| `MAILFLOW_TOKEN` | stdio | (required) | The `mfat_…` token. Must not be set in http mode. |
| `MAILFLOW_TIMEOUT_MS` | both | 60000 | Time allowed for each MailFlow request. |
| `MAILFLOW_ALLOW_INSECURE_HTTP` | both | | `1` allows `http://` to any address (the token would travel unencrypted). |
| `MCP_HTTP_HOST` | http | `127.0.0.1` | Address to listen on (the Docker image sets `0.0.0.0`). |
| `MCP_HTTP_PORT` | http | 8787 | Port to listen on. |
| `MCP_ALLOWED_HOSTS` | http | | Comma-separated host names `/mcp` answers to (ports ignored). Unset accepts any `Host`, with a warning at startup. |
| `MCP_ALLOWED_ORIGINS` | http | | Comma-separated origins that may send an `Origin` header. A request with any other `Origin` is refused; requests without one (server-to-server clients) are fine. |
| `MCP_TRUST_PROXY_HOPS` | http | 0 | How many reverse proxies are in front, for the client address taken from `X-Forwarded-For`. |

## Troubleshooting

**401 "MailFlow rejected the API token: it is invalid, expired or revoked".** Create a new token. A MailFlow backup restore deletes every token, and a password reset (yours, or an administrator setting your password) revokes all of yours. So do changes to the server's sign-in rules: an administrator turning off password sign-in deletes every token not confirmed through single sign-on, requiring two-factor deletes those confirmed with only a password, turning off your two-factor deletes all of yours, and turning off a single sign-on provider deletes the tokens confirmed through it.

**401 "… because API tokens are turned off on this server".** An administrator turns them on in Settings → Security.

**401 "The API token did not reach MailFlow (check that your proxy forwards the Authorization header)".** Something in front of MailFlow, such as a reverse proxy or a sign-in proxy, removed or replaced the `Authorization` header.

**403.** The text is MailFlow's: a scope the token lacks ("This API token does not have the organize scope"), a request tokens may never make, or a refused destination ("API tokens cannot move mail into Trash, …").

**429.** Wait the time given. MailFlow limits tokens to 600 requests per 5 minutes each and 1,200 per user, 60 token drafts per 10 minutes, and token searches to their own per-user bucket; repeated bad tokens from one address are cut off for a while. In HTTP mode this server also holds back requests without a usable token from an address after 30 failed requests in a minute.

**"This MailFlow server … has no API token support".** It needs a MailFlow build with API tokens; see [Requirements](#requirements).

**"This is not MailFlow's API (check MAILFLOW_URL)" or "MAILFLOW_URL redirects to …".** `MAILFLOW_URL` must be MailFlow's own address, without `/api`. When it redirects, use the address it redirects to.

**403 "API tokens cannot archive into Gmail's All Mail".** On a Gmail account without an archive label or an archive folder mapping, archiving would move the mail to All Mail, which MailFlow does not show or search, so MailFlow refuses token archives there, and refuses the whole request when any message is in such an account. Create a Gmail label named Archive (or choose an archive folder in the account's settings in MailFlow) and archive becomes an ordinary move; meanwhile, archive the other accounts' messages on their own.

**A message id stopped working.** Ids change when mail is moved or archived. Find the message again with `read_message` and its `messageId` and `accountId`, or with `search_mail`.

**Search misses words in message bodies.** MailFlow searches bodies only where it has cached their text, and Gmail accounts often have none. Search by sender or subject instead. To search one folder, pass the exact `folder` path from `list_folders`: `in:` matches folder names loosely and misses folders such as "Deleted Items". A folder cannot be left out of a search: MailFlow reads `-in:spam` as `in:spam`, so such a query is refused.

**"MailFlow does not keep [Gmail]/Starred in sync".** MailFlow does not sync Gmail's All Mail, Starred and Important label views, so what it holds for them is out of date or empty, and this server does not list or search them by folder. `search_mail` with `is:starred` finds starred mail.

**"This token needs the read scope".** Create a token that includes read.

## Development

```sh
npm ci
npm test
```

`npm test` runs the unit tests and integration tests against a fake MailFlow (in `test-support/`), including the stdio binary and the HTTP mode. Node 20 or later.

| Path | |
|---|---|
| `src/cli.js` | The `mailflow-mcp` command |
| `src/config.js` | Environment parsing and validation |
| `src/mailflowClient.js` | The only module that talks to MailFlow |
| `src/html.js`, `src/format.js` | HTML to text, the untrusted-content block, display helpers |
| `src/replies.js` | Reply drafts and recipient formatting, pure functions |
| `src/tools/` | The read, organize and draft tools |
| `src/server.js` | Builds the MCP server and its instructions for a token's scopes |
| `src/stdio.js`, `src/http.js` | The two transports |

## License

[MIT](LICENSE)

## Provider identities and Fastmail masked aliases

These optional tools use MailFlow's authenticated account API, never provider credentials supplied to MCP. The server retains its existing `read` prerequisite. Add `identity:read` to discover `list_gmail_send_as` and `list_fastmail_masked_aliases`; add `identity:write` to discover `create_fastmail_masked_alias`. An identity write grant does not imply an identity read grant. Existing tokens gain neither grant automatically.

Every tool requires an explicit MailFlow `accountId`. Gmail listing requires a Google OAuth account; an app password cannot supply Gmail API inventory. Only primary and accepted send-as addresses are returned. Gmail alias management is unavailable under the current OAuth contract. `api_not_enabled` means the operator must enable the Gmail API for the OAuth project.

Creation requires an explicit request from the calling user, `confirmed:true`, and a unique UUID `clientRequestId`. Optional `forDomain` is an HTTP(S) origin, `description` is bounded and cannot contain reserved correlation markers, and `emailPrefix` accepts lowercase letters, digits and underscore. The provider creates an **enabled** alias; unused pending aliases may expire. No credential, provider URL, state, `createdBy` or account override can be supplied.

Creation is non-idempotent and never automatically retried. After an unknown outcome, a complete ready masked listing for the same account may correlate `clientRequestId`; the public marker is forgeable. One match is correlation only. Zero or multiple matches do not prove that creation failed and never authorize an automatic retry. A caller without `identity:read` cannot list or reconcile and must retain the unknown outcome; the tool does not suggest acquiring broader credentials.

Backend prerequisites are the scoped PAT implementation and exact GET `/api/accounts/:uuid/sender-identities` / POST `/api/accounts/:uuid/masked-emails` routes, plus ownership-checked provider services. Provider errors use fixed allowlisted codes. The existing MCP SDK, authenticated client, redirect refusal, concurrency, cancellation and issued-write lifecycle remain in use.
