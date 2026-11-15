# ADR 0002: Database portability (can Torch run on MySQL?)

Date: 2026-11-15 · Status: Accepted · Builds on: [ADR 0001](0001-sync-engine.md) · Design: [`docs/design.md`](../design.md) §15

## Context

Some people who want to self-host Torch can only get a MySQL database. The question is whether Torch should also run
on MySQL. Postgres is today both the source of truth (design §15) and the input of the sync engine chosen in ADR 0001:
Electric replicates by reading the Postgres write-ahead log, so a database without that log gives it nothing to read.
This record therefore looks at two halves: the **application database** (Drizzle schema, queries, tests) and the
**sync source**. Evidence is the code at commit `5270eb3` and the official documentation listed under Sources. Effort
figures are estimates for one engineer who knows the code, not measurements.

## Where Torch depends on Postgres today

| Dependency | Where | MySQL equivalent or blocker |
|---|---|---|
| Sync source: Electric reads the WAL (`wal_level=logical`, `REPLICATION` role, direct connection, Postgres 14+) | `docker-compose.dev.yml`, `apps/server/src/db.ts` (`interpretWalLevel`), `.github/workflows/ci.yml` | **Blocker.** Electric's documentation describes Postgres only; no MySQL source is documented or announced. The MySQL binlog is a different protocol. |
| Shape `where` clauses in Postgres SQL with `$n`; `pg_current_xact_id()::xid::text` for `awaitTxId` | `sync/shapes.ts`, `sync/routes.ts`, `mutations/txid.ts`, `apps/web/src/sync/collections.ts` | **Blocker** with Electric. Another engine brings its own filter language and its own write-confirmation signal. |
| Column types: `uuid` + `gen_random_uuid()`, 3 `pgEnum`, `timestamptz`, `jsonb` | `packages/shared/src/db/schema.ts` | `CHAR(36)` or `BINARY(16)`, inline `ENUM`, `DATETIME(6)` kept in UTC (`TIMESTAMP` is time-zone converted and ends 2038-01-19), `JSON` with an expression default. Drizzle has no cross-dialect schema: a second `mysql-core` file. |
| `text` columns under unique or plain indexes (`email`, `slug`, `key`, `handle`, `token_hash`) | same file | MySQL needs a prefix length on `TEXT` keys: switch to `VARCHAR(n)` with chosen limits. |
| Partial unique index `invite_pending_email_unique` | `schema.ts`, `migrations/0000_core_schema.sql` | No partial indexes. A generated column that is NULL unless the invite is pending, with a unique index on it (unique indexes allow several NULLs), keeps the rule. |
| `CHECK` with `~` regex and `btrim`; index on `created_at DESC NULLS FIRST` | `schema.ts` | `REGEXP`, `TRIM`; MySQL 8.4 enforces `CHECK` and has `DESC`, but no `NULLS FIRST` (harmless, the column is NOT NULL). |
| Row locks: 12 `.for()` calls (5 `no key update`, 4 `update`, 3 `share`) | `teams/`, `members/`, `invites/service.ts`, `issues/update-issue.ts`, `auth/magic-link.ts` | MySQL has `FOR UPDATE` and `FOR SHARE`, no `NO KEY UPDATE`. InnoDB foreign-key checks take shared record locks, so the lock order that keeps the admin services deadlock-free has to be re-derived and re-tested. |
| Advisory lock `pg_advisory_xact_lock(hashtext(email))` | `auth/magic-link.ts:26` | `GET_LOCK()` is not released at commit or rollback; lock a row instead. |
| `RETURNING` (19 call sites) and `ON CONFLICT DO NOTHING` | `auth/`, `members/`, `invites/`, `teams/`, `db/seed.ts`, `cli/bootstrap.ts` | No `RETURNING` in MySQL. Drizzle's `$returningId()` gives inserted ids only; `update … returning` (consuming a sign-in link, touching a session) becomes lock, update, select. `INSERT IGNORE` or `ON DUPLICATE KEY UPDATE` replaces `ON CONFLICT`. |
| Raw SQL, 11 sites: `count(...)::int`, `interval` maths with `least`, `clock_timestamp()`, `bool_or`, `current_setting` | `auth/sessions.ts:122`, `issues/update-issue.ts:114`, `members/`, `invites/`, `teams/service.ts:293`, `db.ts:80` | Each has a MySQL form. None is hard; all need tests to find. |
| Error handling: SQLSTATE `23505` plus constraint name | `util/pg-error.ts`, `test/fixtures.ts` | MySQL reports errno 1062 (SQLSTATE 23000) and names the key only inside the message text. |
| Driver, pool, migrations | `db.ts` (`pg`, `NodePgDatabase` inside the `Orm` type every service takes), `db/migrate.ts`, `drizzle.config.ts` (`dialect: 'postgresql'`), `migrations/` | `mysql2`, a second migrations folder, and an `Orm` type that stops naming one driver. |
| Test harness and CI | `test/fixtures.ts` (create and force-drop a database, `pg_stat_activity`), `test/lock-races.test.ts` (plpgsql trigger, `pg_sleep`), `apps/web/e2e/global-setup.ts` (`update … from`, `\|\|`), `ci.yml`; 28 test files read `DATABASE_URL` | Rewrite helpers, race tests and e2e setup; CI runs everything twice. |
| Planned, not built: search (full-text + trigram), jobs on Postgres, nightly Postgres dump | `docs/design.md` §15 | Each needs a MySQL design or a Postgres-only carve-out. |

