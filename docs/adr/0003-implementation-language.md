# ADR 0003: Implementation language (stay on TypeScript, or rewrite in Rust?)

Date: 2026-11-15 · Status: Accepted · Builds on: [ADR 0001](0001-sync-engine.md), [ADR 0002](0002-database-portability.md) · Design: [`docs/design.md`](../design.md) §15

## Context

Design §15 fixed the stack as TypeScript with a local sync engine, before any code existed. Rust is the usual
challenger for a server like this, so the question is whether it brings advantages that pay for a rewrite. This record
weighs four options against eight criteria. Evidence is the code at commit `390c1af`, measurements taken on
2026-11-15, and the official documentation listed under Sources. Effort figures are estimates for one engineer who
knows the code, not measurements. **The Rust side was not measured**: no Rust toolchain was installed for this record,
so every Rust figure below is cited from documentation or reasoned from the TypeScript measurements, and says so.

## What exists today (commit `390c1af`)

| Part | Source lines (files) | Test lines (files) |
|---|---|---|
| `apps/server` (Node, Hono, Drizzle) | 4,422 (39) | 12,244 (42) |
| `apps/web` (React, Vite; plus 1,087 lines of CSS) | 2,309 (44) | 1,284 (17) |
| `packages/shared` (schema, permissions, validation, i18n, brand) | 939 (10) | 1,103 (7) |
| End-to-end specs (`apps/web/e2e`) | - | 579 (12 files, 21 specs) |

About 7,700 source lines and 15,200 test lines; one `vitest run` has 1,449 cases (980 server, 264 shared, 132 web, 73 in
`scripts/`; 10 server cases failed in my local run, in 4 files, not investigated, while CI on `main` passes) and takes
93 s with 2 workers. Phases P1c-P8 are not built, so the web app (2,309 lines) is a small part of what it will become.
CI takes 155-180 s per run on GitHub Actions (recent runs on `main` and the ADR 0002 branch).

## Measurements (Node server)

Setup: the `esbuild` bundle that `pnpm build` makes, Node 26.3 on an Apple Silicon laptop; Postgres 17 and Electric
1.8.1 in Docker on the same machine; 4,000 seeded issues; the load generator on the same machine, 16 keep-alive
connections unless noted. The database was shared with other test runs, so read the numbers as proportions, not as
capacity. macOS figures; they are to be repeated on Linux in P8.

| Scenario | req/s | p50 | p99 | Node CPU per request |
|---|---|---|---|---|
| `GET /health` (no database) | 15,330 | 0.8 ms | 4.0 ms | 0.04 ms |
| `GET /health/db` (one query) | 6,990 | 1.5 ms | 11.6 ms | 0.07 ms |
| `GET /api/auth/session` (cookie, database read and write) | 1,265 | 10.9 ms | 40 ms | 0.5 ms |
| `PATCH` one issue (auth, zod, transaction, txid), 16 connections | 681 | 21.7 ms | 59 ms | 0.7 ms |
| same, 1 connection | 164 | 5.6 ms | 14.4 ms | 1.3 ms |
| Shape snapshot of 2,000 issues (1.17 MB), straight from Electric, 4 connections | 67-79 | 49.8-53.4 ms | - | - |
| same snapshot through the Node proxy | 65-71 (57 cold) | 53.3-57.0 ms (63 cold) | - | 8.5 ms |

