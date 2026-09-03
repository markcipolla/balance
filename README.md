# balance

Pick a Claude account, launch Claude Code with it. Multiple Claude Code accounts on one machine, without `claude logout` / `claude login` gymnastics.

## What it does

- Each **account** you add lives in its own isolated `CLAUDE_CONFIG_DIR` under `~/.balance/accounts/<name>/` — its own OAuth credentials, its own Claude Code sessions and settings.
- `balance` (bare, no args) fetches live 5-hour and weekly utilization per account, shows a picker, launches Claude Code as whichever account you pick.
- `balance run <name>` skips the picker.
- `balance account add` runs the Claude OAuth flow and saves the resulting credentials into a new account dir. No `claude` install needed to add accounts.

Balance is a *launcher*, not a proxy. It sets `CLAUDE_CONFIG_DIR`, writes the account's credentials into the Keychain slot Claude Code TUI reads from (on macOS), and hands off to `claude`. Every request goes to the real, sanctioned Claude Code CLI — no request rewriting, no header spoofing, no compat surface to break.

**macOS caveat**: Claude Code TUI on macOS reads OAuth from a single machine-wide Keychain slot (service: `Claude Code-credentials`). balance overwrites that slot each launch, which means running `claude` directly outside balance will use whichever account balance most recently launched. The first launch may trigger a Keychain permission dialog — pick "Always Allow" to skip it thereafter.

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

 1. work  <mark@labflow.ai>
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
balance account list  [--usage]                     list accounts (add --usage for live 5h/7d)
balance account switch <name>                       set default account
balance account remove <name>                       delete an account (removes credentials)

balance --help          full usage
balance --version       print version
```

Aliases from the v0.x proxy era (`login`, `list`, `remove`, `switch`) still work.

## Config

`~/.balance/config.json`:

```json
{
  "active": "work",
  "claude_binary": "claude",
  "log_level": "info",
  "accounts": [
    { "name": "work", "email": "mark@labflow.ai", "last_used_at": 1788418333140, "added_at": 1788418275400 }
  ]
}
```

Each account's OAuth credentials live at `~/.balance/accounts/<name>/.credentials.json` (mode 0600), Claude Code's native format.

Env overrides:
- `BALANCE_CLAUDE_BINARY` — path to the `claude` executable (default: `claude` on PATH).
- `BALANCE_LOG_LEVEL` — `debug | info | warn | error`.

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
