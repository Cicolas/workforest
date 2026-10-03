# workforest

A CLI for managing Git worktree setups with shared files and per-worktree exclusions.

## Features

- **Manifest-based workflow** — tracks the repo root, active worktrees, and shared paths in `workforest.yaml`
- **Worktree creation** — creates a new Git worktree and updates the manifest
- **Shared paths** — symlinks selected files or directories from the main worktree into other worktrees
- **Per-worktree exclusions** — skip selected shared entries for a specific worktree with `ignoreShared`
- **Sync command** — prunes stale Git worktrees, refreshes the manifest, and reapplies shared links
- **List command** — lists manifest worktrees and whether their paths exist
- **Status command** — checks manifest/Git drift and shared links without changing them
- **Remove command** — removes non-main worktrees and optionally deletes merged local branches
- **Commander-powered help** — generated command help for `wf` and its subcommands

## Installation

### Run locally

Run the CLI from source with Bun:

```bash
bun src/cli.ts --help
```

### Install with shell script

Install to `~/.local/bin`:

```bash
sh install.sh
```

Override the destination:

```bash
BIN_DIR="$HOME/bin" sh install.sh
```

### Build from source

Install dependencies:

```bash
bun install
```

Build the Bun-targeted bundle:

```bash
bun run build
```

This writes the built artifact to `dist/cli.js`.

Build a standalone `wf` binary:

```bash
bun run build:bin
```

This writes the compiled executable to `./wf`.

Run tests:

```bash
bun test
```

## Usage

Human-readable output uses colored help, table headers, branches, states, roles,
action labels, status findings, and errors when supported by the terminal.
Set `NO_COLOR=1` to disable colors or
`FORCE_COLOR=1` to request them when piping output (overriding `NO_COLOR`).
`--json` output stays plain.

Initialize a manifest:

```bash
wf init [main-folder]
```

The **main worktree** is Git's original checkout, whose `.git` directory holds
repository metadata. It is independent of the branch name: checking out a
branch named `main` in a linked worktree does not make that worktree the main
worktree. The manifest's `repo.root` is this main worktree and is the source
root for all `shared` entries. Exactly its worktree entry has `isMain: true`.

You can run `wf init` inside either the main or a linked worktree, or pass either
worktree's folder to `wf init [main-folder]`. Both record the same actual main
root. The manifest is written in the directory where you run the command;
initialization refuses to overwrite an existing `workforest.yaml`. Commands
continue to find manifests in the current directory or the existing repository
ancestor locations; initialization in a linked worktree does not create a
central manifest for sibling worktrees.

Workforest supports repositories with an available main checkout and its Git
common directory at `<main-worktree>/.git`. Bare repositories, separate Git
directories, and inconsistent main-worktree registrations are rejected.
Before create or sync changes anything, it verifies that `repo.root` and the
manifest's main marker identify the actual main worktree. If an older manifest
records a linked source root, correct `repo.root` and its `isMain` markers to
match Git, or back up the manifest and reinitialize it, retaining your sharing
entries and exclusions. Sync leaves the main source worktree untouched.

Create a worktree:

```bash
wf create <folder> <branch-name>
```

Sync the manifest and shared links:

```bash
wf sync
```

List manifest worktrees without syncing, including missing paths:

```bash
wf list
wf list --json
```

Check all worktrees or one worktree identified by branch name or path:

```bash
wf status
wf status feature/a
wf status ./feature-a --json
```

Status exits with `0` when healthy, `1` when drift is found, and `2` when the
check cannot run. It does not repair links or refresh the manifest; use `wf sync`
to repair supported drift. Inventory drift uses stable finding codes:
`worktree_branch_mismatch` for a changed branch, `worktree_detached_mismatch`
when the manifest and Git disagree about detachment, and
`worktree_main_mismatch` when the cached main role differs from Git. Status
checks the live main role when deciding which worktree is the shared source;
its JSON remains `{ "level": "...", "findings": [...] }`.

Remove a non-main worktree by branch name or path:

```bash
wf remove feature/a
wf remove ./feature-a --force
wf remove feature/a --delete-branch
```

Removal refuses dirty worktrees unless `--force` is given; force removal discards
their local changes. Branches are kept by default. `--delete-branch` uses Git's
safe deletion check and keeps unmerged branches. An already-missing directory
is pruned from Git and the manifest. The main worktree cannot be removed.

