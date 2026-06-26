# Git Common Fixes

## 1. reset --soft / --mixed / --hard

```mermaid
flowchart LR
    subgraph soft["--soft"]
        S1[HEAD moves] --> S2[Index unchanged]
        S2 --> S3[Working tree unchanged]
    end
    subgraph mixed["--mixed (default)"]
        M1[HEAD moves] --> M2[Index reset]
        M2 --> M3[Working tree unchanged]
    end
    subgraph hard["--hard"]
        H1[HEAD moves] --> H2[Index reset]
        H2 --> H3[Working tree reset]
    end
```

| Mode | HEAD | Index (staged) | Working tree |
|---|---|---|---|
| `--soft` | ✅ moves | unchanged | unchanged |
| `--mixed` | ✅ moves | ✅ reset | unchanged |
| `--hard` | ✅ moves | ✅ reset | ✅ reset ⚠️ |

```bash
git reset --soft HEAD~1    # undo commit, keep staged
git reset --mixed HEAD~1   # undo commit + unstage, keep files
git reset --hard HEAD~1    # undo commit + discard all changes
```

---

## 2. Amend Last Commit

```bash
# Fix commit message only
git commit --amend -m "correct message"

# Add forgotten file
git add forgotten.go
git commit --amend --no-edit   # keeps existing message

# Already pushed? Must force push
git push --force-with-lease
```

---

## 3. Recover Deleted Branch with Reflog

```mermaid
flowchart TD
    A[Branch deleted] --> B[git reflog]
    B --> C[Find commit SHA<br/>e.g. abc1234]
    C --> D[git checkout -b recovered abc1234]
    D --> E[Branch restored]
```

```bash
git reflog                          # find the tip commit of deleted branch
git checkout -b recovered abc1234   # recreate branch at that SHA
# or
git branch recovered abc1234
```

Reflog expires after 90 days by default.

---

## 4. Interactive Rebase

```bash
git rebase -i HEAD~4   # rewrite last 4 commits
```

In the editor:
```
pick a1b2c3 first commit
squash d4e5f6 fixup for first    # merge into previous
reword 7g8h9i bad message        # edit message
edit  j0k1l2 needs splitting     # pause to amend
drop  m3n4o5 mistake             # delete entirely
```

```bash
# During edit pause:
git add .
git commit --amend
git rebase --continue

# Abort at any time:
git rebase --abort
```

---

## 5. Cherry-pick

```bash
git cherry-pick abc1234             # apply single commit
git cherry-pick abc1234 def5678     # apply multiple commits
git cherry-pick abc1234..def5678    # apply a range (exclusive start)
git cherry-pick abc1234^..def5678   # apply a range (inclusive start)

# Conflict during cherry-pick:
git add .
git cherry-pick --continue
# or bail:
git cherry-pick --abort
```

---

## 6. git bisect

```bash
git bisect start
git bisect bad                  # current commit is broken
git bisect good v1.2.0          # this tag was working

# Git checks out midpoint — test it, then:
git bisect good   # or: git bisect bad

# Repeat until bisect prints the first bad commit
git bisect reset  # exit bisect mode

# Automate with a test script (exit 0 = good, non-zero = bad):
git bisect run ./test.sh
```

---

## 7. Detached HEAD

Detached HEAD = HEAD points to a commit SHA, not a branch ref.

```bash
git checkout abc1234   # → detached HEAD

# Save work before checking out something else:
git checkout -b save-detached-work   # create branch from current position
# or tag it:
git tag temp-save
```

If you already left without saving, find it in reflog:
```bash
git reflog | head -20   # look for "checkout: moving from"
git checkout -b recovered <sha>
```

---

## 8. Remove Committed Secrets

```bash
# Install git-filter-repo (preferred over filter-branch)
pip install git-filter-repo

# Remove a specific file from all history
git filter-repo --path secrets.env --invert-paths

# Replace a secret string everywhere in history
git filter-repo --replace-text <(echo "AKIAIOSFODNN7EXAMPLE==>REMOVED")

# After rewriting history, force push ALL branches
git push --force --all
git push --force --tags
```

**Also:** revoke the secret immediately. Assume it's compromised. Remove from all forks.

---

## 9. Merge Conflict Resolution

```bash
git merge feature-branch
# CONFLICT in src/handler.go

# Option A: use a mergetool
git mergetool   # opens vimdiff / VS Code / etc.

# Option B: manual edit
# In the file, resolve between <<<<<<< HEAD and >>>>>>> feature-branch
git add src/handler.go
git merge --continue   # or: git commit

# Abort entirely:
git merge --abort

# Useful during conflict resolution:
git diff                  # see all conflicts
git checkout --ours path   # accept our version
git checkout --theirs path # accept their version
```

---

## 10. Stash

```bash
git stash                      # stash tracked changes
git stash -u                   # include untracked files
git stash -m "wip: auth fix"   # named stash

git stash list                 # show all stashes
git stash show -p stash@{1}    # diff of a stash

git stash pop                  # apply latest + remove from list
git stash apply stash@{2}      # apply specific, keep in list
git stash drop stash@{1}       # delete specific stash
git stash clear                # delete all stashes ⚠️

# Stash only staged changes:
git stash --staged
```
