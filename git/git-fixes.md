# Git Common Fixes

Scenario-driven fixes for the Git situations that actually show up — undoing commits, recovering "lost" work, rewriting history safely, and untangling conflicts. Each section stands alone; jump to whichever one matches your mess.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

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

<div class="quiz-card">
  <p class="quiz-q">You want to undo the last commit but keep its changes staged, ready to re-commit. Which reset mode do you use, and why not <code>--hard</code>?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    <code>--soft</code>. It only moves HEAD, leaving the index and working tree
    untouched, so everything from the undone commit stays staged.
    <code>--hard</code> also resets the index and working tree, discarding the
    actual file changes, not just the commit record.
  </div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">You already pushed a commit, then ran <code>git commit --amend</code> to fix its message. Why does a plain <code>git push</code> fail afterward?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Amending replaces the last commit with a new one, so local and remote
    history have diverged &mdash; a plain push is rejected. Force push with
    <code>git push --force-with-lease</code> instead.
  </div>
</div>

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

Step through the recovery:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Branch deleted.</strong> The ref pointing at your work is
      gone, but the commit it pointed to is still findable &mdash; it's not
      erased just because nothing points at it anymore.
    </div>
    <div class="stepper-panel">
      <strong>2. Run <code>git reflog</code>.</strong> It lists everywhere
      HEAD has recently pointed, including the tip of the branch you just
      deleted.
    </div>
    <div class="stepper-panel">
      <strong>3. Find the commit SHA.</strong> Look for the entry from just
      before the deletion, e.g. <code>abc1234</code>.
    </div>
    <div class="stepper-panel">
      <strong>4. Recreate the branch.</strong> <code>git checkout -b recovered
      abc1234</code> (or <code>git branch recovered abc1234</code>) points a
      new ref at that SHA.
    </div>
    <div class="stepper-panel">
      <strong>5. Branch restored.</strong> Everything is back &mdash; but only
      if you do this before the reflog entry expires (90 days by default).
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">You deleted a branch by mistake five minutes ago. Is the work actually gone?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No &mdash; deleting a branch only removes the pointer, not the commit
    itself. <code>git reflog</code> still has the tip commit's SHA, so
    <code>git checkout -b recovered &lt;sha&gt;</code> gets it back, as long
    as you're within the reflog's default 90-day expiry window.
  </div>
</div>

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

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Start.</strong> <code>git rebase -i HEAD~4</code> opens an
      editor listing the last 4 commits, oldest first, each prefixed
      <code>pick</code>.
    </div>
    <div class="stepper-panel">
      <strong>2. Edit the plan.</strong> Change the verbs on any line:
      <code>squash</code> folds a commit into the one above it,
      <code>reword</code> just edits the message, <code>edit</code> pauses to
      let you amend the commit's contents, <code>drop</code> removes it
      entirely.
    </div>
    <div class="stepper-panel">
      <strong>3. Git replays top to bottom.</strong> Each line's action runs
      in order &mdash; <code>reword</code> stops briefly for a new message and
      moves on by itself.
    </div>
    <div class="stepper-panel">
      <strong>4. Pause on <code>edit</code>.</strong> Make your changes,
      <code>git add .</code>, <code>git commit --amend</code>, then
      <code>git rebase --continue</code> to resume.
    </div>
    <div class="stepper-panel">
      <strong>5. Done, or bail out.</strong> The rebase finishes once the
      last line is replayed. <code>git rebase --abort</code> at any point
      rewinds everything as if you'd never started.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">What's the difference between <code>reword</code> and <code>edit</code> in an interactive rebase plan?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    <code>reword</code> only pauses to edit that commit's message &mdash; fix
    it and the rebase carries on by itself. <code>edit</code> pauses the whole
    rebase at that commit so you can change its actual contents, and you have
    to run <code>git add .</code>, <code>git commit --amend</code>, and
    <code>git rebase --continue</code> yourself to move forward.
  </div>
</div>

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

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="exclusive" class="active">abc1234..def5678</button>
    <button data-toggle-opt="inclusive">abc1234^..def5678</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="exclusive">
    Exclusive start &mdash; applies every commit <em>after</em>
    <code>abc1234</code> up through <code>def5678</code>.
    <code>abc1234</code> itself is <strong>not</strong> replayed.
  </div>
  <div class="toggle-panel" data-toggle-panel="inclusive">
    Inclusive start &mdash; the <code>^</code> backs up one commit before
    <code>abc1234</code>, so the range now includes <code>abc1234</code>
    itself through <code>def5678</code>.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Why might <code>git cherry-pick abc1234..def5678</code> leave out a commit you expected to see applied?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    That range syntax is exclusive of the start commit &mdash;
    <code>abc1234</code> itself is not replayed, only commits after it up to
    <code>def5678</code>. Use <code>abc1234^..def5678</code> to include
    <code>abc1234</code> too.
  </div>
