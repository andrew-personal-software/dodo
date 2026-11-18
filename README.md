# dodo

A store of markdown docs: how projects are set up, deployed and run. Agents read and write docs with the `dodo` CLI. People read, search and edit them in a web UI that works on a phone and offline.

Spec: `docs/superpowers/specs/2026-11-02-dodo-design.md`.

## How it runs

On the mini PC, as a [hawk](https://github.com/andrew-personal-software/hawk) podman app (`RUNTIME=podman` in hawk's `apps/dodo.env`). `Containerfile` builds the image and `deploy/hawk.json` says how hawk runs it.

- The web app runs blue/green: `dodo-blue` on `127.0.0.1:3420`, `dodo-green` on `127.0.0.1:4420` (sparrow 3417, crow 3418, budgie 3419). Caddy serves the live one to the tailnet only at `https://dodo.andrewminghanjiang.com`. No login.
- Rows are in hawk's Postgres, schema `dodo` of database `apps`. Uploaded files are in `/var/lib/dodo/files` (`/data/files` in the container).
- Each server process keeps the doc index in memory. Every write sends `NOTIFY dodo_changed`; every process listens and reloads, so both slots stay current during a deploy.
- `dodo-cleanup.timer` (03:30) removes upload files with no row that are over 7 days old. hawk backs up the schema and files nightly into `/var/backups/dodo`.

Every merge to `main` releases and deploys with no downtime: hawk builds the image, backs up, runs `node dist/migrate.js`, starts the idle slot, checks `/api/version`, then switches Caddy. End a PR title with the task key, like `fix(search): trim the query (DODO-3)`, and hawk marks the task done after the deploy.

**Migrations** (`MIGRATIONS` in `src/core/db.ts`, append only) must not break the version that is still live: add columns and tables, do not rename or drop them in the same release. If you must, set `"downtime": true` in `deploy/hawk.json` for that release.

## Deploy (mini PC)

1. **Set up dodo** from a checkout of this repo: `sudo hawk setup dodo <checkout>`. It makes the user, `/var/lib/dodo`, the Postgres role and schema, the units and the Caddy site. Safe to re-run.
2. **Deploy.** Merge to `main`.
3. Open `https://dodo.andrewminghanjiang.com` from a device on your tailnet. On a phone, use "Add to Home Screen".

Rollback: `sudo hawk rollback dodo [version]`. It does not touch the DB. If a migration changed it, restore a dump from `/var/backups/dodo` first (hawk README, "Restore a backup").

The one-time move from SQLite: `node dist/import-sqlite.js /data/dodo.db` in the image, after `node dist/migrate.js`, into the empty schema. It prints the row counts and refuses a schema that has docs.

## CLI

Install it from the server:

```sh
curl -fsSL https://dodo.andrewminghanjiang.com/cli/dodo.js -o ~/.local/bin/dodo && chmod +x ~/.local/bin/dodo
```

`dodo help` lists the commands. `dodo agents-md` prints a snippet for an agent's `AGENTS.md` / `CLAUDE.md`. `dodo upgrade` fetches the server's version.

## Develop

```sh
pnpm install
pnpm dev          # dev Postgres (container dodo-dev-pg, 127.0.0.1:55432, schema dodo), then next dev on the first free port from 3000
pnpm test         # needs the dev Postgres; each test gets a fresh schema
pnpm typecheck
pnpm build        # next build, then the CLI, migrate, cleanup and import-sqlite bundles in dist/
node dist/cli.js --env dev list
pnpm db:pull      # replace the local schema dodo and files with a copy of prod
```
