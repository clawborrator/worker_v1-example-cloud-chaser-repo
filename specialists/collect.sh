#!/usr/bin/env bash
# Collect one snapshot of host system + docker state. Emits JSON
# on stdout. Reads from /host/* mounts (read-only) and the docker
# socket bind (read-only). Never writes outside its own stdout.
#
# Usage: bash specialists/collect.sh <server_name>
#
# Output schema (top-level fields):
#   ts            ISO8601 UTC timestamp
#   hostname      argv[1] (the agent-derived SERVER_NAME)
#   kernel_host   /host/etc/hostname (raw, for cross-check)
#   uptime_s      host uptime in seconds
#   load          { "1m":..., "5m":..., "15m":... }
#   cpu           { "ncores":..., "pct":... }
#   mem           { "total_mb":..., "used_mb":..., "pct":... }
#   disks         [ { "mount":..., "size_mb":..., "used_mb":..., "pct":... }, ... ]
#   kernel_errors_last_hour  [ "line", ... ]   (best-effort)
#   docker        { "available": bool, "containers": [...] }
#
# `overall_health` and `summary` are set by the AGENT (Claude) in
# its scoring step, not here. This script only measures.

set -uo pipefail

SERVER_NAME="${1:-unknown}"
NOW_TS=$(date -u +%FT%TZ)
KERNEL_HOST=$(cat /host/etc/hostname 2>/dev/null | tr -d '\n' || echo "unknown")

# Uptime (seconds, integer).
if [ -r /host/proc/uptime ]; then
  UPTIME_S=$(awk '{print int($1)}' /host/proc/uptime)
else
  UPTIME_S=0
fi

# Load averages.
if [ -r /host/proc/loadavg ]; then
  read L1 L5 L15 _ < /host/proc/loadavg
else
  L1=0; L5=0; L15=0
fi

# CPU: ncores from /host/sys, percent computed by sampling
# /host/proc/stat 0.5s apart.
NCORES=0
if [ -d /host/sys/devices/system/cpu ]; then
  NCORES=$(ls -1d /host/sys/devices/system/cpu/cpu[0-9]* 2>/dev/null | wc -l)
fi
[ "$NCORES" -eq 0 ] && NCORES=$(awk -F: '/^processor/{n++} END{print n+0}' /host/proc/cpuinfo 2>/dev/null)
[ "$NCORES" -eq 0 ] && NCORES=1

cpu_pct() {
  # Sample /proc/stat twice and compute the busy ratio. We use the
  # CONTAINER's /proc/stat for CPU% rather than /host/proc/stat —
  # they should be identical on Linux (cpu accounting is global),
  # and the container's view is reliably accessible. Fall back to 0
  # if /proc/stat is unreadable.
  if [ ! -r /proc/stat ]; then echo 0; return; fi
  read _ a b c d e f g h _ < /proc/stat
  IDLE1=$((d+e))
  TOTAL1=$((a+b+c+d+e+f+g+h))
  sleep 0.5
  read _ a b c d e f g h _ < /proc/stat
  IDLE2=$((d+e))
  TOTAL2=$((a+b+c+d+e+f+g+h))
  DI=$((IDLE2-IDLE1))
  DT=$((TOTAL2-TOTAL1))
  if [ "$DT" -le 0 ]; then echo 0; return; fi
  awk -v di=$DI -v dt=$DT 'BEGIN{printf "%.1f", (1 - di/dt) * 100}'
}
CPU_PCT=$(cpu_pct)

# Memory (from /host/proc/meminfo).
MEM_TOTAL_KB=0; MEM_AVAILABLE_KB=0
if [ -r /host/proc/meminfo ]; then
  MEM_TOTAL_KB=$(awk '/^MemTotal:/ {print $2}' /host/proc/meminfo)
  MEM_AVAILABLE_KB=$(awk '/^MemAvailable:/ {print $2}' /host/proc/meminfo)
