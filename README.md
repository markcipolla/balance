# balance

An Anthropic Messages API proxy that pools multiple Claude accounts (Claude Code / Max / Pro OAuth subscriptions *and* API keys) and farms requests across them. Any tool that talks to `api.anthropic.com` — opencode, Zed's Anthropic provider, custom scripts, the Anthropic SDK — can point at `balance` and get a pooled backend transparently.

## What it does

- Speaks the Anthropic Messages API (`POST /v1/messages`, streaming or not).
- Holds a mixed pool of:
  - **Subscriptions** — Claude Code OAuth (access + refresh token, auto-refreshed).
  - **API keys** — `sk-ant-api03-...`.
- Prefers subscriptions first (uses up sub quota before falling back to paid API-key quota), round-robins within each tier.
- Watches `anthropic-ratelimit-*` and `retry-after` response headers. On 429 the account is parked on cooldown; the request retries on the next available account.
- Short-circuits with a synthetic 429 (and `retry-after`) if every account is on cooldown — no wasted probes.
- Injects the "You are Claude Code" system-prompt prefix that Anthropic's OAuth-auth path requires, so arbitrary clients Just Work.
- Passes streaming SSE responses through unchanged.

## Requirements

- Bun 1.1+
- One or more Claude accounts (subscription or API key)

## Install

### Homebrew (once the first release ships)

```bash
brew install markcipolla/tap/balance
```

### From source

```bash
bun install
bun run build          # dist/balance — single native binary
# or run without compiling:
bun run src/index.ts serve
```

## Add accounts

```bash
bun run src/index.ts init                      # creates ./config.json
```

### Subscriptions (OAuth)

Run the OAuth flow directly — no Claude Code install needed:

```bash
bun run src/index.ts claude subscription add --name work
# Open this URL in a browser, sign in to the Claude account,
# then paste the code (from the callback page).
#
#   https://claude.ai/oauth/authorize?...
#
# Paste code#state (or just code): _
```

Repeat for each subscription. Flags:
- `--name <name>` — label (defaults to email, then a timestamp).
- `--no-browser` — just print the URL (useful over SSH).
- `--config <path>` — target config (default `./config.json`).

If you already have Claude Code logged in and just want to lift those tokens:

```bash
# macOS Keychain
security find-generic-password -s "Claude Code-credentials" -w \
  | bun run src/index.ts claude subscription import - --name work

# Or a JSON credentials file
bun run src/index.ts claude subscription import ~/.claude/.credentials.json --name personal
```

### API keys

```bash
bun run src/index.ts claude api add sk-ant-api03-... --name prod
bun run src/index.ts claude api add --name backup      # prompts for the key
```

### List / remove

```bash
bun run src/index.ts claude subscription list
bun run src/index.ts claude api list
bun run src/index.ts claude subscription remove work
bun run src/index.ts claude api remove prod
```

Or the flat aliases: `balance list`, `balance remove <name>`.

## Run

```bash
bun run src/index.ts serve
# balance listening url=http://127.0.0.1:8787 accounts=3
```

## Point clients at it

### opencode

Either export env vars in the shell you run `opencode` from:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=any-value    # required by opencode; ignored by balance unless auth_token is set
opencode
```

…or put it in `~/.config/opencode/opencode.jsonc` (or per-project `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:8787",
        "apiKey": "any-value"
      }
    }
  }
}
```

If opencode has been OAuthed against Anthropic (`opencode auth login anthropic`), that OAuth token wins over these options — clear it first with `opencode auth logout anthropic`.

### Anything else speaking the Anthropic API

Same env vars work for the Anthropic SDK, Zed's Anthropic provider, Claude Code itself, custom scripts:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=any-value
```

## Config reference

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "upstream": "https://api.anthropic.com",
  "auth_token": null,
  "inject_claude_code_identity": true,
  "log_level": "info",
  "claude": {
    "subscriptions": [
      {
        "name": "work",
        "access_token": "sk-ant-oat01-...",
        "refresh_token": "sk-ant-ort01-...",
        "expires_at": 1788000000000
      }
    ],
    "api_keys": [
      { "name": "prod", "key": "sk-ant-api03-..." }
    ]
  }
}
```

- `auth_token` — if set, clients must send it as `Authorization: Bearer <token>` or `x-api-key: <token>`. Leave as `null` on trusted localhost.
- `inject_claude_code_identity` — required for OAuth requests to succeed. Turn off only if your client already sends the "You are Claude Code" prefix.
- Env overrides: `BALANCE_HOST`, `BALANCE_PORT`, `BALANCE_AUTH_TOKEN`, `BALANCE_LOG_LEVEL`.

A legacy top-level `accounts` array is auto-migrated into `claude.subscriptions` on load.

## Endpoints

- `POST /v1/messages` — proxied; streaming supported
- `POST /v1/messages/count_tokens` — proxied
- `GET  /v1/models` — static list; served locally so client model pickers work
- `GET  /health` — liveness
- `GET  /status` — per-account snapshot: kind, in-flight, cooldown, rate-limit remaining, expiry

## Releasing

Releases are cut by tag and shipped as prebuilt binaries via `markcipolla/homebrew-tap`.

**One-time setup**
1. Create a fine-grained PAT with `Contents: Read and write` on `markcipolla/homebrew-tap` (nothing else).
2. In this repo → *Settings → Secrets and variables → Actions → New repository secret*: name `HOMEBREW_TAP_TOKEN`, value the PAT.

**Cutting a release**
```bash
# Bump the version in package.json (must match the tag), then:
git tag v0.2.0
git push --tags
```
The `release` workflow will:
1. Cross-compile four binaries: darwin arm64/amd64, linux arm64/amd64.
2. Publish `balance_<version>_<os>_<arch>.tar.gz` to a new GitHub Release.
3. Render `Formula/balance.rb` and push it to `markcipolla/homebrew-tap` on `main`.

If `HOMEBREW_TAP_TOKEN` is missing the workflow still publishes the Release — it just skips the tap push (log line will point at how to add the token).

**Testing the build locally**
```bash
bun run build:all      # produces dist/balance_<version>_<os>_<arch>.tar.gz + .sha256 for each
```

## Notes

- Only pool accounts you own. Anthropic's ToS applies to whichever subscriptions/keys you use; balance is plumbing, not a workaround for account limits.
- Token refresh writes updated tokens back to `config.json` atomically (temp file + rename). Keep the file mode restrictive: `chmod 600 config.json`.
- Cooldown is derived from `retry-after` when present, then the `anthropic-ratelimit-*-reset` timestamps. A 401 parks the account briefly (30s) so a bad token doesn't hot-loop.
