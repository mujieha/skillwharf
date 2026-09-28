# Contributing

## Setup

```
npm ci
```

## Checks

Run all four before opening a pull request:

```
npm run typecheck
npm test
npm run build
bash scripts/smoke.sh
```

## Branches

Feature branches go through a pull request into `develop`. `main` is the release branch and
only receives merges from `develop`.

## Security-relevant changes

A change to path validation, symlink handling, lockfile checks, sanitising or anything else in
the threat model (see [SECURITY.md](SECURITY.md)) needs a test that fails without the fix.

## Code of conduct

Be kind.

No CLA is required to contribute.
