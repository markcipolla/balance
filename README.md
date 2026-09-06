# balance

Pick a Claude account, launch Claude Code with it. Multiple Claude Code accounts on one machine, without `claude logout` / `claude login` gymnastics.

## What it does

- Each **account** you add lives in its own isolated `CLAUDE_CONFIG_DIR` under `~/.balance/accounts/<name>/` — its own OAuth credentials, its own Claude Code sessions and settings.
- `balance` (bare, no args) fetches live 5-hour and weekly utilization per account, shows a picker, launches Claude Code as whichever account you pick.
- `balance run <name>` skips the picker.
- `balance account add` runs the Claude OAuth flow and saves the resulting credentials into a new account dir. No `claude` install needed to add accounts.
- `balance shared init` hoists the *configuration* half of an account dir — skills, agents, commands, plugins, MCP servers, settings, memory — into one `~/.balance/shared` that every account launches with.

Balance is a *launcher*, not a proxy. It sets `CLAUDE_CONFIG_DIR`, writes the account's credentials into the Keychain slot Claude Code TUI reads from (on macOS), and hands off to `claude`. Every request goes to the real, sanctioned Claude Code CLI — no request rewriting, no header spoofing, no compat surface to break.

**macOS caveat**: Claude Code TUI on macOS reads OAuth from a single machine-wide Keychain slot (service: `Claude Code-credentials`). balance overwrites that slot each launch, which means running `claude` directly outside balance will use whichever account balance most recently launched. The first launch may trigger a Keychain permission dialog — pick "Always Allow" to skip it thereafter.

That slot is Claude Code's whole credential store, not just the Anthropic token — MCP server logins live there too, under `mcpOAuth`. balance rewrites only `claudeAiOauth` and carries the rest across, so `claude mcp login` survives a relaunch. (On Linux the store is the per-account `.credentials.json`, so MCP logins stay per-account there.)

## Requirements

- Bun 1.1+ (only for building from source; the released binary is standalone).
- Claude Code installed on `PATH`: `npm install -g @anthropic-ai/claude-code`.
- One or more Claude accounts.

## Install

### Homebrew

```bash
brew install markcipolla/tap/balance
```

### From source

```bash
bun install
bun run build         # dist/balance
```

## First run

```bash
balance account add --name work
# Open the printed URL, sign in to the Claude account you want to add,
# then paste the code back.

balance account add --name personal    # …repeat per account
```

Then just:

```bash
balance
```

You'll see something like:

```
Accounts:

 1. work  <mark@example.com>
    5h  ██████▏░░░░░░░ 44% (3h)
    7d  ██▊░░░░░░░░░░░ 20% (5d)

 2. personal
    5h  ░░░░░░░░░░░░░░ —
    7d  ░░░░░░░░░░░░░░ —

Pick account [1-2, default: 1 (work)]:
```

Pick one, and Claude Code launches signed in as that account.

## Commands

```
balance                                       pick + launch
balance run [<name>] [-- <claude args>...]   launch <name>; picker if omitted
                                              args after -- forward to claude

balance account add   [--name <n>] [--no-browser]   OAuth login, save as isolated account
                                                     an existing --name is re-authenticated
                                                     in place, keeping its profile dir
balance account list  [--usage]                     list accounts (add --usage for live 5h/7d)
balance account switch <name>                       set default account
balance account remove <name>                       delete an account (removes credentials)

balance shared init   [--from <account>]            set up ~/.balance/shared, optionally
                                                     lifting one account's config into it
balance shared link   [--force]                     (re)link every account to the shared layer
balance shared status                               show what is shared, and which accounts
                                                     are actually linked to it

balance --help          full usage
balance --version       print version
```

Aliases from the v0.x proxy era (`login`, `list`, `remove`, `switch`) still work.

### Re-authenticating an account

If an account's refresh token stops working — `invalid_grant` on launch, or Claude
Code 401s with "OAuth access token has been revoked" — re-run `add` with that
account's name:

```bash
balance account add --name work
```

Same name means the same account: balance replaces its credentials and leaves the
profile dir (sessions, history, `.claude.json`) alone. `remove` followed by `add`
also works, but `remove` deletes the profile dir along with the credentials.

Note that signing in again from *inside* a balance-launched Claude Code (`/login`)
does not fix the account: balance passes the token via `CLAUDE_CODE_OAUTH_TOKEN`,
so Claude Code treats it as externally managed and never writes the new tokens
back to the account dir. The fresh login lasts only for that session.

