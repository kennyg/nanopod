---
name: update-nanopod
description: Bring upstream NanoClaw updates into NanoPod, automatically preserving the package name and Apple Container runtime customization.
---

# About

NanoPod is a fork of NanoClaw. This skill pulls upstream changes into your install without losing NanoPod customizations. It knows what's custom and handles name conflicts automatically.

Run `/update-nanopod` in Claude Code.

---

## NanoPod Customizations Registry

These are the files NanoPod adds or intentionally modifies vs upstream. Conflicts in these files need manual review; everything else follows upstream.

| File | What it does | Action on conflict |
|------|-------------|-------------------|
| `src/container-runtime.ts` | Apple Container runtime (binary, mount syntax, health check, orphan cleanup) | Keep ours |
| `src/container-runner.ts` | Uses `CONTAINER_NAME_PREFIX` constant | Keep ours |
| `src/container-runtime.test.ts` | Tests updated for Apple Container | Keep ours |
| `container/build.sh` | Apple Container build script | Keep ours |
| `.gitignore` | Ignores `.nanopod/` runtime state dir | Keep ours |
| `.env.example` | Documents `CONTAINER_RUNTIME_BIN` | Keep ours |
| `launchd/com.nanopod.plist` | Service definition (label, log paths) | Keep ours |
| `.claude/skills/update-nanopod/` | This skill | Keep ours |

**Name substitution rules** (applied after merge):
- `"name": "nanoclaw"` → `"name": "nanopod"` in `package.json` only (avoids security keyword scanning)
- `launchd/com.nanoclaw.plist` → rename to `launchd/com.nanopod.plist` if upstream resets it

Everything else (`nanoclaw` in URLs, skill descriptions, changelog, source code) stays as-is.

---

# How it works

**Preflight**: checks for a clean working tree. Adds `upstream` remote if missing.

**Backup**: creates a timestamped backup branch and tag before touching anything.

**Preview**: shows upstream changes bucketed by impact — source, skills, config.

**Update**: merges (default) or rebases. After merge, auto-applies name substitutions.

**Validation**: runs `npm run build` and `npm test`.

**Breaking changes**: checks CHANGELOG.md for `[BREAKING]` entries and offers migration skills.

---

# Step 0: Preflight

```bash
git status --porcelain
```

If non-empty: tell the user to commit or stash first, then stop.

Check remotes:
```bash
git remote -v
```

If `upstream` is missing, add it:
```bash
git remote add upstream git@github.com:qwibitai/nanoclaw.git
```

Fetch:
```bash
git fetch upstream --prune
```

Determine upstream branch (main or master):
```bash
git branch -r | grep upstream/
```

Store as `UPSTREAM_BRANCH`.

# Step 1: Create safety net

```bash
HASH=$(git rev-parse --short HEAD)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
git branch backup/pre-update-$HASH-$TIMESTAMP
git tag pre-update-$HASH-$TIMESTAMP
```

Save the tag name for the summary.

# Step 2: Preview

Compute base:
```bash
BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)
```

Show upstream commits:
```bash
git log --oneline $BASE..upstream/$UPSTREAM_BRANCH
```

Show NanoPod local commits (drift):
```bash
git log --oneline $BASE..HEAD
```

Show file-level impact:
```bash
git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH
```

Bucket upstream changed files:
- **Skills** (`.claude/skills/`): low conflict risk unless you edited an upstream skill
- **Source** (`src/`): check against NanoPod Customizations Registry above
- **Build/config** (`package.json`, `tsconfig*.json`, `container/`): apply name substitutions after merge
- **Other**: docs, tests, misc

If upstream commit count is large (>100), mention that a fresh rebase of local commits onto upstream may be cleaner than merging. Offer it as option D.

Present options via AskUserQuestion:
- A) **Full update** — merge all upstream changes (default)
- B) **Selective update** — cherry-pick specific commits
- C) **Abort** — preview only
- D) **Rebase mode** — replays NanoPod commits on top of upstream (cleanest, recommended when local commits are few and focused)

If Abort: stop here.

# Step 3: Conflict preview

If Full update or Rebase:
```bash
git merge --no-commit --no-ff upstream/$UPSTREAM_BRANCH; git diff --name-only --diff-filter=U; git merge --abort
```

Show conflicted files. Cross-reference with the NanoPod Customizations Registry — flag registry files as "needs manual review", others as "auto-resolvable via name substitution".

Ask user if they want to proceed.

# Step 4A: Full update (MERGE)

```bash
git merge upstream/$UPSTREAM_BRANCH --no-edit
```

If conflicts:
- For each conflicted file, open it and resolve conflict markers.
- For files in the NanoPod Customizations Registry: preserve NanoPod's version, incorporate upstream improvements where safe.
- For all other files: take upstream's version.
- `git add <file>` after each resolution.
- When all resolved: `git commit --no-edit` if needed.

After merge completes, apply name substitution:

```bash
# package.json: keep nanopod as package name
if grep -q '"name": "nanoclaw"' package.json; then
  sed -i '' 's/"name": "nanoclaw"/"name": "nanopod"/' package.json
  git add package.json
fi
```

Also ensure `.gitignore` still contains `.nanopod/`:
```bash
grep -q '\.nanopod/' .gitignore || echo '.nanopod/' >> .gitignore && git add .gitignore
```

If any substitutions were made, commit:
```bash
git diff --cached --quiet || git commit -m "chore: restore NanoPod package name after upstream merge"
```

# Step 4B: Selective update (CHERRY-PICK)

Show commits again:
```bash
git log --oneline $BASE..upstream/$UPSTREAM_BRANCH
```

Ask user which hashes to apply.

```bash
git cherry-pick <hash1> <hash2> ...
```

Resolve any conflicts as in Step 4A. Apply name substitutions after.

# Step 4C/D: Rebase

```bash
git rebase upstream/$UPSTREAM_BRANCH
```

For each conflict round:
- Resolve only conflict markers.
- `git add <file>`
- `git rebase --continue`

If more than 3 rounds of conflicts: `git rebase --abort` and recommend merge instead.

After rebase completes, apply the name substitution pass from Step 4A.

# Step 5: Validation

```bash
npm run build
npm test
```

If build fails: show the error. Only fix issues clearly caused by the merge. Do not refactor unrelated code.

# Step 6: Breaking changes check

Diff the changelog against the backup tag:
```bash
git diff <backup-tag>..HEAD -- CHANGELOG.md
```

Parse for `[BREAKING]` lines. If found, show them and offer to run referenced migration skills.

# Step 7: Check for skill updates

```bash
git branch -r --list 'upstream/skill/*'
```

If any exist, offer to run `/update-skills`.

# Step 8: Summary

Show:
- Backup tag (for rollback)
- New HEAD: `git rev-parse --short HEAD`
- Upstream HEAD: `git rev-parse --short upstream/$UPSTREAM_BRANCH`
- Conflicts resolved (list files)
- Name substitutions applied
- Remaining local diff vs upstream: `git diff --name-only upstream/$UPSTREAM_BRANCH..HEAD`

Rollback:
```bash
git reset --hard <backup-tag>
```

Restart service:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanopod.plist && launchctl load ~/Library/LaunchAgents/com.nanopod.plist
```
