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

Initialize a manifest:

```bash
wf init [main-folder]
```

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
to repair supported drift.

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

## Manifest

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
