# Git Internals

## 1. Object Model

Git stores everything as **content-addressed objects** in `.git/objects/`. Four types:

| Object | Contains | Created by |
|---|---|---|
| **blob** | raw file content (no name/path) | `git add` |
| **tree** | directory listing: mode + name + SHA → blob/tree | `git commit` |
| **commit** | tree SHA + parent SHA(s) + author + message | `git commit` |
| **tag** | annotated tag: object SHA + tagger + message | `git tag -a` |

**Content-addressed**: SHA = `sha1(type + space + size + \0 + content)`. Same content = same SHA always.

```
SHA-1: 40 hex chars (160-bit). Legacy, still default.
SHA-256: 64 hex chars (256-bit). Enable with: git init --object-format=sha256
```

Storage: `.git/objects/ab/cdef1234...` — first 2 chars = directory, rest = filename.

```bash
# Inspect any object
git cat-file -t <sha>      # type
git cat-file -p <sha>      # pretty-print content

# Example:
git cat-file -p HEAD       # shows commit object
git cat-file -p HEAD^{tree} # shows root tree
git ls-tree HEAD            # list tree entries
```

---

## 2. Working Tree → Index → Local Repo → Remote

```mermaid
flowchart LR
    WT[Working Tree<br/>your files on disk]
    IDX[Index / Staging<br/>.git/index]
    LOCAL[Local Repo<br/>.git/objects]
    REMOTE[Remote<br/>GitHub/GitLab]

    WT -->|git add| IDX
    IDX -->|git commit| LOCAL
    LOCAL -->|git push| REMOTE
    REMOTE -->|git fetch| LOCAL
    LOCAL -->|git checkout| WT
    LOCAL -->|git merge/rebase| WT
    IDX -->|git restore --staged| WT
```

| Command | Transition |
|---|---|
| `git add` | working tree → index |
| `git commit` | index → local repo |
| `git push` | local repo → remote |
| `git fetch` | remote → local repo (FETCH_HEAD) |
| `git pull` | fetch + merge/rebase |
| `git checkout / restore` | local repo / index → working tree |

---

## 3. Refs

Refs are files in `.git/refs/` containing a SHA (or another ref for symbolic refs).

| Ref | Location | Meaning |
|---|---|---|
| `HEAD` | `.git/HEAD` | current branch or detached commit |
| `main` | `.git/refs/heads/main` | tip of main branch |
| `origin/main` | `.git/refs/remotes/origin/main` | last known remote tip |
| `ORIG_HEAD` | `.git/ORIG_HEAD` | pre-merge/rebase HEAD (for undo) |
| `FETCH_HEAD` | `.git/FETCH_HEAD` | last fetched SHA |
| `MERGE_HEAD` | `.git/MERGE_HEAD` | SHA being merged (during merge) |

**HEAD** is a symbolic ref: `ref: refs/heads/main`. In detached state it contains a raw SHA.

**Lightweight tag**: just a ref pointing to a commit SHA. No object created.  
**Annotated tag**: creates a tag object (has tagger, message, signature). Points to commit.

```bash
git tag v1.0              # lightweight
git tag -a v1.0 -m "msg"  # annotated (creates tag object)
git cat-file -t v1.0      # "commit" vs "tag"
```

---

## 4. Pack Files

**Loose objects**: one file per object. Fine for small repos.  
**Pack files**: Git bundles objects together for efficiency.

```
git gc                          → pack loose objects
git gc --aggressive             → more compression
git count-objects -v            → see loose vs packed counts
```

Pack format:
- `.git/objects/pack/pack-<sha>.pack` — the objects (delta-compressed)
- `.git/objects/pack/pack-<sha>.idx`  — index for fast lookup by SHA

Delta compression: similar objects stored as base + delta. A file's history stores diffs, not full copies. Git stores the **newest version** as the base and older versions as deltas (reverse delta).

```bash
git verify-pack -v .git/objects/pack/pack-*.idx | sort -k3 -n | tail -10
# Shows largest objects in pack by size
```

---

## 5. Index (Staging Area) Internals

The index is a **binary file** at `.git/index`. It is a snapshot of the working tree ready for the next commit.

Each entry contains:
- file mode, UID/GID, file size, mtime
- SHA of the blob
- file path (relative to repo root)
- flags (merge stage: 0=normal, 1/2/3=conflict stages)

```bash
git ls-files --stage          # dump index entries
git ls-files -u               # show conflict (unmerged) entries
```

