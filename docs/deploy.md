# Deploying Torch: requirements

> Torch is pre-v1. This page lists what an installation needs before you start (database, machine, network, backups,
> health checks). Images, a production Compose file and the upgrade steps come with the full deploy guide later.

A Torch instance runs the Torch server (Node), a sync service (ElectricSQL, see [ADR 0001](adr/0001-sync-engine.md))
and PostgreSQL, and uses S3-compatible storage for attachments and an SMTP server for the sign-in emails. The browser
only talks to the Torch server; the sync service and the database are never exposed.

## 1. Requirements

- **PostgreSQL 17 or newer**, with `wal_level=logical`. The sync service reads the write-ahead log, so this is not
  optional and there is no degraded mode without it. Version 17 is the first with `transaction_timeout`, which the
  server sets on every connection to keep transactions shorter than the settle window of the issue list
  ([API](api/issues.md#list-and-poll)); an older server refuses the connection and `/health/db` reports
  `PostgreSQL 17 or newer is required`.
- **A role with the `REPLICATION` privilege** (or a superuser) for the sync service. Create it with
  `ALTER ROLE <name> WITH REPLICATION`. On Amazon RDS and Aurora the privilege comes from the `rds_replication` role
  (`GRANT rds_replication TO <name>`), and `wal_level` is set with the parameter `rds.logical_replication=1`, which
  needs a restart.
- **A direct connection for the sync service**: no transaction-mode pooler between it and PostgreSQL. Most connection
  poolers do not support logical replication (PgBouncer does from version 1.23, with its own settings), so connect to the
  database itself.
- **The server's role** (the `DATABASE_URL` of the Torch server) is the one `/health/db` inspects. If the sync service
  connects as a different role, give both the privilege, or check the sync side with `/health/sync` (section 6).
- **The sync settings of the Torch server:** `ELECTRIC_URL` (where the server reaches the sync service, on a private
  network) and `ELECTRIC_SECRET` (a long random value, the same on both sides, never sent to a browser). The
  [`.env.example`](../.env.example) file lists every variable. A production instance sets both: live sync is essential.

Managed PostgreSQL works when the provider allows logical replication and a role with the privilege above. The providers
that the sync service's documentation lists (Supabase, Neon, Amazon RDS and Aurora, Google Cloud SQL and AlloyDB,
DigitalOcean, Crunchy) are named in [ADR 0002](adr/0002-database-portability.md).

## 2. MySQL-only hosts

Torch runs on PostgreSQL only. It is not a missing feature: the sync service reads the PostgreSQL log, and a second
database engine would double the test surface of a schema whose isolation depends on engine-specific locking. The reasons
are in [ADR 0002](adr/0002-database-portability.md).

A host that can run containers can run PostgreSQL next to the other services in the same Compose file. A host that cannot
run containers cannot run the sync service either, and needs a managed PostgreSQL elsewhere. A port to MySQL maintained
outside this repository is welcome under the licence; the maintainers do not support one.

## 3. Machine sizes

| Size | CPU and memory | For |
|---|---|---|
| Minimum | 2 vCPU, 2 GB | a small team |
| Recommended | 2 vCPU, 4 GB | most teams |
| Large | 4 vCPU, 8 GB | 200 signed-in sessions, 100,000 issues (the sizing target) |

1 GB is not supported: the Torch server, the sync service and PostgreSQL alone need 700 to 900 MiB, before the
operating system and the container runtime. The figures come from [ADR 0003](adr/0003-implementation-language.md).

What grows with use: the sync service's memory with the number of open shapes (a shape is a live subscription to a
subset of the data), PostgreSQL's memory and disk with the number of issues, and disk with attachments and with the write-ahead log
(section 5).

## 4. Network

- **Base URL:** the public address of the web app is `APP_URL`. Links in emails and sign-in callbacks are built from it.
- **TLS** ends at a reverse proxy in front of the Torch server. Set `TRUST_PROXY=true` only when that proxy is the only
  way in, because the client address is then read from `x-forwarded-for`.
- **HTTP/2 and compression (brotli or gzip) at the proxy are required.** Live sync keeps several requests open at once,
  and a browser allows only six HTTP/1.1 connections per origin ([ADR 0001](adr/0001-sync-engine.md), consequence 4).
  The proxy must not buffer responses and must let a request stay open for a long time: live sync uses long polling.
- Only the proxy is reachable from outside. PostgreSQL, the sync service and the storage console stay on a private network.

## 5. Backups

- A nightly `pg_dump --format=custom` of the Torch database, or the provider's snapshots, stored somewhere other than the
  database host. Add WAL archiving if you need to restore to a point in time.
- **The replication slot keeps WAL while the sync service is stopped.** The sync service creates a slot
  (`electric_slot_default` unless you changed it) and PostgreSQL holds on to every log segment that slot has not read. A
  sync service that stays down for days fills the disk. Watch the disk, and how much WAL the slot holds:
  `select slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as wal_held from pg_replication_slots`.
  When you decommission an instance, drop the slot
  (`select pg_drop_replication_slot('electric_slot_default')`) and the publication
  (`drop publication electric_publication_default`), or the slot keeps holding WAL on a database you still run.