The ORM layer is a large but ordinary port. The sync source is the real wall: nothing in the first two rows has a
drop-in MySQL answer.

## Options

**(a) Stay Postgres-only and document it.** Effort S, risk low.
- Pro: no code change; ADR 0001 stays intact; one test matrix; planned features (search, job queue, outbox) may use
  Postgres freely; matches the README promise of "a Postgres you own".
- Con: leaves out anyone who can only have MySQL; a contributor who wants MySQL has no supported path.

**(b) Dual dialect through Drizzle, sync layer kept Postgres-only.** Effort L (about 5-8 weeks for the server, tests
and CI on MySQL 8.4), risk high.
- It does not hold together as stated. With the application database on MySQL, Electric has nothing to read, so
  "sync stays on Postgres" means one of two things: (i) MySQL installs run without live sync and the client gets a
  second data path (polling or query collections), which is a different product mode; or (ii) a Postgres replica fed
  from the MySQL binlog by a change-capture tool exists only for Electric, which needs Postgres anyway and breaks the
  txid handshake (the id of the write is no longer the id Electric reports).
- Pro: serves REST and API use on MySQL; stays inside Drizzle.
- Con: every row of the table above; two dialects to keep equal for good. The schema's tenant isolation rests on
  composite foreign keys and lock ordering (see the header of `schema.ts`), exactly the parts that differ between
  engines, so drift weakens a security property, not only a feature.

**(c) A sync engine that supports MySQL.** Effort L (largest of the four, over 3 months with the server port of (b),
which it still needs), risk very high.
- PowerSync reads the MySQL binlog (MySQL 5.7+, `binlog_format=ROW`, `binlog_row_image=FULL`, GTIDs on) but labels its
  MySQL support **Beta**, its TanStack DB collection is **Alpha**, and its service keeps bucket storage in **MongoDB or
  Postgres**, a database separate from the source. A MySQL-only deployer would still run a second database. The
  service licence moved from FSL to Apache-2.0 on 2026-11-03.
- Building our own change feed from the binlog (a capture tool such as Debezium needs the binlog enabled) means
  writing the sync protocol, permission-filtered partial sync, revocation and the offline outbox: the work ADR 0001
  chose not to do.
- Zero is Postgres-only and already rejected.
- Against ADR 0001: it reopens the decision, replaces consequences 1, 2, 5, 6 and 9 (write path, per-team shapes,
  cold-sync lag, multi-tab store, Electric specifics) and discards the sync foundation already built. No spike data
  exists for it on the six measurements of ADR 0001; one would be needed first.

**(d) Other realistic paths.** Effort S, risk low to medium.
- (d1) Postgres beside or instead of the MySQL host. Torch is a Node server plus a long-running Electric service plus
  object storage and SMTP (ADR 0001, about 315 MB for Electric). A host that can run those can run Postgres in the same
  Compose file, and one that cannot run them cannot run Torch on either database. Alternatively point `DATABASE_URL`
  at a managed Postgres from the providers Electric lists (Supabase, Neon, AWS RDS and Aurora, Google Cloud SQL and
  AlloyDB, DigitalOcean, Crunchy), with logical replication on, a `REPLICATION` role and a direct, non-pooled
  connection. Deliverables: a deploy page with these requirements, and a health check that also reports a missing
  `REPLICATION` privilege (today it checks `wal_level` only).
