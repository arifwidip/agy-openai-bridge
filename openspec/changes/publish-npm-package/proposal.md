# Proposal

## Why

`agy-openai-bridge` currently works only from a local git clone and lacks npm distribution hygiene: `npm pack` bundles ~250 kB of internal `.agents/`, `openspec/`, `src/`, and test files, `package.json` points `"main"` directly at `./dist/cli.js` (which immediately starts the HTTP server as an import side effect), and there is no `LICENSE`, `prepublishOnly` build/test guard, or automated GitHub Actions release pipeline. Preparing the package for public release on npm as `agy-openai-bridge` enables any developer to run `npx agy-openai-bridge` or import its classes programmatically.

## What Changes

- Add a side-effect-free programmatic library entrypoint (`src/index.ts` -> `./dist/index.js` and `./dist/index.d.ts`) re-exporting `BridgeServer`, `AcpClient`, `SessionManager`, `ToolStreamParser`, and TypeScript types while keeping `./dist/cli.js` as the `agy-openai-bridge` CLI binary.
- Configure `package.json` for public unscoped npm distribution (`name: "agy-openai-bridge"`, `"files": ["dist", "!dist/test.*"]`, `"main"`, `"types"`, `"exports"`, `"prepublishOnly": "npm run build && npm test"`, `"license": "MIT"`, `"author"`, `"repository"`, `"homepage"`, `"bugs"`, and `"keywords"`).
- Add an MIT `LICENSE` file copyrighted to Arif Widipratomo.
- Update `src/test.ts` so the live `agy` binary end-to-end test automatically skips when `agy` is not available on `PATH` (such as on GitHub Actions runners), while keeping offline unit tests active everywhere.
- Add `.github/workflows/publish.yml` to build, run tests, and publish `agy-openai-bridge` to npm with provenance when `v*` git tags are pushed.
- Update `README.md` with `npx agy-openai-bridge` / `npm install -g agy-openai-bridge` quick-start instructions, programmatic usage, and OpenCode configuration examples.

## Capabilities

### New Capabilities
- `package-distribution`: Dual CLI and side-effect-free ESM/TypeScript library distribution on npm, clean tarball file filtering, CI-safe test execution without requiring a local `agy` binary, and tag-driven GitHub Actions npm publishing.

### Modified Capabilities

## Impact

- `package.json`: Metadata, entrypoints (`main`, `types`, `exports`, `bin`), `files` whitelist, and `prepublishOnly` script.
- `src/index.ts`: New library entrypoint exporting `BridgeServer`, `AcpClient`, `SessionManager`, `ToolStreamParser`, and types.
- `src/test.ts`: Auto-skip detection for the live `agy` E2E test when `agy` is absent on `PATH`.
- `LICENSE`: New MIT license file.
- `.github/workflows/publish.yml`: New CI/CD workflow for `v*` tag releases to npm.
- `README.md`: Updated installation and OpenCode configuration documentation.
