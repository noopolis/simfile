# Contributing

## Commits

Every authored commit must be one Conventional Commits line of at most 150
characters: `type(scope)!: summary`, with scope and `!` optional. Allowed types:
feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
No body, trailers, Co-Authored-By, "generated with/by", or robot emoji.
Git-generated Merge, Revert, fixup!, squash! and amend! messages are accepted;
merge commits skip message validation. All commits, including merges, must have
an author email of `juancfortunatti@gmail.com`. Committers may be GitHub
`noreply@github.com`; the allowlist checks the author, not the committer.

To opt into the local hook, from a fresh clone or any linked worktree:

```sh
cd "$(git rev-parse --show-toplevel)"
node .github/scripts/ci/commit-message.mts --install
```

Requires Node 22.19 or later, with no package install. The installer preserves
existing hooks and custom `core.hooksPath`; read its result. If it leaves an
existing setup unchanged, integrate `.github/hooks/commit-msg` into that setup
instead of replacing it. The shared dispatcher runs each worktree's own tracked
hook and fails if it is missing. Installation is opt-in and never runs on install.
The hook checks the effective Git author, including `GIT_AUTHOR_EMAIL` overrides.
`--no-verify` skips the local hook; CI still checks every PR commit in
`origin/$GITHUB_BASE_REF..HEAD` with full history, before dependency installation.