## Shared config

Every account dir is a full `CLAUDE_CONFIG_DIR`, which mixes two different
things: **identity** (OAuth credentials, `oauthAccount`, per-account caches)
and **configuration** (skills, agents, commands, plugins, MCP servers,
settings, memory). Only the first has any reason to be per-account. Without
sharing, a second login means re-installing every skill and re-approving every
MCP server — the accounts are the same person either way.

```bash
balance shared init --from work   # lift work's config up into ~/.balance/shared
balance shared status             # see what's shared and who's linked
```

```
~/.balance/shared/
  CLAUDE.md      user memory, @imported by each account's CLAUDE.md
  settings.json  passed to Claude Code as --settings
  mcp.json       passed to Claude Code as --mcp-config
  projects.json  per-project MCP approvals and trust, carried between accounts
  skills/        symlinked into every account dir
  agents/          "
  commands/        "
  plugins/         "
  memory/<project>/   symlinked in as projects/<project>/memory
```

The mechanism differs per item because it has to. Directories are symlinked.
Files Claude Code rewrites itself are not — an atomic write-and-rename
replaces a symlink with a real file and silently un-shares it — so settings
and MCP servers go in as launch flags, and user memory as an `@import` line
that survives being rewritten.

`.claude.json` gets a narrower treatment again. It holds account identity
*and* the per-project state that decides whether a repo's `.mcp.json` servers
come up at all (`enabledMcpjsonServers`, `hasTrustDialogAccepted`), so balance
seeds just those keys before launch and reads back what the session decided
after it exits. Approve a project's MCP servers once, in any account, and the
rest inherit it.

Nothing here is on until `~/.balance/shared` exists. `shared init` never
overwrites: a real directory where a symlink should go is reported and left
alone until you re-run with `--force`, which moves it to `<name>.pre-balance`
first. Turn the layer off for one launch with `--no-shared`, or entirely with
`"shared": {"enabled": false}` in `config.json`.

**What this shares that you may not want shared**: trust dialogs. Accepting
the trust prompt for a directory in one account accepts it for the others. Set
`"projects": false` if you'd rather each account decide for itself.

## Config

`~/.balance/config.json`:

```json
{
  "active": "work",
  "claude_binary": "claude",
  "log_level": "info",
  "shared": {
    "enabled": true,
    "dirs": ["skills", "agents", "commands", "plugins"],
    "mcp": true,
    "strict_mcp": false,
    "settings": true,
    "memory": true,
    "projects": true
  },
  "accounts": [
    { "name": "work", "email": "mark@example.com", "last_used_at": 1788418333140, "added_at": 1788418275400 }
  ]
}
```

Each account's OAuth credentials live at `~/.balance/accounts/<name>/.credentials.json` (mode 0600), Claude Code's native format.

Env overrides:
- `BALANCE_CLAUDE_BINARY` — path to the `claude` executable (default: `claude` on PATH).
- `BALANCE_LOG_LEVEL` — `debug | info | warn | error`.
- `BALANCE_SHARED` — set to `0` to disable the shared config layer.

## Notes

- **Passing args to Claude Code**: `balance run work -- --model opus --print "hello"` — everything after `--` is forwarded verbatim.
- **Team plans**: Claude Code itself works on Team subscriptions. Non-Claude-Code agents (opencode, aider, Cline, etc.) via HTTP proxies do *not* — Anthropic's classifier routes tool-bearing requests to workspace extra-usage on Team plans regardless of how the proxy authenticates. See [Meridian issue #516](https://github.com/rynfar/meridian/issues/516). balance sidesteps this entirely by launching Claude Code itself, which is on the sanctioned path.
- **Not a proxy**: balance v0.x was an Anthropic-API-compatible proxy that tried to pool subscriptions for third-party clients. That approach is fundamentally blocked on Team plans and got dropped in v1.0.0. Migration from an old `config.json` is automatic on first run.

## Releasing

Releases ship as prebuilt binaries via `markcipolla/homebrew-tap`, tag-triggered.

```bash
git tag v1.0.0 && git push --tags
```

The workflow cross-compiles for darwin arm64/amd64 and linux arm64/amd64, publishes the release, and pushes a fresh `Formula/balance.rb` to the tap.

Requires the `HOMEBREW_TAP_TOKEN` repo secret (fine-grained PAT with `Contents: Read and write` on `markcipolla/homebrew-tap`). Without it, the workflow still publishes the GitHub Release and skips the tap push with a warning.
