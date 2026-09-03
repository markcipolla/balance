#!/usr/bin/env bash
# Cross-compile balance binaries for all release platforms.
# Produces dist/balance_<version>_<os>_<arch>.tar.gz + a matching .sha256 file.
#
# Usage: scripts/build-all.sh [version]
#   version — override the version tag baked into artifact names.
#             Defaults to the "version" field in package.json.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-$(bun -e 'console.log(require("./package.json").version)')}"
OUT="dist"
rm -rf "$OUT"
mkdir -p "$OUT"

# target triple : release asset suffix (matches diskclean's naming so the tap looks consistent)
TARGETS=(
  "bun-darwin-arm64:darwin_arm64"
  "bun-darwin-x64:darwin_amd64"
  "bun-linux-arm64:linux_arm64"
  "bun-linux-x64:linux_amd64"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  asset="${entry##*:}"
  echo "==> building $target"
  bun build src/index.ts \
    --compile \
    --target="$target" \
    --outfile "$OUT/balance"

  # Ad-hoc codesign darwin builds. Without a signature the macOS kernel
  # SIGKILLs the process at exec on Sequoia+. --remove-signature first
  # because Bun leaves a partial/invalid signature that plain --sign chokes
  # on ("invalid or unsupported format for signature").
  case "$target" in
    bun-darwin-*)
      if command -v codesign >/dev/null 2>&1; then
        codesign --remove-signature "$OUT/balance" 2>/dev/null || true
        codesign --sign - --force --deep "$OUT/balance"
      else
        echo "    !! codesign not available; darwin binary will SIGKILL on target" >&2
      fi
      ;;
  esac

  tarball="$OUT/balance_${VERSION}_${asset}.tar.gz"
  tar -czf "$tarball" -C "$OUT" balance
  rm "$OUT/balance"

  # SHA sidecar — the Homebrew formula generator reads these.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$tarball" | awk '{print $1}' > "${tarball}.sha256"
  else
    shasum -a 256 "$tarball" | awk '{print $1}' > "${tarball}.sha256"
  fi
  echo "    $(cat "${tarball}.sha256")  $(basename "$tarball")"
done

echo
echo "Built version $VERSION:"
ls -lh "$OUT"/*.tar.gz
