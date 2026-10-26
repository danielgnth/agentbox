# agentbox

Lets Claude Code work on your repos under its built-in sandbox (Seatbelt on
macOS) while git and `gh` act as a GitHub App bot with one-hour tokens, and
the bot's commits show up on GitHub as verified.

- **`agentbox setup`** brings `~/.claude/settings.json` to a managed state:
  sandbox on, credential paths and env vars denied, network allowlist, bot git
  identity, your `Co-Authored-By` trailer, the token hook. It also adds the agent
  rules to `~/.claude/CLAUDE.md`. Keys it doesn't manage stay untouched, and it
  is safe to run again at any time.
- **The hook** runs as a Claude Code `PreToolUse` hook, outside the sandbox.
  Before a git network command (`push`, `pull`, `fetch`, `clone`, `ls-remote`,
  `submodule`), `agentbox github push` or any `gh` command, it mints a token
  scoped to that one repo and caches it for 45 minutes. A dash prefilter
  (`src/hook.sh`, about 1 ms) runs first and starts the binary
  (`agentbox github hook`, about 40 ms) only for commands that could need a
  token.
- **`agentbox github credential`** is git's credential helper inside the
  sandbox. It only reads the cached token, and only for your own repos.
- **`agentbox github push`** is how the agent pushes (see
  [Verified commits](#verified-commits)). `git push` is denied in Claude.

The GitHub App private key stays in 1Password. A read-only service account,
whose token sits in the macOS Keychain, streams it into memory to sign a JWT.

## Install

Prerequisites: macOS (the hook uses `/bin/dash`), `brew install oven-sh/bun/bun 1password-cli gh jq`,
`gh auth login` as yourself, and a 1Password vault that a read-only service
account can see. setup can create the GitHub App for you.

```bash
bun install
bin/agentbox install          # builds and copies the binary and the hook to ~/.local/share/agentbox,
                              # links ~/.local/bin/agentbox (see below if that isn't on your PATH)
agentbox setup                # asks for the config on first run, then applies the settings
agentbox setup --dry-run      # later: shows the diff for settings.json and CLAUDE.md
agentbox doctor
```

`agentbox` lands in `~/.local/bin`. If that isn't on your `PATH` yet, add it in
`~/.zprofile` (not `~/.zshenv`: macOS's `path_helper` reorders `PATH` after it):

```zsh
typeset -U path
path=("$HOME/.local/bin" $path)
```

On the first run (or with `agentbox setup --reconfigure`), setup asks for every
config value and writes `~/.config/agentbox/config.toml`. It suggests what it can
derive: your `gh` login and organizations as the owner, your 1Password vaults,
your GitHub Apps that are already installed on the owner and can push, and your
co-author address. For the App you can keep the current one, pick an installed
one, enter a client ID, or **create a new App**:

1. A localhost page sends GitHub an App manifest with exactly the permissions
   agentbox needs (no workflows, no administration, no webhook).
2. You confirm on github.com. GitHub hands back the App and its private key.
3. The key goes straight into 1Password with your own `op` login (it never
   touches disk), then setup opens the install page and waits for the
   installation.

You can also write the config by hand from `config.example.toml`.

Restart Claude sessions and VS Code windows afterwards. The first token may
show a Keychain prompt for `security`: choose "Always Allow".

Rerun `bin/agentbox install` after changing the code, and `agentbox setup`
after changing `claude/` or the config. `agentbox doctor` tells you when
either is out of date.

## Commands

| Command                                      | Purpose                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `agentbox install [--force]`                 | Build and install a copy (run from the repo)                            |
| `agentbox setup [--dry-run] [--no-keychain]` | Merge the managed settings and agent rules; backs up before writing     |
| `agentbox doctor`                            | Check config, 1Password, App key, install, settings drift, HTTPS remote |
| `agentbox github token <repo>…`              | Print a one-hour token for the given repos                              |
| `agentbox github hook`                       | Hook logic behind the prefilter (never blocks, always exits 0)          |
| `agentbox github credential get`             | git credential helper                                                   |
| `agentbox github push [branch]`              | Push so GitHub recreates and signs the bot's commits                    |
| `agentbox op <args>`                         | `op` as the read-only service account                                   |

## Layout

```
claude/settings.managed.json  managed settings template ({{…}} filled by setup)
claude/agent-rules.md         block setup maintains in ~/.claude/CLAUDE.md
config.example.toml           template for ~/.config/agentbox/config.toml
src/hook.sh                   PreToolUse prefilter, installed as ~/.local/share/agentbox/hook
src/commands/                 one file per command
src/lib/                      GitHub App, token cache, repo resolution, settings merge
github/ruleset-main.json      optional branch protection for your repos (see below)
test/                         bun test, against a temporary HOME
```

## How setup merges

- Scalars from the template win.
- Arrays are unions. Objects in arrays match by `path`, `name`, `matcher` or
  `command`, so your own entries survive.
- The applied template is recorded in `~/.local/share/agentbox/settings-applied.json`.
  An entry that is later removed from the template is also removed from your
  settings. Entries you added yourself are never removed.
- Leftovers of the old `~/.claude/hooks/agent-gh-hook` prototype are removed.
  Setup offers to delete the prototype files.
- Nothing is written when nothing changed. Before each write, the old file is
  copied to `settings.json.bak-<timestamp>`.

## Security notes

- **Hook code must not be writable from the sandbox.** Hooks run unsandboxed.
  `agentbox install` copies a compiled binary and the hook prefilter to
  `~/.local/share/agentbox`, which is outside every writable path. It is never a link into this checkout.
  The managed settings also deny `Edit` on that folder, the shim, the config and
  the token cache.
- **The hook never runs git outside the sandbox.** It reads `.git/config`
  itself to find the repo, and no environment variable can redirect what it
  executes.
- **Each token covers one repo, but the effective scope is wider.** Any
  sandboxed session can read every cached token (the credential helper inside
  the sandbox needs them), and naming a repo's URL makes the hook mint for it.
  The real boundary is the set of repos the App is installed on. Keep that list
  to what agents should touch.
- **`gh` runs inside the sandbox with `enableWeakerNetworkIsolation`.** That
  lets Go reach trustd for TLS on macOS, and opens a small, accepted side
  channel.
- **Two sessions in different repos share one `hosts.yml`.** Two `gh` calls at
  the same moment can use the other repo's token. The worst case is a 404, not
  a leak.
- **Some `gh` commands are denied:** `gh alias`, `extension`, `config` and
  `auth`. The hook also deletes `config.yml` before every `gh` call.
- **`.env` files are readable in the sandbox.** Denying them broke every Bun
  command and most dev tooling in repos that have one. Keep secrets out of
  `.env`: put `op://…` references there and resolve them yourself with
  `op run --env-file=.env -- <command>` (the sandbox can't reach 1Password).
- **Remotes must use HTTPS.** Credential helpers don't apply to SSH remotes.
- **Avoid tokens in `~/.zshenv`.** zsh re-reads it inside the sandbox. If you
  must have one there, guard it with `[[ -n $CLAUDECODE ]] ||`.

## Verified commits

GitHub only verifies a signature against a key on a user account, and a
GitHub App's bot has no account to register one on. A bot's commits are
verified only when the App creates them through the API. So the agent commits
locally, unsigned (`commit.gpgsign=false`), and `agentbox github push`:

1. pushes the new commits to a scratch ref, `refs/agentbox/<branch>`, which
   uploads their trees and blobs (no branch, so no workflow runs);
2. recreates each one with `POST /git/commits`: same tree, message and
   (recreated) parents. GitHub signs these as the bot;
3. creates or fast-forwards the branch to the last one, then deletes the
   scratch ref;
4. fetches and moves the local branch onto the new commits. The trees are the
   same, so the working tree and index don't change.

It runs inside the sandbox with the cached token, like the credential helper.
The new commits get new hashes, and GitHub sets their date to the time of the
push. The `Co-Authored-By` trailer is part of the message, so it survives. The
command refuses the default branch, never force-pushes, and refuses commits
that aren't authored by the bot. Recreating a commit would make the bot its
author, so it never touches yours.

**No upstream tracking.** The sandbox doesn't let anything write `.git/config`
(or `.git/hooks`): a sandboxed process that could would plant `core.fsmonitor`
or a hook that later runs outside the sandbox. That makes `git push -u` and
`git branch --set-upstream-to` fail. The agent names the remote branch instead
(`origin/<branch>`, `gh pr create --head <branch>`), as the agent rules tell it to.

## Branch protection (optional)

`github/ruleset-main.json` blocks deletion and force pushes on the default
branch and requires a reviewed PR. Repo admins can bypass it, the bot can't.
To apply it to a repo:

```bash
gh api -X POST repos/<owner>/<repo>/rulesets --input github/ruleset-main.json
```

## Development

```bash
bun run check    # biome (all rules), typecheck, tests (fake HOME, fake mint, no network)
bun run fix      # biome formatting and safe fixes
```

Biome runs with `preset: "all"`. The two rules turned off, and the naming
conventions for external formats, are explained in `biome.jsonc`.
