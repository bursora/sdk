# Contributing to @bursora/sdk

Thanks for your interest. This is a small project; the bar to land a patch is low.

## Dev setup

```bash
git clone https://github.com/bursora/sdk.git
cd sdk
bun install
```

Requires Bun >= 1.0 or Node >= 18.

## Run the checks

```bash
bun run typecheck   # tsc --noEmit
bun test            # bun test
bun run lint        # eslint
bun run build       # tsup, dual ESM + CJS
```

The `check` script runs the full set.

```bash
bun run check
```

## Pull requests

- Branch off `main`. Keep the diff focused; one feature or fix per PR.
- Add or update tests for any behavior change.
- Match the existing TypeScript style; no new dependencies without discussion.
- No CLA. The MIT License covers the contribution.

## Bugs and feature requests

Open an issue at https://github.com/bursora/sdk/issues. Repro snippet beats prose.