fi
MEM_TOTAL_MB=$((MEM_TOTAL_KB/1024))
MEM_AVAILABLE_MB=$((MEM_AVAILABLE_KB/1024))
MEM_USED_MB=$((MEM_TOTAL_MB - MEM_AVAILABLE_MB))
if [ "$MEM_TOTAL_MB" -gt 0 ]; then
  MEM_PCT=$(awk -v u=$MEM_USED_MB -v t=$MEM_TOTAL_MB 'BEGIN{printf "%.1f", 100*u/t}')
else
  MEM_PCT=0
fi

# Disks. We see only the container's /; the host's disks are not
# directly accessible. df from inside the container of /host/proc
# is unhelpful. Best we can do without privileged mounts is read
# /host/proc/mounts + statvfs each interesting mount. Cheap-and-good:
# parse /host/proc/mounts, then df each unique source through the
# container's view (which doesn't see host disks). On most fleets,
# operators will care about the docker host's main fs and dedicated
# volumes — for those they should bind-mount the volume root in too.
# As a practical shortcut, we emit df of mounts we CAN read from the
# container (/, /host/var/log, etc), which still surfaces the root
# fs of the container host since /proc and /sys are bind-mounts.
DISKS_JSON='[]'
if command -v df >/dev/null 2>&1; then
  DISKS_JSON=$(df -P -k 2>/dev/null \
    | awk 'NR>1 && $1 !~ /^(overlay|tmpfs|devtmpfs|udev|none|shm)$/ {
        printf "{\"mount\":\"%s\",\"size_mb\":%d,\"used_mb\":%d,\"pct\":%d},",
          $6, $2/1024, $3/1024, ($2 == 0 ? 0 : 100*$3/$2)
      }' \
    | sed 's/,$//' \
    | awk 'BEGIN{print "["} {print} END{print "]"}' \
    | tr -d '\n')
  [ -z "$DISKS_JSON" ] && DISKS_JSON='[]'
fi

# Kernel errors in the last hour.
KERNEL_ERRORS_JSON='[]'
if [ -r /host/var/log/syslog ]; then
  # Last hour by mtime — simple grep on a timestamp range is fragile
  # across distros, so take the tail and filter.
  KERNEL_ERRORS_JSON=$(tail -n 2000 /host/var/log/syslog 2>/dev/null \
    | grep -iE 'error|fail|panic|oom|i/o error' \
    | tail -n 50 \
    | awk '{gsub(/"/, "\\\""); printf "\"%s\",", $0}' \
    | sed 's/,$//' \
    | awk 'BEGIN{print "["} {print} END{print "]"}' \
    | tr -d '\n')
  [ -z "$KERNEL_ERRORS_JSON" ] && KERNEL_ERRORS_JSON='[]'
elif [ -r /host/var/log/messages ]; then
  KERNEL_ERRORS_JSON=$(tail -n 2000 /host/var/log/messages 2>/dev/null \
    | grep -iE 'error|fail|panic|oom|i/o error' \
    | tail -n 50 \
    | awk '{gsub(/"/, "\\\""); printf "\"%s\",", $0}' \
    | sed 's/,$//' \
    | awk 'BEGIN{print "["} {print} END{print "]"}' \
    | tr -d '\n')
  [ -z "$KERNEL_ERRORS_JSON" ] && KERNEL_ERRORS_JSON='[]'
fi

# Docker. Use the docker CLI if installed in the image; otherwise
# curl the socket directly.
DOCKER_JSON='{"available":false,"containers":[]}'
docker_available() {
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.ID}}' >/dev/null 2>&1
    return $?
  fi
  return 1
}

