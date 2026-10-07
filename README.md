<img src="resources/logo-xl.png" alt="Workforest logo" />

# workforest

Workforest (`wf`) is a CLI for managing Git worktrees and the files they share. Keep separate checkouts for branches while reusing local configuration, dependencies, or assets from your main worktree.

## What it helps with

- **Work on multiple branches:** create, inspect, and remove worktrees without switching your current checkout.
- **Reuse local files:** symlink shared files and directories into worktrees instead of setting them up each time.
- **Keep worktree settings independent:** copy selected files and exclude shared entries per worktree.
- **Keep your setup in sync:** track worktrees and sharing in `workforest.yaml`, check for drift, and reconcile changes with `wf sync`.
- **Automate setup and cleanup:** run hooks when creating, removing, or syncing worktrees.

Use it to keep a feature branch alongside a bugfix or review checkout, share local dependencies and assets, or give each branch its own environment configuration.

## Installation

Requires Git, Bun to build and install, and a POSIX shell for the installer. The installed `wf` executable runs without Bun; Git must remain available.

```bash
git clone https://github.com/Poto-si/workforest.git
cd workforest
sh install.sh
wf --help
```

The installer writes `wf` to `~/.local/bin`; ensure that directory is on your `PATH`. Set `BIN_DIR` to choose another destination.

## Documentation

See the [GitHub wiki](https://github.com/Poto-si/workforest/wiki) for getting started, commands, configuration, hooks, and troubleshooting.

## License

See [LICENSE](LICENSE).