| Process | Resident memory (MiB) |
|---|---|
| Node 26 alone, idle | 51 |
| Torch server, idle after start (heap 14 MiB) | 97 |
| Torch server, idle again after about 46,000 requests | 103 |
| Torch server, under load (database requests; shape relays) | 147-162; peak 183 |
| Electric 1.8.1 (fresh; after serving snapshots; the dev stack's, up for a day) | 292; 275-289; 368-373 (ADR 0001: about 315 MB) |
| Postgres 17 (dev container, which also hosts other test databases, so high) | 322-359 |

## Findings per criterion

1. **Footprint.** Electric stays an Elixir service in every option, and Postgres stays Postgres, so a Rust server only
   replaces the 97-183 MiB Node process: 14-20% of the stack's roughly 710-910 MiB even if it used no memory at all.
   Assuming a Rust service with a connection pool idles at 20-40 MiB (an assumption, not measured), the saving is about
   60-75 MiB idle (8-11% of the stack) and up to about 145 MiB under load (16%): under 2% of the 8 GB of the sizing
   target (§15). Image sizes do not change the picture: Postgres and Electric are 696 MB and 269 MB of images; a Rust
   image would save tens of MB on a total near 1 GB (not measured).
2. **Latency and throughput.** On the write path, Node spends 0.7-1.3 ms of CPU per request; by subtraction (not
   profiled) the rest of the 5.6 ms median is the database round trips of one transaction, its commit and the loopback
   hop, and a Rust server would issue the same queries. The best case is about 1 ms saved on 5.6 ms, before a network
   round trip of 10-100 ms to a VPS, and the web app applies the write locally first (§14: under 100 ms from local
   data). 681 writes/s at 16 connections is above what 200 interactive sessions produce even at one write per second
   each, on a laptop shared with a test run. The Node proxy adds about 3.5 ms (and 8.5 ms of CPU) to a 1.17 MB snapshot
   that a device downloads once per team; live updates are small. Time goes to Postgres, Electric and the network,
   none of which a language change touches.
3. **Sync engine fit.** The client side of ADR 0001 is TypeScript: `@electric-sql/client` and TanStack DB (React
   bindings; its live-query engine is a TypeScript differential-dataflow implementation, with no Rust or WASM binding
   in its docs). (b) leaves the client alone: the Rust server only proxies shape requests, runs the mutation
   endpoints and returns `pg_current_xact_id()` for `awaitTxId`, plain HTTP and SQL. (c) loses TanStack DB. Electric's
   HTTP protocol is language-neutral and its client guide shows a happy-path client in about 150 lines, but syncing
   into a local database is outside the guide, and live queries, optimistic transactions, the offline outbox and
   multi-tab coordination are what TanStack DB provides; ADR 0001 estimated about 3 weeks for the sync foundation
   *with* it. No Rust local-first engine meets the
   ADR 0001 bar (offline writes that survive a reload, per-team partial sync, small footprint, permissive licences,
   Postgres we own): PowerSync lists a Rust client SDK as Beta and its service needs a second database (ADR 0002);
   Automerge's Rust core is a CRDT library with no server-authoritative, permission-filtered partial sync of Postgres
   rows documented; Zero is TypeScript and was rejected.
4. **Shared code.** Today `packages/shared` is imported by the web for i18n (11 imports), brand (6), the issue-update
   schema (3) and contrast maths (2); permissions are applied by the server for every decision and by the web only to
   hide actions the server would refuse. `shapes.ts` already repeats `canSeeTeam` in SQL, pinned by tests. In (b) the
   rules must live twice or cross a seam: codegen gives types only (`ts-rs` generates declarations, not validators),
   so behaviour needs either duplication with shared test vectors, or Rust compiled to WASM and loaded by the web
   (async start-up, a build step, error messages through the i18n catalogue). (c) is the one option where rules, types
   and validation are written once and used natively on both sides; that is its real advantage.
5. **MCP, email, auth, i18n, licences.** Parity, not advantage. The official Rust MCP SDK (`rmcp` 3.10.0, Apache-2.0,
   updated 2026-11-12) is Tier 1 like the TypeScript one, with Streamable HTTP as a Tower service, OAuth, client and
   server. Email: `lettre` 0.11 (MIT) for SMTP. SSO: `openidconnect` 4.1 (MIT). i18n: our own `t()` is 54 lines
   plus 7.7 KB of JSON catalogues, trivial to port. Licence gate: `cargo-deny` checks licences, advisories, bans and
   sources, replacing `scripts/check-licenses.ts` with a `deny.toml` and adding a second tool in CI.
6. **Security and correctness.** Both languages are memory-safe here, so Rust adds no protection against the bug
   classes that matter for Torch: tenant isolation rests on composite foreign keys and lock order (§16, ADR 0002), which
   live in the database, and permission mistakes are logic errors. What Rust does add: `sqlx::query!` checks raw SQL
   against the schema at build time (TypeScript has 11 unchecked raw-SQL sites, ADR 0002), exhaustive `match` and `Result`
   instead of discipline, and `serde` rejecting unknown fields where we use `z.strictObject`. TypeScript already covers
   much of this with strict mode, discriminated unions and zod at the boundary. Cost: sqlx needs a live database or
   cached query data at build time; panics need a catch layer; Axum is 0.8.9 and SeaORM 2.0.4, as Drizzle is 0.45
   and Hono 4.13 on our side.
7. **Deploy, CI, contributors, speed.** For: one static binary per target. Against: two architectures to build for
   self-hosters, and Rust's own survey (2025, over 3,700 answers) puts incremental rebuilds first among complaints, 55%
   waiting more than 10 s, about 25% of CI users calling CI build time a major blocker, and about 45% of former users
   citing compile times. Our full CI is 155-180 s today. Contributors: in the 2025 Stack Overflow survey 43.6% of
   respondents used TypeScript and 14.8% Rust (professionals: 48.8% and 14.5%), and a public project lives on how many
   people can send a patch. The `pnpm dev` loop (`node --watch`, Vite) has no compile step.
8. **Rewrite cost and opportunity cost.** See the options; every phase after a switch is also written in the new
   language, and until the switch finishes the roadmap (P1c-P8, with "nobody uses Torch before v1") does not advance.

## Options

**(a) Stay on TypeScript.** Effort S (no rewrite), risk low.
- Pro: no new cost; ADR 0001's client stack and the whole test base stay valid; the largest contributor pool;
  the measurements show no pressure from the server (criteria 1-2); rules already shared with the web.
- Con: idle footprint about 60-75 MiB above a hypothetical Rust server; raw SQL unchecked at build time; runtime
  validation needed at the HTTP edge (zod); the image carries a Node runtime.

**(b) Rust server (Axum with sqlx or SeaORM), React/TypeScript client kept.** Effort L, about 8-12 weeks (estimate):
roughly 5,400 source lines and 13,300 test lines (1,250 cases) to port, plus the seam for shared rules, CI and image.
Risk medium-high.
- Pro: smaller server process (criterion 1, bounded at 14-20% of the stack); build-time SQL checks; one static binary.
- Con: no user-visible speed gain (criterion 2); rules duplicated or compiled to WASM (criterion 4); the delicate code
  (auth, permissions, lock order, isolation) is re-derived and re-reviewed (§16); a second toolchain in CI and dev;
  server work for P1c-P8 stalls or is written twice during the port; the web contributors cannot touch the server.

**(c) Full Rust including the web client (Leptos or Dioxus compiled to WASM).** Effort XL, about 6-9 months (estimate),
risk very high.
- Pro: one language and one set of rules everywhere; no generated contracts; WASM sharing solved natively.
- Con: all of (b), plus a client rewrite where the UI of P1f-P8 is still unwritten; TanStack DB, the Electric client,
  the Radix primitives and the Markdown editor with slash commands and mentions have no Rust equivalent, so the sync
  foundation of ADR 0001 is rebuilt; Leptos says its APIs are "basically settled" and warns that bugs remain, Dioxus
  lists 0.7 as its stable version and notes apps can only be written in Rust; WASM size is a budget to manage (the
  Leptos book lists size profiles, compression and code splitting released in 2025); today's web bundle is 803 kB
  (245 kB gzip) and builds in 0.5 s.

**(d) Rust only for isolated parts.** Effort S-M per component, risk low, each decided on a measured trigger.
- Candidates and verdict today: import worker (P5) is bound by Linear's API and Postgres, not CPU; search (P1g) runs
  inside Postgres; webhook and outbox dispatch (P6) is I/O bound; the local companion (§7, an npm stdio MCP server)
  could become a Rust binary if people without Node are a real group; a Tauri desktop shell (Rust core, system
  WebView, under 600 KB per Tauri's docs) wraps the same web app and is a product decision after v1.
- Pro: Rust where it wins, with no rewrite; the HTTP contract (mutation endpoints, shape proxy, planned REST API) is
  the seam.
- Con: a second toolchain for one component; none of the candidates is CPU-bound today.

## Decision

Choose (a): stay on TypeScript. Keep (d) as an option to exercise per component when a trigger below fires.

Why: the measured server cost is small next to Postgres and Electric (criteria 1-2), so Rust would save at most 14-20%
of the memory of a stack, probably 8-16%, and no latency a user can see; the sync stack of ADR 0001 is TypeScript on
the client, which (c) would throw away and (b) leaves in place; and (b) and (c) spend months in which no roadmap phase
advances, on a part of the system that is not the constraint. Rust's real gains (build-time SQL checks, one binary, and
in (c) one language for shared rules) do not outweigh that cost today.

## Consequences

1. No code change. `docs/design.md` §15 stays as written.
2. Keep the seams that make a later partial move cheap: the HTTP contract (one endpoint per mutation, the shape proxy,
   the planned REST API) stays framework-neutral; `packages/shared` rules keep importing nothing from Node, and
   permission tests stay table-driven so the same cases could drive a port.
3. Re-measure idle and loaded memory and the write path on Linux with the production image in P8, against the sizing
   target (200 sessions, 100,000 issues, 4 vCPU and 8 GB), and record the numbers next to this record.
4. Keep raw SQL in few, named places (11 today) so build-time checking can be added later, in TypeScript or Rust.
5. Machine sizes for a self-hosted instance: minimum 2 vCPU and 2 GB of memory (a small team), recommended 2 vCPU and
   4 GB, large 4 vCPU and 8 GB (the sizing target). 1 GB is not supported: the stack alone needs 700-900 MiB, plus the
   operating system and the container runtime. The P8 measurement includes a load test on a 2 GB machine, and the
   deploy documentation lists these sizes.
6. A desktop application is planned after v1. It is the first candidate for (d): a Tauri shell (Rust core, system
   WebView) around the same web app. That choice gets its own record when the work starts.

## Conditions that would change this (any one reopens it)

1. Profiling on the sizing target shows the Node server, not Postgres or Electric, as the limit: for example its CPU
   above 50% of a vCPU at the 95th-percentile load, or its memory above 400 MiB.
2. A Rust-native sync engine with a browser client meets the ADR 0001 bar and reaches a stable release, or TanStack DB
   stops being maintained. That reopens ADR 0001 first.
3. Evidence shows the local companion loses users because it needs Node: (d) for that component.
4. A profiled hot path (import, search indexing) is CPU-bound and over its budget on target hardware: (d) for that path.
5. A group of maintainers with Rust experience commits to keeping a Rust component alive, with its own CI job.
6. The ownership change announced for Electric (ADR 0002, condition 4) alters its licence or its Postgres focus.
7. A machine size below 2 GB becomes a requirement: the Node saving would then matter.

## Answers recorded with the decision

1. A desktop application is wanted after v1 (consequence 6).
2. There is no 1 GB ceiling: the minimum machine is 2 GB, the recommended one 4 GB (consequence 5). At 2 GB the Node
   saving is about 5% of the machine, which does not change the decision.

## Sources (read 2026-11-15)

- MCP SDK tiers and the Rust SDK: <https://modelcontextprotocol.io/docs/sdk>, <https://github.com/modelcontextprotocol/rust-sdk>,
  <https://crates.io/crates/rmcp>
- TanStack DB overview: <https://tanstack.com/db/latest/docs/overview>
- Electric HTTP API and client guide: <https://electric.ax/docs/api/http>, <https://electric.ax/docs/guides/client-development>
- PowerSync client SDKs: <https://docs.powersync.com/client-sdks/overview>; Automerge: <https://automerge.org/docs/hello/>
- Leptos: <https://github.com/leptos-rs/leptos>, <https://book.leptos.dev/deployment/binary_size.html>; Dioxus:
  <https://dioxuslabs.com/learn/0.7/>; Tauri: <https://v2.tauri.app/start/>
- Axum: <https://docs.rs/axum/latest/axum/>; sqlx: <https://github.com/launchbadge/sqlx>; SeaORM:
  <https://crates.io/crates/sea-orm>; `lettre`: <https://crates.io/crates/lettre>; `openidconnect`:
  <https://crates.io/crates/openidconnect>; `ts-rs`: <https://github.com/Aleph-Alpha/ts-rs>; `cargo-deny`:
  <https://embarkstudios.github.io/cargo-deny/>
- Stack Overflow Developer Survey 2025, technology: <https://survey.stackoverflow.co/2025/technology>
- Rust compiler performance survey 2025: <https://blog.rust-lang.org/2025/09/10/rust-compiler-performance-survey-2025-results>