</div>

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

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Start.</strong> <code>git bisect start</code> begins the
      session.
    </div>
    <div class="stepper-panel">
      <strong>2. Mark the current commit bad.</strong> <code>git bisect
      bad</code>.
    </div>
    <div class="stepper-panel">
      <strong>3. Mark a known-good point.</strong> <code>git bisect good
      v1.2.0</code> &mdash; any older commit or tag you know worked.
    </div>
    <div class="stepper-panel">
      <strong>4. Git checks out the midpoint.</strong> Test it, then report
      back with <code>git bisect good</code> or <code>git bisect bad</code>.
    </div>
    <div class="stepper-panel">
      <strong>5. Repeat.</strong> Each answer halves the remaining range,
      until bisect prints the first bad commit.
    </div>
    <div class="stepper-panel">
      <strong>6. Exit.</strong> <code>git bisect reset</code> leaves bisect
      mode and returns you to where you started.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">What does <code>git bisect run ./test.sh</code> expect from your script's exit code to decide good vs bad?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Exit code <code>0</code> means the commit is good. Any non-zero exit code
    means it's bad &mdash; the same convention as any shell script's success
    status.
  </div>
</div>

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

<div class="quiz-card">
  <p class="quiz-q">You checked out a specific commit SHA, made a few commits, then checked out <code>main</code> without saving your work first. Is it lost?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Not necessarily. Even though no branch ever pointed at those commits,
    <code>git reflog</code> still recorded them &mdash; look for a
    "checkout: moving from" entry in <code>git reflog | head -20</code>, then
    <code>git checkout -b recovered &lt;sha&gt;</code> to get it back.
  </div>
</div>

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

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Install git-filter-repo.</strong> Preferred over the older,
      slower <code>filter-branch</code>.
    </div>
    <div class="stepper-panel">
      <strong>2. Rewrite history.</strong> Remove the offending file
      entirely with <code>--path ... --invert-paths</code>, or scrub a
      string wherever it appears with <code>--replace-text</code>.
    </div>
    <div class="stepper-panel">
      <strong>3. Force push everything.</strong> <code>git push --force
      --all</code> and <code>git push --force --tags</code> &mdash; every
      commit after the rewrite has a new SHA, so every branch and tag needs
      updating on the remote.
    </div>
    <div class="stepper-panel">
      <strong>4. Revoke the secret.</strong> Do this immediately, regardless
      of how clean the rewrite was. Assume it's compromised, and make sure
      it's gone from any forks too.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">You've successfully scrubbed a secret from all of Git history with <code>filter-repo</code> and force-pushed everywhere. Is the incident over?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No. Also revoke the secret immediately and assume it's compromised
    &mdash; rewriting history doesn't undo the fact that it was exposed at
    some point &mdash; and remove it from any forks too.
  </div>
</div>

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

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="mergetool" class="active">Option A: mergetool</button>
    <button data-tab="manual">Option B: manual edit</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="mergetool">
      <code>git mergetool</code> opens a configured diff tool (vimdiff, VS
      Code, etc.) that walks you through each conflict side by side. Once
      you've resolved everything in the tool, <code>git add</code> the file
      and <code>git merge --continue</code>.
    </div>
    <div class="tab-panel" data-tab-panel="manual">
      Open the file directly and resolve everything between
      <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD</code> and
      <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; feature-branch</code> by hand, then
      <code>git add</code> the file and <code>git merge --continue</code> (or
      <code>git commit</code>).
    </div>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">What's the difference between <code>git checkout --ours path</code> and manually editing between the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>/<code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    <code>--ours</code>/<code>--theirs</code> takes one whole side of the
    conflict for that file, discarding the other side entirely. Manually
    editing between the markers lets you keep pieces of both, resolving
    line by line instead of picking a whole side.
  </div>
</div>

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

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="pop" class="active">git stash pop</button>
    <button data-toggle-opt="apply">git stash apply</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="pop">
    Applies the latest stash to your working tree <strong>and removes
    it</strong> from the stash list.
  </div>
  <div class="toggle-panel" data-toggle-panel="apply">
    Applies a stash to your working tree but <strong>keeps it</strong> in the
    list &mdash; useful for applying the same stash to more than one branch.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">After <code>git stash pop</code>, is the stash still in your list to apply again on another branch?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No &mdash; <code>pop</code> applies and removes it in one step. To apply
    the same stash to more than one branch, use <code>git stash apply</code>
    instead, which keeps it in the list until you explicitly <code>git stash
    drop</code> it.
  </div>
</div>
