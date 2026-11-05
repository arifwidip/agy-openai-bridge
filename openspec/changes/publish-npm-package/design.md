# Design

## Context

See `proposal.md` for motivation. Currently, `package.json` sets `"main": "./dist/cli.js"`, has no `"files"` field, and lacks license/repository metadata. Running `npm pack --dry-run` produces a 40-file (313.6 kB unpacked) archive containing `.agents/skills/`, `.agents/workflows/`, `openspec/`, `src/`, and `dist/test.*`. Furthermore, `src/test.ts` unconditionally spawns `agy acp`, which fails on standard GitHub Actions runners where the proprietary `agy` CLI is not installed.

## Goals / Non-Goals

**Goals:**
- Provide a clean dual-surface package (`bin` for CLI users + side-effect-free `main`/`exports`/`types` for programmatic Node/TS users).
- Ensure `npm pack` / `npm publish` ships only runtime build artifacts (`dist/` without test files), `README.md`, `LICENSE`, and `package.json`.
- Make `npm test` pass both locally (full live `agy` E2E + unit tests) and in CI (unit tests, auto-skipping live `agy` E2E when `agy` is absent).
- Support both manual local publishing (`npm login && npm publish`) and automated tag-based GitHub Actions publishing with npm provenance.

**Non-Goals:**
- Publishing under an npm organization scope (confirmed unscoped `agy-openai-bridge`).
- Bundling or installing the `agy` binary itself inside the npm package (`agy` remains a host prerequisite).

## Decisions

1. **Separate `src/index.ts` Library Entrypoint from `src/cli.ts`**
   - *Choice*: Create `src/index.ts` that re-exports `BridgeServer`, `AcpClient`, `SessionManager`, `ToolStreamParser`, and all types from `./types.js`. Point `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, and `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }` in `package.json`, while keeping `"bin": { "agy-openai-bridge": "./dist/cli.js" }`.
   - *Rationale*: `src/cli.ts` unconditionally runs `main()` at module evaluation time. Separating `src/index.ts` allows programmatic consumers to import `BridgeServer` without starting a server on port 8787 as a side effect.
   - *Alternative considered*: Checking `import.meta.url === ...` inside `src/cli.ts`. Rejected because symlinked global npm binaries (`npx` / `/usr/local/bin/agy-openai-bridge`) can resolve `process.argv[1]` differently from `import.meta.url` unless `realpathSync` is carefully handled, whereas a dedicated `src/index.ts` is zero-risk and idiomatic.

2. **Whitelist Tarball Contents via `package.json` `"files"`**
   - *Choice*: Set `"files": ["dist", "!dist/test.*"]` in `package.json`.
   - *Rationale*: Whitelisting in `package.json` is safer than maintaining a blacklist in `.npmignore` because new repo-level tooling directories (`.agents/`, `openspec/`, `.github/`) are excluded by default. `README.md`, `LICENSE`, and `package.json` are always included by npm automatically.

3. **Auto-Detect `agy` Binary Availability in `src/test.ts`**
   - *Choice*: Check whether the `agy` executable is resolvable (using `spawnSync("which", ["agy"])` or `AGY_SKIP_LIVE_E2E=true`) and pass `{ skip: !hasAgy ? "agy binary not found on PATH" : false }` to the live E2E test in `node:test`, while also adding offline unit coverage for `SessionManager` prefix hashing and tool message formatting.
   - *Rationale*: Preserves one unified `npm test` command that runs full E2E locally when `agy` is installed and cleanly passes unit tests on GitHub Actions runners.

4. **GitHub Actions Workflow on `v*` Tags with Provenance**
   - *Choice*: Add `.github/workflows/publish.yml` triggered on `push.tags: ["v*"]` and `workflow_dispatch`, with `permissions: { contents: read, id-token: write }` and `npm publish --provenance --access public` authenticated via `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`.
   - *Rationale*: Enables cryptographic npm package provenance on GitHub-hosted runners while still allowing manual `npm publish` from a local terminal whenever needed.

## Risks / Trade-offs

- **[Risk] Stale `dist/` files from earlier builds lingering when `npm pack` runs locally** → **Mitigation**: Update `"build"` or add `"prebuild"` to clean `dist/` (`rm -rf dist && tsc`) so deleted or renamed source files never leak into `dist/`.
- **[Risk] `NPM_TOKEN` secret not yet configured in GitHub repo settings** → **Mitigation**: Document the `NPM_TOKEN` secret setup in `README.md` alongside local `npm login && npm publish` instructions so the initial release works immediately via local CLI even before CI secrets are configured.