if docker_available; then
  # One row per container: id, name, image, state, status string,
  # health (if any), uptime_s, restart_count.
  CONTAINER_ROWS=$(docker ps -a --format '{{.ID}}' 2>/dev/null | while read -r CID; do
    [ -z "$CID" ] && continue
    INSPECT=$(docker inspect "$CID" 2>/dev/null) || continue
    # Pull the fields we want with awk-ish jq alternatives. We don't
    # require jq; awk-grep does the job for the small subset.
    NAME=$(echo "$INSPECT" | grep -m1 '"Name"' | head -1 | sed 's/.*"Name": "\/\(.*\)",/\1/')
    IMAGE=$(echo "$INSPECT" | grep -m1 '"Image": "' | head -1 | sed 's/.*"Image": "\(.*\)",/\1/')
    STATE=$(echo "$INSPECT" | grep -m1 '"Status": "' | head -1 | sed 's/.*"Status": "\(.*\)",/\1/')
    HEALTH=$(echo "$INSPECT" | grep -m1 '"Status": "' | grep -A0 '' || true)
    HEALTH_STR=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CID" 2>/dev/null)
    RESTARTS=$(docker inspect --format '{{.RestartCount}}' "$CID" 2>/dev/null)
    STARTED=$(docker inspect --format '{{.State.StartedAt}}' "$CID" 2>/dev/null)
    EXIT_CODE=$(docker inspect --format '{{.State.ExitCode}}' "$CID" 2>/dev/null)
    # Capture the last 100 log lines once, then derive both the
    # count of error-like lines AND the last 5 actual lines (samples)
    # from that same buffer. Two grep passes on a small string is
    # cheaper than two `docker logs` round trips.
    LOG_TAIL=$(docker logs --tail 100 "$CID" 2>&1 || true)
    # grep -c emits the count (even when zero) and exits 1 on no
    # matches; swallow the exit code.
    ERR_COUNT=$(printf '%s\n' "$LOG_TAIL" | { grep -ciE 'error|fatal|panic|fail' || true; })
    # Last 5 matching lines. Strip control chars, CSI residue, OSC
    # residue, then JSON-escape. We keep TUI-redraw lines after
    # cleanup — the operator sees what was matched and can judge
    # for themselves whether a line is signal or TUI noise.
    ERR_SAMPLES_INNER=$(printf '%s\n' "$LOG_TAIL" \
      | { grep -iE 'error|fatal|panic|fail' || true; } \
      | tail -n 5 \
      | awk '{
          s = $0
          gsub(/[\001-\037]/, "", s)
          gsub(/\[[0-9;?]*[A-Za-z]/, "", s)
          gsub(/\][0-9]+;/, "", s)
          gsub(/\\/, "\\\\", s)
          gsub(/"/, "\\\"", s)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)
          if (length(s) > 0) printf "\"%s\",", s
        }' \
      | sed 's/,$//')
    ERR_SAMPLES="[${ERR_SAMPLES_INNER}]"
    # JSON-escape name + image.
    NAME_J=$(printf '%s' "$NAME" | sed 's/"/\\"/g')
    IMG_J=$(printf '%s' "$IMAGE" | sed 's/"/\\"/g')
    printf '{"id":"%s","name":"%s","image":"%s","state":"%s","health":"%s","restart_count":%s,"started_at":"%s","exit_code":%s,"err_lines_last_100":%s,"err_samples":%s},' \
      "${CID:0:12}" "$NAME_J" "$IMG_J" "$STATE" "$HEALTH_STR" "${RESTARTS:-0}" "$STARTED" "${EXIT_CODE:-0}" "${ERR_COUNT:-0}" "$ERR_SAMPLES"
  done | sed 's/,$//')
  DOCKER_JSON=$(printf '{"available":true,"containers":[%s]}' "$CONTAINER_ROWS")
fi

# Final JSON.
cat <<EOF
{
  "ts": "$NOW_TS",
  "hostname": "$SERVER_NAME",
  "kernel_host": "$KERNEL_HOST",
  "uptime_s": $UPTIME_S,
  "load": { "1m": $L1, "5m": $L5, "15m": $L15 },
  "cpu": { "ncores": $NCORES, "pct": $CPU_PCT },
  "mem": { "total_mb": $MEM_TOTAL_MB, "used_mb": $MEM_USED_MB, "pct": $MEM_PCT },
  "disks": $DISKS_JSON,
  "kernel_errors_last_hour": $KERNEL_ERRORS_JSON,
  "docker": $DOCKER_JSON
}
EOF
