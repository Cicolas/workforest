# Repository Guidelines

## Project Structure & Module Organization

Workforest is a Bun-powered TypeScript CLI (`wf`) for managing Git worktrees and shared symlinks. `src/cli.ts` assembles the CLI. Each command has a folder under `src/commands/<name>/` containing `<name>-command.ts` for Commander wiring and `<name>.ts` for workflow logic. Shared helpers live in `src/lib/`: Git operations in `git.ts`, manifest parsing and serialization in `config.ts` and `manifest.ts`, symlink handling in `shared-links.ts`, target resolution in `target.ts`, and error reporting in `errors.ts`.

`tests/` contains CLI and integration tests. `example/workforest.yaml` illustrates configuration; example worktree assets are local demonstration data. `install.sh` builds and installs the executable. Generated `dist/`, `wf`, and `node_modules/` are ignored.

## Build, Test, and Development Commands

Run these commands from the repository root with Bun and Git installed:

- `bun install`: install dependencies using `bun.lock`.
- `bun src/cli.ts --help`: run the CLI directly from source.
- `bun run build`: bundle the CLI into `dist/cli.js` for Bun.
- `bun run build:bin`: compile a standalone `./wf` executable.
- `bun test`: run all tests; `bun test tests/cli.test.ts` runs one file.
- `bun run format:check`: check Prettier formatting.
- `bun run format`: apply formatting; review the resulting diff.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules with explicit `.ts` extensions for local imports. Follow `.prettierrc.json`: two-space indentation, spaces rather than tabs, and semicolons. Existing code uses double-quoted strings. Use camelCase for functions and variables, PascalCase for types and interfaces, and descriptive lowercase filenames such as `shared-links.ts`. Keep command wiring separate from workflow logic.

## Testing Guidelines

Use `bun:test` with `describe`, `test`, and `expect`; name files `*.test.ts` and describe observable behavior in test names. Integration tests create temporary Git repositories and clean them up in `afterEach`. Follow that pattern when testing manifests, worktree discovery, exclusions, or symlink replacement. Add regression coverage for changed behavior. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

History uses short imperative subjects, such as `Add shell installer` and `Use commander for CLI help`, without a consistent prefix scheme. Keep commits focused. PR descriptions should explain the problem, resulting behavior, and validation commands; link relevant issues and include CLI output examples when help or command behavior changes. Run tests and formatting checks before submitting.
