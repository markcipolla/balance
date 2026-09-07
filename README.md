# balance

Pick a Claude account, launch Claude Code with it. Multiple Claude Code accounts on one machine, without `claude logout` / `claude login` gymnastics.

## What it does

- Each **account** you add lives in its own isolated `CLAUDE_CONFIG_DIR` under `~/.balance/accounts/<name>/` — its own OAuth credentials, its own Claude Code sessions and settings.
- `balance` (bare, no args) fetches live 5-hour and weekly utilization per account, shows a picker, launches Claude Code as whichever account you pick.
- `balance run <name>` skips the picker.
- `balance account add` runs the Claude OAuth flow and saves the resulting credentials into a new account dir. No `claude` install needed to add accounts.
- The *configuration* half of an account dir — skills, agents, commands, plugins, MCP servers, settings, memory — is hoisted into one `~/.balance/shared` that every account launches with. Automatic; there is nothing to set up.
- That includes **claude.ai connectors**, which live server-side rather than in any file: balance re-declares them as ordinary HTTP servers in the shared set, so every account launches with the same MCP servers. See [claude.ai connectors](#claudeai-connectors).

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

balance shared                                      show what the shared config layer holds
balance shared sync [<name>]                        re-read claude.ai connectors into the shared MCP set

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

So balance shares the second half, with no setup step. Launching an account
merges whatever config it has accumulated up into `~/.balance/shared` and
links it back down; each account joins the layer the first time you launch it,
and later launches find the symlinks already there.

```
~/.balance/shared/
  CLAUDE.md      user memory, @imported by each account's CLAUDE.md
  settings.json  passed to Claude Code as --settings
  mcp.json       passed to Claude Code as --mcp-config
  connectors.json  which servers in mcp.json came from a claude.ai connector
  projects.json  per-project MCP approvals and trust, carried between accounts
  skills/        symlinked into every account dir
  agents/          "
  commands/        "
  plugins/         "
  memory/<project>/   symlinked in as projects/<project>/memory
```

`balance shared` shows what's in there and which accounts are linked to it.

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

### claude.ai connectors

Connectors are the awkward case. Everything else in an account dir is a file
balance can hoist; a claude.ai connector is resolved server-side from the OAuth
identity and exists nowhere on disk. So two accounts see two different sets of
MCP servers and there is no file to symlink to fix it.

balance reads them out of the only interface that exposes them — `claude mcp
list`, run per account — and re-declares each one in `shared/mcp.json` as an
ordinary HTTP server, which is all a connector is underneath. The shared set is
the **union across every account**: a connector enabled on one account is
available from all of them.

Because the account they came from would otherwise see each connector twice —
once from the shared file, once from its own server-side set — turning this on
implies `--strict-mcp-config`. That is what makes the set *one* set.

Names are carried across verbatim. MCP OAuth tokens live in the Keychain blob
balance already preserves between launches, so keeping the exact name is what
lets an existing `claude mcp login` still match the re-declared server. On
macOS that means one login per server, shared by every account; on Linux the
token store is per-account, so logins stay per-account there.

Syncing is automatic and paced. A cold start blocks — there is no shared set
yet, so skipping it would launch with no MCP servers at all. After that a
listing older than `connector_ttl_hours` (default 24) refreshes alongside the
session rather than delaying it, and applies from the next launch. `balance
shared sync [<name>]` forces it when you have just added a connector and don't
want to wait.

A connector is only retired from the shared set once it has disappeared from
*every* account's last known listing — one account dropping it is not enough,
since it may simply belong to another. Servers you wrote into `mcp.json` by
hand are never touched.

Strict mode would also hide a repo's own `.mcp.json`, which is a bad trade for
a dev tool, so balance merges those back in itself — but only the servers the
account has already approved. Passing the repo file through wholesale would
grant the approval that the "use this repo's MCP servers?" prompt exists to
withhold. The merged result is written to `<account>/balance-mcp.json` at
launch and that is what `--mcp-config` gets.

Set `"connectors": false` to leave each account with its own claude.ai set.

### How the merge resolves

Adoption is entry by entry, so two accounts that both have config end up with
the union of it: every skill, agent, command and marketplace either account
had. Where they genuinely collide:

- `MEMORY.md` indexes are unioned line by line.
- `installed_plugins.json` and `known_marketplaces.json` are merged key by
  key, and marketplace `installLocation` paths — which point at whichever
  account dir installed them — are rewritten to the shared copy, so removing
  that account doesn't break the marketplace for the others.
- Anything left, like two different versions of the same skill, is parked at
  `<account>/<dir>.pre-balance/…` rather than being merged or deleted. The
  shared copy wins; yours is still on disk if you want it back.

Nothing is deleted, and the whole thing is idempotent — a second launch of an
account that's already linked walks a handful of `lstat` calls and stops.

Opt out for one launch with `--no-shared`, or for good with
`"shared": {"enabled": false}` in `config.json`; individual pieces have their
own switches there too.

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
    "connectors": true,
    "connector_ttl_hours": 24,
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
- `BALANCE_HOME` — relocate everything balance owns (default: `~/.balance`). The test suite uses it to stay off your real config.

## Notes

- **Passing args to Claude Code**: `balance run work -- --model opus --print "hello"` — everything after `--` is forwarded verbatim.
- **Team plans**: Claude Code itself works on Team subscriptions. Non-Claude-Code agents (opencode, aider, Cline, etc.) via HTTP proxies do *not* — Anthropic's classifier routes tool-bearing requests to workspace extra-usage on Team plans regardless of how the proxy authenticates. See [Meridian issue #516](https://github.com/rynfar/meridian/issues/516). balance sidesteps this entirely by launching Claude Code itself, which is on the sanctioned path.
- **Not a proxy**: balance v0.x was an Anthropic-API-compatible proxy that tried to pool subscriptions for third-party clients. That approach is fundamentally blocked on Team plans and got dropped in v1.0.0. Migration from an old `config.json` is automatic on first run.

## Development

```bash
bun install
bun run check     # typecheck + tests
bun test          # just the tests
bun run build     # dist/balance
```

The suite covers the parts with teeth: the merge that moves skills and plugin
directories between accounts, the per-project MCP seeding and harvesting, the
launch flags, and the Keychain blob merge. Every test runs against its own
`BALANCE_HOME` under the system temp dir, so nothing can reach your real
`~/.balance`, and the Keychain merge is tested as a pure function rather than
against the real Keychain.

CI runs typecheck, tests and a build on **self-hosted runners**, which means
fork pull requests must never reach it — a fork's code would run on our own
hardware. `.github/workflows/ci.yml` refuses any run whose repository isn't
this one, or whose pull request comes from a fork. Keep the repo settings that
back that up: *Settings > Actions > General >* require approval for outside
collaborators, and scope the runner group to this repository only.

## Releasing

Releases ship as prebuilt binaries via `markcipolla/homebrew-tap`, tag-triggered.

```bash
git tag v1.0.0 && git push --tags
```

The workflow cross-compiles for darwin arm64/amd64 and linux arm64/amd64, publishes the release, and pushes a fresh `Formula/balance.rb` to the tap.

Requires the `HOMEBREW_TAP_TOKEN` repo secret (fine-grained PAT with `Contents: Read and write` on `markcipolla/homebrew-tap`). Without it, the workflow still publishes the GitHub Release and skips the tap push with a warning.
