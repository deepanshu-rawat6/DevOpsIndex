# Git

Git internals, team workflows, and recovering from mistakes.

## Files

| File | Topics |
|------|--------|
| [git-internals.md](./git-internals.md) | Object model (blob/tree/commit/tag), refs, pack files, merge vs rebase internals, reflog |
| [git-workflows.md](./git-workflows.md) | Trunk-based vs GitFlow vs GitHub Flow, monorepo, branch protection, conventional commits |
| [git-fixes.md](./git-fixes.md) | reset modes, amend, reflog recovery, interactive rebase, bisect, detached HEAD, secrets removal |

## Read Order

```
git-internals  → understand the object model first
git-workflows  → branching strategies for teams
git-fixes      → undo/recover from mistakes
```
