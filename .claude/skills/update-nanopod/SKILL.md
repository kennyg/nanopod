---
name: update-nanopod
description: Bring upstream NanoClaw updates into NanoPod, automatically preserving the NanoPod name and custom files (web chat, sender labels).
---

# About

NanoPod is a fork of NanoClaw. This skill pulls upstream changes into your install without losing NanoPod customizations. It knows what's custom and handles name conflicts automatically.

Run `/update-nanopod` in Claude Code.

---

## NanoPod Customizations Registry

These are the files NanoPod adds or intentionally modifies vs upstream. Conflicts in these files need manual review; everything else follows upstream.

| File | What it does | Action on conflict |
|------|-------------|-------------------|
| `src/channels/web.ts` | Web chat channel | Keep ours |
| `src/channels/web-ui.ts` | Web chat UI server | Keep ours |
| `src/channels/web.test.ts` | Web chat tests | Keep ours |
| `.claude/skills/add-web/` | /add-web skill | Keep ours |
| `README.md` | NanoPod branding | Merge, keep "NanoPod" name |
| `CLAUDE.md` | Project heading | Merge, keep "NanoPod" heading |
| `launchd/com.nanopod.plist` | Service definition | Keep ours (renamed from nanoclaw) |

**Name substitution rules** (applied after merge to resolve branding conflicts):
- `"name": "nanoclaw"` → `"name": "nanopod"` (package.json only)
- `com.nanoclaw.plist` → `com.nanopod.plist` (launchd references)
- `# NanoClaw` → `# NanoPod` (CLAUDE.md heading only)

Everything else (`nanoclaw` in URLs, upstream skill descriptions, changelog) stays as-is.

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
- **Build/config** (`package.json`, `tsconfig*.json`, `container/`, `launchd/`): apply name substitutions after merge
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

Show conflicted files. Cross-reference with the NanoPod Customizations Registry — flag files that are in the registry as "needs manual review", others as "auto-resolvable via name substitution".

Ask user if they want to proceed.

# Step 4A: Full update (MERGE)

```bash
git merge upstream/$UPSTREAM_BRANCH --no-edit
```

If conflicts:
- For each conflicted file, open it and resolve conflict markers.
- For files in the NanoPod Customizations Registry: preserve NanoPod's version of custom logic, incorporate upstream improvements.
- For all other files: take upstream's version, then apply name substitutions if needed.
- `git add <file>` after each resolution.
- When all resolved: `git commit --no-edit` if needed.

After merge completes, apply name substitutions:

```bash
# package.json: keep nanopod as package name
if grep -q '"name": "nanoclaw"' package.json; then
  sed -i '' 's/"name": "nanoclaw"/"name": "nanopod"/' package.json
  git add package.json
fi

# CLAUDE.md: keep NanoPod heading
if grep -q '^# NanoClaw' CLAUDE.md; then
  sed -i '' 's/^# NanoClaw/# NanoPod/' CLAUDE.md
  git add CLAUDE.md
fi

# launchd: keep com.nanopod references if plist was renamed
if ls launchd/com.nanoclaw.plist 2>/dev/null; then
  git mv launchd/com.nanoclaw.plist launchd/com.nanopod.plist 2>/dev/null || true
fi
```

If any substitutions were made, amend or create a fixup commit:
```bash
git diff --cached --quiet || git commit -m "chore: restore NanoPod branding after upstream merge"
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

Resolve any conflicts as in Step 4A. Apply name substitutions after each pick if needed.

# Step 4C/D: Rebase

```bash
git rebase upstream/$UPSTREAM_BRANCH
```

For each conflict round:
- Resolve only conflict markers.
- Apply name substitutions inline as you go.
- `git add <file>`
- `git rebase --continue`

If more than 3 rounds of conflicts: `git rebase --abort` and recommend merge instead.

After rebase completes, apply the name substitution pass from Step 4A.

# Step 5: Validation

```bash
npm run build
npm test
```

If build fails: show the error. Only fix issues clearly caused by the merge (missing imports, type errors from merged code). Do not refactor unrelated code.

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
