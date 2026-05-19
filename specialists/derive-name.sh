#!/usr/bin/env bash
# Emits the SERVER_NAME on stdout. Single line, no trailing newline
# from the source (we strip whitespace and lowercase).
#
# Order of precedence:
#   1. $SERVER_NAME_OVERRIDE                 — operator-supplied
#   2. /host/etc/hostname                    — kernel hostname mount
#
# Exits non-zero if both sources are missing.

set -euo pipefail

if [ -n "${SERVER_NAME_OVERRIDE:-}" ]; then
  raw="$SERVER_NAME_OVERRIDE"
elif [ -r /host/etc/hostname ]; then
  raw=$(cat /host/etc/hostname)
else
  echo "derive-name: no SERVER_NAME_OVERRIDE and no /host/etc/hostname" >&2
  exit 1
fi

# Lowercase, strip whitespace, sanitise to [a-z0-9-].
slug=$(printf '%s' "$raw" \
  | tr '[:upper:]' '[:lower:]' \
  | tr -d '[:space:]' \
  | sed 's/[^a-z0-9-]/-/g' \
  | sed 's/^-*//;s/-*$//')

if [ -z "$slug" ]; then
  echo "derive-name: empty slug after sanitisation (raw=$raw)" >&2
  exit 1
fi

printf '%s' "$slug"
