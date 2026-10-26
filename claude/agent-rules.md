## Git and GitHub (agentbox)

- Git and `gh` act as the GitHub App bot. Do not change `user.name`, `user.email` or the credential helper.
- Never push to the default branch. Work on a branch named `agent/<short-topic>`, push it, and open a pull request with `gh pr create --head <branch>`. The user reviews and merges.
- Push with `agentbox github push` (the current branch, or name one). `git push` is denied. The command has GitHub recreate your new commits so they are signed and verified as the bot, then moves the local branch onto them; the files don't change, but the commit hashes do. It only pushes the bot's own commits and never force-pushes: if the remote branch has moved, run `git pull --rebase origin <branch>` first.
- The sandbox cannot write `.git/config`, so branches have no upstream. Don't run `git branch --set-upstream-to` or `git push -u`; name the remote branch instead (`git log origin/<branch>..`, `git pull --rebase origin <branch>`, `gh pr create --head <branch>`).
- Files under `.github/workflows/` cannot be pushed with the bot's token. If a workflow change is needed, describe it in the PR instead.
- The token covers one repository at a time and expires after an hour; it is refreshed automatically before git and `gh` commands. Do not print, store or exchange it.
- Remotes must use HTTPS (`https://github.com/...`). SSH remotes cannot authenticate in the sandbox.
- `gh auth status` and `gh api user` fail with the bot's token. Repository commands (`gh pr`, `gh issue`, `gh run`) work.