During a merge conflict, the index holds **3 stages** for conflicted files:
- Stage 1: common ancestor (base)
- Stage 2: ours (HEAD)
- Stage 3: theirs (MERGE_HEAD)

---

## 6. Merge vs Rebase Internals

### 3-Way Merge

Git finds the **merge base** (common ancestor commit), then applies changes from both branches:

```
merge base = git merge-base branch1 branch2
```

If the same lines changed in both → conflict. Git writes conflict markers to the working tree.

**Fast-forward merge**: when no divergence exists (one branch is an ancestor of the other). HEAD pointer just moves forward. No merge commit created.

```bash
git merge --ff-only feature   # fail if not fast-forwardable
git merge --no-ff feature     # always create merge commit
```

### Rebase Internals

Rebase **replays commits** one by one onto a new base:

```mermaid
graph LR
    subgraph Before["Before: git rebase main"]
        A1["A"] --> B1["B (main)"]
        A1 --> C1["C"] --> D1["D (feature)"]
    end
    subgraph After["After: git rebase main"]
        A2["A"] --> B2["B (main)"] --> C2["C' (new SHA)"] --> D2["D' (new SHA, feature)"]
    end
```

**Step by step:**
1. `git merge-base feature main` → finds A (common ancestor)
2. Extract patches: C-diff, D-diff
3. `git reset --hard main` → move feature to B
4. Apply C-diff → creates C' (new SHA, different parent = different hash)
5. Apply D-diff → creates D' (new SHA)

**Conflict during rebase:**
```bash
git rebase main
# CONFLICT (content): Merge conflict in src/handler.go
# Fix conflict in editor, then:
git add src/handler.go
git rebase --continue   # applies next commit
# OR:
git rebase --skip       # skip this commit entirely
# OR:
git rebase --abort      # abandon, restore original branch
```

**Interactive rebase — rewrite history before pushing:**
```bash
git rebase -i HEAD~4   # last 4 commits
# Editor opens showing:
# pick a1b2c3 add feature X
# pick d4e5f6 fix typo
# pick g7h8i9 wip
# pick j0k1l2 final cleanup
#
# Commands: pick, squash (s), fixup (f), reword (r), edit (e), drop (d)
# Squash d4e5f6 into a1b2c3:
# pick a1b2c3 add feature X
# squash d4e5f6 fix typo     ← merged into previous, keeps both messages
# fixup g7h8i9 wip           ← merged into previous, discards this message
# reword j0k1l2 final cleanup ← prompts to edit message
```

**`--onto` — transplant commits to a different base:**
```bash
# Move commits that are on feature but NOT on bugfix, onto main
git rebase --onto main bugfix feature
# Before: main ← bugfix ← feature
# After:  main ← feature' (bugfix commits dropped)
# Use case: feature was accidentally branched from bugfix, not main
```

**Key rule:** `git rebase` rewrites SHAs. Never rebase commits that have been pushed to a shared remote branch — it will require force push and break everyone else's history.

---

## 7. Reflog

The reflog records every movement of a ref (HEAD, branches). It is **local only** and expires after 90 days by default.

```bash
git reflog                    # HEAD reflog
git reflog show main          # main branch reflog
git reflog --all              # all refs
```

### Recover Deleted Branch

```bash
# 1. Find the SHA of the deleted branch tip
git reflog | grep "branch-name"
# or: git log --walk-reflogs --oneline

# 2. Recreate the branch
git checkout -b branch-name <sha>
# or: git branch branch-name <sha>
```

### Recover Deleted Commits (reset --hard undo)

```bash
git reflog                    # find SHA before reset
git reset --hard <sha>        # restore HEAD to that point
# or: git checkout -b recovery <sha>
```

---

## Object DAG & Commit Graph

```mermaid
graph TD
    subgraph Objects
        C2[commit: abc123<br/>msg: add feature]
        C1[commit: def456<br/>msg: initial]
        T2[tree: 789...<br/>root dir]
        T1[tree: 012...<br/>root dir]
        B1[blob: hello.go<br/>v2 content]
        B0[blob: hello.go<br/>v1 content]
        B2[blob: main.go<br/>content]
    end

    C2 -->|parent| C1
    C2 -->|tree| T2
    C1 -->|tree| T1
    T2 -->|hello.go| B1
    T2 -->|main.go| B2
    T1 -->|hello.go| B0
    T1 -->|main.go| B2
```

```mermaid
gitGraph
   commit id: "A"
   commit id: "B"
   branch feature
   commit id: "C"
   commit id: "D"
   checkout main
   commit id: "E"
   merge feature id: "M" type: HIGHLIGHT
```
