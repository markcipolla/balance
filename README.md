# balance

An Anthropic Messages API proxy that pools multiple Claude Code OAuth subscriptions and farms requests across them. Any tool that talks to `api.anthropic.com` — opencode, Zed's Anthropic provider, custom scripts, the Anthropic SDK — can point at `balance` and get a pooled Bearer-token backend transparently.

## What it does

- Exposes a local HTTP endpoint that speaks the Anthropic Messages API (`POST /v1/messages`, streaming or not).
- Holds N Claude Code OAuth accounts (access token + refresh token per account).
- Picks an available account per request; round-robins between them.
- Refreshes OAuth tokens automatically before they expire and writes the new tokens back to the config.
- Watches `anthropic-ratelimit-*` and `retry-after` response headers. If an account hits 429, it's parked on cooldown; the request is retried on the next account.
- Short-circuits with 429 (and a `retry-after` header) if every account is on cooldown, so we don't waste probes.
- Injects the "You are Claude Code" system-prompt prefix that Anthropic's OAuth-auth path requires — clients don't need to send it themselves.
- Passes streaming SSE responses through unchanged.

## Requirements

- Bun 1.1+.
- One or more Claude subscriptions authenticated via the `claude` CLI (`claude login`).

## Install

```bash
bun install
```

Optional standalone binary:

```bash
bun run build     # produces dist/balance
```

## Configure

```bash
bun run src/index.ts init ./config.json
```

### Add accounts

The simplest way — `balance login` runs the OAuth flow itself (no Claude Code install needed). It prints an authorize URL, opens it in your browser, and prompts you to paste the code back:

```bash
bun run src/index.ts login --name work --config ./config.json
# Open this URL in a browser, sign in to the Claude account you want to add,
# then paste the code (the value after 'code=' on the resulting page).
#
#   https://claude.ai/oauth/authorize?...
#
# Paste code#state (or just code): _
```

Run it again for each subscription you want in the pool. If you omit `--name`, the account is named after its email address.

Flags:
- `--name <name>` — label for the account (defaults to email, then a timestamp).
- `--no-browser` — just print the URL, don't try to open it (useful over SSH).
- `--config <path>` — target config file. Created if missing.

### Or import an existing Claude Code login

If you already have Claude Code logged in and just want to pull those tokens over:

**macOS (Keychain):**

```bash
security find-generic-password -s "Claude Code-credentials" -w \
  | bun run src/index.ts add - --name work --config ./config.json
```

**Linux / older Claude Code (`~/.claude/.credentials.json`):**

```bash
bun run src/index.ts add ~/.claude/.credentials.json --name personal --config ./config.json
```

`add` accepts:
- Claude Code's native shape: `{"claudeAiOauth": {"accessToken": "...", "refreshToken": "...", "expiresAt": <ms>}}`
- The flat `balance` account shape: `{"access_token": "...", "refresh_token": "...", "expires_at": <ms>}`
- `-` to read from stdin.

### List / remove accounts

```bash
bun run src/index.ts list --config ./config.json
bun run src/index.ts remove personal --config ./config.json
```

## Run

```bash
bun run src/index.ts serve --config ./config.json
# balance listening url=http://127.0.0.1:8787 accounts=3
```

Point your Anthropic client at it:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=any-value        # ignored unless you set auth_token in config
```

opencode (which uses the Anthropic provider under the hood) picks this up automatically.

## Config reference

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "upstream": "https://api.anthropic.com",
  "auth_token": null,
  "inject_claude_code_identity": true,
  "log_level": "info",
  "accounts": [
    {
      "name": "work",
      "access_token": "sk-ant-oat01-...",
      "refresh_token": "sk-ant-ort01-...",
      "expires_at": 1788000000000
    }
  ]
}
```

- `auth_token` — if set, clients must send it as `Authorization: Bearer <token>` or `x-api-key: <token>`. Leave as `null` on trusted localhost.
- `inject_claude_code_identity` — required for OAuth requests to succeed. Only turn off if your client already sends the Claude Code identity prefix.

Env overrides: `BALANCE_HOST`, `BALANCE_PORT`, `BALANCE_AUTH_TOKEN`, `BALANCE_LOG_LEVEL`.

## Endpoints

- `POST /v1/messages` — proxied; streaming supported
- `POST /v1/messages/count_tokens` — proxied
- `GET  /v1/models` — static list; served locally so client model pickers work
- `GET  /health` — liveness
- `GET  /status` — per-account snapshot: in-flight count, cooldown, rate-limit remaining, token expiry

## Notes

- Only pool accounts you own. Anthropic's ToS applies to whichever subscriptions you use; balance is a plumbing tool, not a workaround for account limits.
- Token refresh writes updated tokens back to `config.json` atomically (temp file + rename). Keep the file mode restrictive (`chmod 600 config.json`).
- Rate-limit cooldown is derived from `retry-after` when present, then the `anthropic-ratelimit-*-reset` timestamps. A 401 also parks the account briefly (30s) so a bad token doesn't hot-loop.
