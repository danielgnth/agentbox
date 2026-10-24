# agentbox

Reproducible, isolated Claude Code sandboxes on Docker Sandboxes (`sbx`).
Everything that defines a sandbox lives in this repo; secrets live only in
1Password and the macOS Keychain. Clone it on any Mac, run `agentbox setup`,
and you get the same environment.

## What you get per project

| Layer | Where it comes from |
|---|---|
| microVM with its own kernel, no host files mounted | `sbx` |
| Claude Code, subscription login (token stays on the Mac) | `docker.io/docker/sbx-kit-claude` (pinned in `config.env`) |
| Node LTS, bun, uv, Rust, Temurin JDK, mise, C toolchain | `kits/toolchains` |
| gcloud, kubectl, helm, flux, terraform, tflint (`--cloud`) | `kits/cloud-tools` |
| bot git identity, co-author hook, Claude attribution off, gh, git-ai, session mirror | `kits/agent-config` |
| 1-hour GitHub token scoped to one repo, no workflow permission | `bin/gh-agent-token` via `sbx secret --command` |
| PR + your review required on `main`, attribution CI check | `agentbox protect` |

The repo is cloned **inside** the sandbox (`~/workspace/<name>`). The only
host folder mounted is this project's Claude session folder, so it shows up
in `~/.claude/projects/` on the Mac for Vorssaint.

## Layout

```
bin/agentbox            the CLI you use
bin/gh-agent-token      mints scoped GitHub App tokens (called by sbx)
bin/op-agents           op as the read-only service account (Keychain token)
config.env              IDs, names, feature switches (no secrets)
kits/<kit>/<kit>.yaml   kit descriptor (sbx kit v3)
kits/<kit>/<kit>.dockerfile
github/                 CI check template + ruleset for protected repos
kube/agent-ro.yaml      read-only ServiceAccount for kubectl tokens
```

## New machine

Prerequisites: Apple silicon Mac, `brew install docker/tap/sbx 1password-cli jq gh`,
VS Code with the `code` CLI, signed in to 1Password and `gh` as yourself.

```bash
git clone <this repo> ~/src/agentbox
export PATH="$HOME/src/agentbox/bin:$PATH"   # also add to your shell profile
sbx login
agentbox setup      # sbx hardening, SSH config, Keychain token (asks for its op:// ref)
agentbox doctor     # checks host + builds/validates every kit
```

One-time per GitHub account (already done): GitHub App with Contents and Pull
requests read/write, private key as document `github-app-key` in the `Agents`
vault, read-only service account scoped to `Agents`.

## Daily use

```bash
agentbox protect sbx-playground     # once per repo: CI check, ruleset, App access
agentbox up sbx-playground          # create sandbox, scope token, clone, open VS Code
agentbox up homelab --cloud         # with cloud tools
agentbox creds homelab              # 1h read-only gcloud/kubectl tokens
agentbox code|shell|claude <name>   # get back in (sandbox auto-starts)
agentbox rm <name>                  # refuses if anything is unpushed
```

Changing a kit only affects sandboxes created afterwards. Push your work, then
`agentbox rm <name> && agentbox up <repo>`.

## Cloud credentials (optional)

- **gcloud**: create a read-only service account, give yourself
  `roles/iam.serviceAccountTokenCreator` on it, set `GCP_AGENT_SA`.
- **kubectl**: apply `kube/agent-ro.yaml` (or commit it to your Flux repo),
  set `KUBE_CONTEXT`. The sandbox must be able to reach the API server; check
  `sbx policy log` if it can't.

## Not yet included

- **LaTeX**: planned as its own kit built from your existing devcontainer image.
- **git-ai attribution through squash-merge**: needs git-ai's CI action.

## Security notes

- The agent never sees real tokens: GitHub, Anthropic and 1Password secrets
  stay on the Mac; the sandbox only holds proxy placeholders.
- The commit hook is a convenience layer (a repo-local `core.hooksPath` such
  as husky bypasses it). The `attribution` check plus the ruleset enforce it.
- Pushes from the sandbox are unsigned, so don't enable "require signed
  commits" on agent repos.
- The mounted session folder is the one place the agent can write on the Mac.