Removal reads current Git registrations before pruning or deleting anything.
If a cached branch target points to a worktree that has switched branches or
detached, the command refuses that obsolete association, even if another
worktree now uses the old branch. Use the intended worktree's path or run
`wf sync` to refresh the inventory before selecting a branch. Path-based
`--delete-branch` acts on the current branch; detached worktrees have no branch
to delete. Safe branch deletion can fail after worktree removal: the branch
is retained, the manifest is reconciled, and the command reports the failure.

## Manifest

The parser supports the manifest structure shown below, rather than the full
YAML language. Quote source names containing colons or spaces. Double-quoted
keys and values use JSON string escapes; single-quoted strings escape an
apostrophe by doubling it (`'owner''s:settings'`). Rewrites preserve these
names, sharing options, and exclusions, using double quotes where needed.

Example `workforest.yaml`:

```yaml
version: 1
repo:
  name: main
  root: /path/to/repo/main
worktrees:
  - path: /path/to/repo/main
    branch: main
    isMain: true
  - path: /path/to/repo/feature-a
    branch: feature/a
    isMain: false
    ignoreShared:
      - .env
shared:
  .env: .env
  assets/:
    target: assets/
  .env.local:
    target: .env.local
    copy: true
```

Behavior:

- `shared` accepts both `source: target` and `source:` with a nested `target` key; both create symlinks by default
- Add `copy: true` to a nested entry to copy a file or directory instead of linking it; `copy: false` creates a symlink
- `wf create` and `wf sync` create missing copies from the main worktree and preserve existing targets, so worktree edits remain independent
- `wf sync --refresh` replaces all copied targets; `wf sync --refresh .env.local` refreshes only the given source or target path (also supports individual files within a glob)
- `wf status` checks that copies exist and match the source's file or directory type; it does not compare their contents
- `ignoreShared` lets one worktree opt out of specific `shared` entries
- glob-style shared entries such as `node_modules/**/*` are supported

Shared globs match files, including hidden entries. `*` matches within one path
segment: `assets/*.txt` selects text files directly inside `assets`, without
recursing or selecting JSON files. A complete `**` segment matches zero or more
segments: `assets/**/*.txt` also selects nested text files. Targets must end in
`/`; paths below the directory preceding the first wildcard retain their
hierarchy. Literal prefixes within wildcard segments work too, such as
`assets/report-*.txt`. Missing source directories produce no shared targets.
Create, sync, and status use the same matching rules. Exclusions match the exact
source key, and selective copy refresh accepts an individual source or target
path within the selected files.

Question-mark wildcards, character classes, brace expansion, extglobs, escaped
wildcards, and embedded double stars such as `file**.txt` are unsupported and
produce an explicit configuration error. Workforest does not expand these forms
into a directory selection.

Copy refresh prepares a complete replacement beside the destination before
moving its old contents. If preparation fails, the old copy remains untouched.
If installation fails after the old target was moved aside, Workforest restores
that target, including a destination symlink without changing its referent.
If restoration or cleanup fails, the error identifies the retained recovery
paths and what to inspect or restore. A cleanup error can occur after the new
copy was installed; the diagnostic states that the target was replaced. After
correcting a source or filesystem problem, retry `wf sync --refresh` (or select
one source or target). This preservation applies to each copy independently;
earlier completed entries and Git operations are not rolled back as a group.

Sharing destinations must be strictly inside their destination worktree. Targets
cannot be the worktree root, contain a `.git` component, alias Git metadata,
overlap any shared source, or overlap another planned target. Existing ancestor
symlinks are resolved during validation, so a directory link cannot redirect a
write outside the worktree or onto source data. A target symlink itself can be
replaced safely: its referent is preserved. External shared sources remain
supported when these destination and source-preservation rules hold.

Create validates the configuration before creating a branch or worktree. Sync
validates every available destination before pruning or changing shared files.
Sharing rechecks the complete plan against the filesystem immediately before
application, including ancestors materialized by a new checkout. A checkout
that introduces an unsafe ancestor can therefore fail after Git creation; it
is retained for inspection and recovery. These checks do not coordinate with
concurrent filesystem changes and do not make Git and filesystem operations a
transaction.

## Development

`src/cli.ts` assembles the CLI. Each command lives in `src/commands/<name>/`,
with `<name>-command.ts` for Commander registration and `<name>.ts` for its
implementation. Shared Git, manifest, symlink, target, and error helpers live
in `src/lib/`. Tests live in `tests/`.

Useful commands:

```bash
bun test
bun run build
bun run build:bin
bun src/cli.ts --help
bun src/cli.ts create --help
```

## License

See [LICENSE](LICENSE).
