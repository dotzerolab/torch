# ADR 0001: Sync engine = ElectricSQL + TanStack DB

Date: 2026-11-14 · Status: accepted after reading both spike results · Design: [`docs/design.md`](../design.md) §14, §15

## Context

The design asks for a Linear-like feel: local reads, optimistic writes, real-time fan-out, permission-filtered partial
sync, a persistent cache and an offline write queue (§14), on one small VPS per instance (§15). Two spikes measured
Rocicorp Zero 1.12.0 and ElectricSQL 1.8.1 + TanStack DB 1.0.0-rc against the same seed, screen and six measurements, on an Apple MacBook Pro (Apple Silicon). The spike reports are
kept by the maintainers; the numbers that matter are in this record.

Both passed speed, cross-window latency, cold start and guest isolation with wide margins. The differences:

| | Zero | Electric + TanStack DB |
|---|---|---|
| Offline writes | only while the tab stays open, with a 24 h disconnect timeout the docs advise against; lost on reload | IndexedDB outbox, sent on reconnect (passes §14) |
| Permission revocation (reads) | 223 ms, incremental | 17-37 s, full shape refetch (fixable, below) |
| Sync service footprint | 1.2-2.2 GB RAM, ~2 min restart | ~315 MB RAM, quick restart |
| Write path | shared mutators, little code | our own endpoint per mutation |
| Licences outside the allow-list | 7 transitive packages | 1 (`fractional-indexing`, CC0-1.0) |
| Maturity | 1.x GA since 2026-03 | sync service 1.8 stable; TanStack DB still 1.0 rc |
| Estimated sync foundation effort | ~1-1.5 weeks | ~3 weeks |

## Decision

Use ElectricSQL (sync service) for reads and TanStack DB (with its Electric collection, SQLite/OPFS persistence and
offline-transactions outbox) on the client. The browser talks only to our server, which proxies Electric shape
requests and adds the permission filter; Electric is never exposed directly.

Why: it meets the §14 offline bar, fits the one-VPS-per-instance footprint, and its hand-written write endpoints are
the same endpoints the public REST API (§11), the MCP server (§8) and the assistant (§9) need anyway, so the extra
effort is largely work we would do regardless.

## Consequences (binding on the P0 follow-up and P1 plans)

1. **Write path:** one endpoint per mutation in `apps/server`, shared with REST and MCP: permission check, update and
   `pg_current_xact_id()` in one transaction; client waits for the txid (`awaitTxId`); 4xx = non-retriable rollback
   with a message, network error = retry with backoff. `awaitTxId` is not a durability signal.
2. **Revocation:** subscribe one shape per visible team (static `where team_id = $1`), not one shape whose `where`
   lists the member's teams, so losing a team drops one shape instead of refetching everything. P1 test: revoked
   rows leave the device within 2 s.
3. **Schema:** every synced table carries `workspace_id` and a denormalised `team_id` (Electric `where` clauses cannot
   join).
4. **Payload:** large text (issue descriptions, comment bodies, documents) is not in list shapes; it syncs per opened
   object or through a separate shape. Compression (brotli/gzip) and HTTP/2 at the edge are required in deploy (P8).
5. **Post-cold-sync lag:** the spike saw remote edits lag 5-11 s while the first snapshot was written to OPFS; P1 must
   render from memory first and persist in the background without queueing live changes behind the snapshot write
   (test: first remote edit after a cold load visible in under 1 s).
6. **Multi-tab and schema versions:** use TanStack DB's browser collection coordinator; a schema version bump resets
   the local store cleanly. Both get tests in P1.
7. **Versions:** pin exact versions; move TanStack DB from 1.0 rc to 1.0 final when it ships, in its own commit.
8. **Licence:** `fractional-indexing` (CC0-1.0, public-domain dedication, transitive via `@tanstack/db`) is approved
   for `config/license-exceptions.json` when the dependency is added.
9. Electric needs a password in `DATABASE_URL` even with trust auth (boot crash otherwise); the shape proxy drops
   `content-encoding` and `content-length` when relaying.

*Note, 2026-11-16:* the offline outbox of the decision is an in-house queue (`apps/web/src/sync/outbox.ts`), not
`@tanstack/offline-transactions`. It keeps the contract: writes are stored on the device, sent in order with an
`Idempotency-Key`, and survive a reload. The package's peer dependencies did not fit the pinned TanStack DB version, so
it is not a dependency.

Rejected: Zero. Fastest to build and best revocation, but offline writes do not survive a reload, the sync service
needs 1-2 GB and ~2 minutes to restart on every deploy, and seven licence exceptions. Revisit only if Electric's
revocation or write-path cost proves unworkable in P1.
