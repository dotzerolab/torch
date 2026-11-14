# Contributing to Torch

Thank you for helping. Torch is pre-v1 and moves fast, so a short conversation before a big change saves everyone
time: open an issue that says what you want to change and why, then send the pull request.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Found a vulnerability? Do not open an
issue: follow [SECURITY.md](SECURITY.md).

## Licensing of contributions

Torch is licensed under the [Apache License 2.0](LICENSE). As Section 5 of that licence says, any contribution you
intentionally submit for inclusion in Torch is licensed under the same terms, with no additional terms or conditions.
Inbound is outbound: there is no separate contributor agreement and no sign-off to add. Only submit work you have the
right to license this way.

Two rules keep the licence clean:

- **Ideas only from copyleft projects.** Learning from the UX or the data model of other trackers (including AGPL,
  GPL or EPL ones) is fine. Copying their code, schema files or assets is not.
- **Permissive dependencies only.** Production dependencies must be MIT, Apache-2.0, BSD-2/3-Clause, 0BSD or ISC
  (`pnpm licenses:check`). An exception needs an entry (name, version, reason) in `config/license-exceptions.json`,
  approved by a maintainer.

## Development setup

You need Node (the version in `.nvmrc`), pnpm 11 and Docker.

```sh
pnpm install
cp .env.example .env                                   # then adjust (see the comments inside)
docker compose -f docker-compose.dev.yml up -d --wait  # Postgres 17 (logical replication) and S3 storage
pnpm dev                                               # server on PORT (3000), web on 5173
```

The [README](README.md) has the details: ports, layout, what each gate checks.

## The gates

CI runs all of these. Run them before you push; a pull request needs them green.

```sh
pnpm lint            # Biome lint and format (pnpm format fixes)
pnpm typecheck       # TypeScript, strict, every workspace
pnpm test            # Vitest (DATABASE_URL=... pnpm test also runs the Postgres test)
pnpm i18n:check      # every key of en.json exists in it.json
pnpm brand:check     # the product name only where allowed
pnpm licenses:check  # production dependencies are permissive
pnpm build
pnpm e2e             # Playwright
```

Two conventions the gates enforce:

- **No literal product name in code or UI text.** The name comes from the brand config (`{brand}` in strings), because
  every instance can wear its own brand.
- **Every user-facing string is in both `en.json` and `it.json`.** English is the source language for code, strings
  and docs.

## Tests first where it matters

For security-sensitive areas, write the failing test before the code, and say in the pull request which cases the
tests cover: sign-in and sessions, OAuth and tokens, permissions and workspace isolation (including tests that try to
cross workspaces), secrets and encryption, webhook signing, file uploads, imports. A change to these areas gets a
slower, closer review. Everything else: tests with the change, not after.

## Branches, commits, pull requests

- Branch names are `type/topic`: `feat/`, `fix/`, `chore/`, `docs/` (for example `fix/session-expiry`).
- Commit messages start with the same type: `fix: reject expired magic links`. Explain why, not only what.
- One concern per pull request, small enough to review. Say what changed, why, and how you checked it.
- Keep `.env.example` in step with any environment variable you add, rename or remove: name, a placeholder or safe
  default, one comment line. Never put a real value anywhere in the repo.

## Secrets

Never commit secrets, tokens, personal data or anything from a private workspace, fixtures included. Gitleaks runs in
CI and as a pre-commit hook; install it once per clone:

```sh
brew install gitleaks    # or your platform's package
git config core.hooksPath .githooks
```

## AI-assisted contributions

Using AI tools is welcome. You are responsible for what you submit: read it, run the gates, and make sure it does not
copy code you cannot license under Apache-2.0.

## Running a downstream fork

Keeping a fork of Torch for your own team is expected. See [docs/fork-sync.md](docs/fork-sync.md) for how to keep it in
sync with upstream, what may differ, and what belongs upstream.

## Where things live

- `docs/design.md` the design, `docs/adr/` decision records, `docs/fork-sync.md` for downstream forks.
- `apps/web` (React), `apps/server` (Hono), `packages/shared`, `config/`, `scripts/` (the gates).
