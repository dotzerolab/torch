# Keeping a downstream fork in sync

Upstream is `dotzerolab/torch`. A team that runs its own instance keeps a downstream fork that always has the current
upstream code. No fork exists yet; this is the design for the first one.

## The model

- `main` of the fork mirrors upstream `main`. Nobody commits to it.
- `deploy` is `main` plus the fork-only layer below. You build and deploy from `deploy`.
- A scheduled GitHub Action fast-forwards `main` from upstream, then merges `main` into `deploy`.

## What may diverge

Keep these in paths upstream never touches (for example `deploy/` and new files under `.github/workflows/`), so merges
stay conflict-free:

- brand: your own JSON file for `BRAND_CONFIG_PATH` and your logos (never edit `config/brand.default.json`);
- deploy files: production Compose file, reverse proxy, backup jobs, the deploy and sync workflows;
- secrets stay out of the fork: pass them as environment variables (`.env.example` lists the names).

## What must not diverge

Core code: `apps/`, `packages/`, `scripts/`, migrations, tests, `config/` defaults and upstream's CI. A bug or a missing
feature goes upstream as a pull request ([CONTRIBUTING.md](../CONTRIBUTING.md)). If you cannot wait, patch `deploy`,
open the upstream pull request the same day, and drop your patch when a sync brings the fix. A merge conflict in the
sync means core code diverged: move that change upstream.

## The scheduled sync

`.github/workflows/sync-upstream.yml` in the fork:

```yaml
name: sync-upstream
on:
  schedule: [{ cron: '17 4 * * *' }]
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { ref: deploy, fetch-depth: 0, token: '${{ secrets.SYNC_TOKEN }}' }
      - name: fast-forward main from upstream
        env: { GH_TOKEN: '${{ secrets.SYNC_TOKEN }}' }
        run: gh repo sync "$GITHUB_REPOSITORY" --source dotzerolab/torch --branch main
      - name: merge main into deploy
        run: |
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git fetch origin main && git merge --no-edit origin/main && git push origin deploy
```

- `gh repo sync` only fast-forwards. If `main` holds fork-only commits it fails instead of overwriting them; never add
  `--force`, which discards them.
- The default `GITHUB_TOKEN` cannot change files under `.github/workflows/`. Store a token with the `workflow`
  permission (fine-grained token or GitHub App) as the secret `SYNC_TOKEN`.
- A conflict fails the job and GitHub notifies the fork's maintainers; resolve it on `deploy` by hand.
- Manual sync: the fork's **Sync fork** button updates `main`; merge it into `deploy` yourself. A private copy instead
  of a fork: replace the `gh repo sync` step with a `git merge upstream/main`.
- Torch is pre-v1: read what changed (migrations included) before you deploy, and only when CI is green.
