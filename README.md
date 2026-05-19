# worker_v1-example-cloud-chaser-repo

Companion repo for the **cloud-chaser** clawborrator worker example.
This repo holds:

- `CLAUDE.md` — the agent's playbook (what runs every hour).
- `specialists/derive-name.sh` — kernel-hostname → `SERVER_NAME` slug.
- `specialists/collect.sh` — host system + docker snapshot collector.
- `specialists/render.js` — deterministic dashboard renderer.
- `data/<server-name>/` — per-server snapshot history (one JSON per
  hour, plus `latest.json`). Created on first cycle.
- `public/index.html`, `public/server/<server-name>.html` — the
  dashboard. Regenerated every cycle.

The worker container (in the sibling
[`worker_v1-example-cloud-chaser-worker`](https://github.com/clawborrator/worker_v1-example-cloud-chaser-worker)
repo) clones THIS repo into `/workspace/repo` on boot, then hands
control to the playbook in its `CLAUDE.md`.

## Cycle (every hour)

The agent's playbook (`CLAUDE.md`) is the source of truth. Short
version:

1. Derive `SERVER_NAME` from `/host/etc/hostname` (override with
   `SERVER_NAME_OVERRIDE`).
2. Run `specialists/collect.sh` → write
   `data/<SERVER_NAME>/<timestamp>.json`.
3. Score the snapshot (green / amber / red) in the agent's own
   turn; patch the JSON with `overall_health` and `summary`; copy
   to `latest.json`.
4. Prune snapshots older than 7 days.
5. Run `specialists/render.js` → regenerate `public/index.html`
   and `public/server/<server-name>.html`.
6. Commit `data/<SERVER_NAME>/` + `public/`, pull --rebase, push.
7. If amber or red (or `NOTIFY_ON_PROBLEM_ONLY=0`), notify
   `@${NOTIFY_PEER}` via `route_to_peer`.
8. Return — next cycle is one hour later via `CronCreate`.

## Server identity

`SERVER_NAME` is **not configured per host.** It's derived
automatically from `/host/etc/hostname` (mounted read-only) at the
start of every cycle. To override (e.g. the kernel hostname is
`ip-10-0-1-23` and you'd rather see `prod1`), set
`SERVER_NAME_OVERRIDE` in the worker's `.env`. `specialists/derive-name.sh`
honours the override.

This means the same .env can be deployed across the entire fleet
unchanged, and a host rename propagates on the next cycle (the
old `data/<old-name>/` folder is orphaned in the repo but not
overwritten — clean it up manually if/when you do rename).

## Health scoring

| Tier  | Triggered by ANY of                                                 |
|-------|---------------------------------------------------------------------|
| red   | any disk ≥ 95%, any kernel error in the last hour, any container marked `unhealthy`, any container that exited unexpectedly |
| amber | any disk ≥ 80%, mem ≥ 90%, load > ncores, error-line spike in container logs, container restarted in the last hour |
| green | none of the above                                                   |

To tweak thresholds, edit `CLAUDE.md`'s scoring step and push. The
next cycle on every server picks up the new playbook on its next
restart (or sooner, if the entrypoint re-pulls between cycles —
the current entrypoint pulls on boot only).

## Adding a new server

1. Deploy the worker container on the new host (see the worker
   repo's README).
2. Wait an hour (or restart the container for an immediate warmup).
3. The new server shows up on `public/index.html` automatically.

No code change in this repo required. The renderer auto-discovers
every subdirectory under `data/`.

## Dashboard hosting

The repo includes a static dashboard at `public/index.html`. Three
ways to view it:

- **GitHub Pages**: Settings → Pages → branch `main`, folder
  `/public`. Then visit
  `https://clawborrator.github.io/worker_v1-example-cloud-chaser-repo/`.
- **Raw GitHub view**: works for `public/index.html` but won't
  render the CSS link. Less pretty.
- **Local**: clone, `cd public`, `python3 -m http.server`.

## What the agent never does

- Write to the host filesystem (all mounts are read-only).
- Run `docker restart`, `docker stop`, or any container lifecycle
  command. Read-only observer.
- Touch another server's `data/` folder.
- Run sub-hourly cycles (cron is the schedule, the agent doesn't
  loop).

## Concurrency

N servers may commit simultaneously. The repo handles this by:

- Per-server folder scoping: server A only touches
  `data/<a>/`, server B only touches `data/<b>/`.
- `public/` is regenerated deterministically from `data/`, so
  every server's renderer produces byte-identical bytes given the
  same inputs.
- `git pull --rebase origin main` before each push.
- One retry on rejected-non-fast-forward; defer to next cycle on
  a second rejection.

This means commits from N servers serialize cleanly, with only
brief contention windows around `git push`.