- (d2) An out-of-tree MySQL port by a contributor, allowed by Apache-2.0 and not supported by the maintainers. It
  carries (b) without making it a maintainer cost.

## Decision

Choose (a) with (d1): Torch stays Postgres-only, and the deploy documentation says so, says why, and shows how a
MySQL-only host gets Postgres (same Compose file, or a managed provider). (d2) is welcome as an out-of-tree project,
with no support from the maintainers.

Why: the obstacle is the sync source, not the ORM, and every route around it adds a second database, a Beta or Alpha
dependency, or a second product mode. Dual dialect would double the test surface of a schema whose isolation depends
on engine-specific locking. The people it would serve are, on the evidence, a small group: hosts that can run Electric
can run Postgres.

## Consequences

1. README and deploy docs state "PostgreSQL 14 or newer with logical replication" as a requirement, with the managed
   providers and settings above. No code change is needed for this record.
2. Keep Postgres-specific SQL where it is now (11 raw SQL sites, `util/pg-error.ts`, `mutations/txid.ts`, `db.ts`); do
   not build a portability layer speculatively.
3. New Postgres-only features (search, job queue, outbox) are allowed without a dialect review.

## Conditions that would change this (any one reopens it)

1. Electric, or another engine that meets the ADR 0001 bar (offline writes that survive a reload, per-team partial
   sync, small footprint, permissive licences), documents a stable MySQL source and needs no second database.
2. PowerSync's MySQL support leaves Beta, its TanStack DB collection leaves Alpha, bucket storage no longer needs
   MongoDB or Postgres, and a spike on the six ADR 0001 measurements passes.
3. A group of independent deployers (suggested: at least five) confirms that a MySQL database is all they have **and**
   that they can run containers, and a contributor commits to maintaining a MySQL dialect with its own CI job.
4. The change of ownership Electric announced on 2026-08-11 (it is joining Neon at Databricks) alters its licence
   or its Postgres focus. That reopens ADR 0001 first, and this record with it.

## Answers recorded with the decision

1. The deployers asking for MySQL can run containers, so (d1) with Postgres in the same Compose file serves them.
2. A "no live sync" mode is not acceptable: live sync is a core property of Torch, so (b)(i) is out of scope.
3. An out-of-tree MySQL port (d2) is welcome and unsupported: it lives outside this repository and its issue tracker.

## Sources (read 2026-11-15)

- Electric deployment requirements: <https://electric.ax/docs/guides/deployment> (moved from electric-sql.com); product
  and ownership announcement: <https://electric.ax/>
- Drizzle, MySQL insert (`$returningId`, `ON DUPLICATE KEY UPDATE`): <https://orm.drizzle.team/docs/mysql/insert>;
  MySQL driver: <https://orm.drizzle.team/docs/get-started-mysql>
- PowerSync source databases (MySQL Beta, binlog settings): <https://docs.powersync.com/installation/database-setup>;
  service storage: <https://docs.powersync.com/architecture/powersync-service>; licence change:
  <https://powersync.com/blog/moving-the-powersync-service-to-apache>; TanStack DB collection (Alpha):
  <https://docs.powersync.com/client-sdks/frameworks/tanstack>
- Debezium MySQL connector (binlog required): <https://debezium.io/documentation/reference/stable/connectors/mysql.html>
- MySQL 8.4 manual: [CREATE INDEX](https://dev.mysql.com/doc/refman/8.4/en/create-index.html) (no partial indexes,
  prefix length on `TEXT`), [CHECK constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html),
  [default values](https://dev.mysql.com/doc/refman/8.4/en/data-type-defaults.html) (JSON needs an expression default),
  [locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html),
  [locks set by statements](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html) (foreign-key checks take
  shared locks), [`GET_LOCK()`](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html),
  [`TIMESTAMP` and `DATETIME`](https://dev.mysql.com/doc/refman/8.4/en/datetime.html)
