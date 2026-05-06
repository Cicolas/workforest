# workforest

A CLI for managing Git worktree setups with shared files and per-worktree exclusions.

## Features

- **Manifest-based workflow** — tracks the repo root, active worktrees, and shared paths in `workforest.yaml`
- **Worktree creation** — creates a new Git worktree and updates the manifest
- **Shared paths** — symlinks selected files or directories from the main worktree into other worktrees
- **Per-worktree exclusions** — skip selected shared entries for a specific worktree with `ignoreShared`
- **Sync command** — prunes stale Git worktrees, refreshes the manifest, and reapplies shared links
- **Commander-powered help** — generated command help for `wf`, `wf init`, `wf create`, and `wf sync`

## Installation

### Run locally

`wf` is launched through `bin/wf` and requires Bun:

```bash
./bin/wf --help
```

### Build from source

Install dependencies:

```bash
bun install
```

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
  assets/: assets/
```

Behavior:

- `shared` maps paths from the main worktree to paths created in other worktrees
- `ignoreShared` lets one worktree opt out of specific `shared` entries
- glob-style shared entries such as `node_modules/**/*` are supported

## Development

Useful commands:

```bash
bun test
bun src/cli.ts --help
bun src/cli.ts create --help
```

## License

See [LICENSE](LICENSE).
