#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX=${PREFIX:-"${HOME}/.local"}
BIN_DIR=${BIN_DIR:-"${PREFIX}/bin"}

find_bun() {
  if [ -n "${BUN:-}" ]; then
    printf '%s\n' "${BUN}"
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  if [ -x "${HOME}/.bun/bin/bun" ]; then
    printf '%s\n' "${HOME}/.bun/bin/bun"
    return 0
  fi

  return 1
}

BUN_BIN=$(find_bun) || {
  printf '%s\n' "bun is required to install workforest. Install Bun or set BUN=/path/to/bun." >&2
  exit 127
}

cd "${SCRIPT_DIR}"

"${BUN_BIN}" install --frozen-lockfile
"${BUN_BIN}" build src/cli.ts --compile --outfile wf

mkdir -p "${BIN_DIR}"
install -m 755 "${SCRIPT_DIR}/wf" "${BIN_DIR}/wf"
rm -f "${SCRIPT_DIR}/wf"

printf '%s\n' "Installed wf to ${BIN_DIR}/wf"

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    printf '%s\n' "Add ${BIN_DIR} to your PATH to run wf globally."
    ;;
esac
