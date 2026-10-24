## Working in this sandbox (agentbox)

- The repository is cloned at `~/workspace/<sandbox-name>`. Work there. Nothing
  outside the sandbox is reachable except through git and package registries.
- Git identity is a GitHub App bot. Do not change `user.name`/`user.email`.
  A hook adds the human co-author trailer to every commit; do not add
  `Co-authored-by` or Claude attribution lines yourself.
- Never push to `main`. Work on a branch named `agent/<short-topic>`, push
  early and often (unpushed work is lost if the sandbox is removed), and open
  a pull request with `gh pr create`. The user reviews and merges.
- Files under `.github/workflows/` cannot be pushed with your token. If a
  workflow change is needed, describe it in the PR instead.
- Your GitHub token only covers this repository and expires hourly; it is
  refreshed automatically. Do not try to print, store or exchange it.