- **Restore drill**, once before you rely on the backups and after a major change: restore the latest dump into a scratch
  database (`pg_restore --dbname <scratch> --no-owner <file>`), start a throw-away instance against it with its own sync
  service, open `/health`, `/health/db` and `/health/sync`, sign in, and open a few issues. Then delete the scratch
  instance and its slot. A backup that was never restored is a guess.

## 6. Health checks

The three endpoints need no sign-in and never include a connection string, a host name, a password or the sync secret in
an answer; the detail of a failure goes to the server log.

| Endpoint | Answers | When it is not 200 |
|---|---|---|
| `GET /health` | `{"status":"ok"}`: the Torch process is up. It checks no dependency, so it suits a liveness probe. | The process is down. |
| `GET /health/db` | `{"status":"ok","walLevel":"logical","replication":true}` | 503 with `{"status":"error","reason":"..."}`. See below. |
| `GET /health/sync` | `{"status":"ok"}`, or `{"status":"disabled"}` when `ELECTRIC_URL` is empty (sync is off). | 503 with a reason. See below. |

`/health/db` reasons and fixes:

- `DATABASE_URL is not set`: set it.
- `cannot reach the database`: check the address, the credentials and the network; the server log has the driver's message.
- `wal_level is "replica"`: run `ALTER SYSTEM SET wal_level = logical`, then restart PostgreSQL (a reload is not enough),
  or set the provider's parameter (section 1).
- `role "<name>" lacks the REPLICATION privilege ...`: run `ALTER ROLE <name> WITH REPLICATION` (on Amazon RDS and
  Aurora, `GRANT rds_replication TO <name>`), or point the sync service at a role that has it.

`/health/sync` asks the sync service for its state and gives up after 2 seconds. Reasons and fixes:

- `sync service is not replicating yet (starting)`: normal for a few seconds after a start. If it lasts, read the sync
  service's log.
- `sync service is not replicating yet (waiting)`: usually it has not got the replication slot, or cannot reach PostgreSQL. Check
  `/health/db` first, then that no second sync service uses the same slot.
- `sync service is unreachable`, `sync service did not answer within 2 seconds`, `sync service answered HTTP <code>`:
  `ELECTRIC_URL` is wrong, or the service is down or overloaded.

Use `/health` for liveness and both of the others for readiness. They are cheap, but they are not a monitor: alert on the
WAL the replication slot holds and on the disk as well (section 5).

## 7. A dedicated instance for one organisation

Torch is white label: one instance per deployer, with its own database, brand file (`BRAND_CONFIG_PATH`) and domain.
Nothing is shared between instances. A system that calls the Torch API from outside, such as an internal tool or another
company's platform, needs from the operator:

- the base URL of the instance (`APP_URL`) and a certificate that is valid for that name (TLS is not optional);
- a token for the API: the REST API and its tokens are planned, so there is nothing to hand out yet;
- the health endpoints, reachable from where the system runs, to know whether the instance is ready;
- the backups of section 5, with a restore that has been tried.

## 8. Attachment storage

Attachments go to S3-compatible object storage, straight from the browser: the Torch server presigns each upload and
signs each download, and never carries the file. Without `S3_ENDPOINT` the server starts with attachments off (it logs
`attachments are off`) and the attachment calls answer 503 `storage_unavailable`.

- **Variables:** `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (all four, or the server
  refuses to start and names the missing one); optional `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_ENDPOINT` and
  `ATTACHMENT_MAX_BYTES`. See [`.env.example`](../.env.example).
- **The bucket is private.** Nothing in it is ever served without a signed URL; do not enable public reads or a website
  endpoint. Use a key that can read, write and delete in that bucket only.
- **The browser must reach the storage.** Uploads and downloads go from the browser to the storage address. When the
  storage sits on a private network, publish it under its own name behind the proxy and set `S3_PUBLIC_ENDPOINT` to that
  address (with TLS): signed requests are valid for the host they were signed for.
- **Run `pnpm --filter @torch/server storage:setup` once.** It creates the bucket when it is missing and applies the CORS
  rules for `APP_URL` (POST, PUT, GET and HEAD from that origin, nobody else). It is safe to run again. A managed service
  that does not accept CORS through the API needs the same rule set in its console: the one origin of `APP_URL`, methods
  POST, PUT, GET and HEAD, any header.
- **Lifecycle:** uploads that were started and never finished leave a row the server deletes after 24 hours, together with
  any object. Also add a rule to the bucket that aborts incomplete multipart uploads after one day.
- **Back up the bucket** with the database: a restored database whose files are gone shows attachments that cannot be
  opened. Use the provider's versioning or replication, or copy the bucket on the schedule of the database dump.
- **Limits:** 25 MiB per file, 50 files per issue, a fixed list of types (images, PDF, text, CSV, Markdown, JSON, zip and
  Office files). SVG and HTML are never accepted.

