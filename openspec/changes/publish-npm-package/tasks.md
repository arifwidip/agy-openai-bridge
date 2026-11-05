# Tasks

## 1. Library Entrypoint & Environment-Aware Test Suite

- [x] 1.1 Create `src/index.ts` exporting `BridgeServer`, `AcpClient`, `SessionManager`, `ToolStreamParser`, and all types from `./types.js`, and verify `npm run build` produces `dist/index.js` and `dist/index.d.ts`
- [x] 1.2 Update `src/test.ts` to test importing `dist/index.js` without side effects, add offline unit tests for `SessionManager`, and auto-skip the live `agy` E2E test when `agy` is absent on `PATH` (or `AGY_SKIP_LIVE_E2E=true`), verifying both `AGY_SKIP_LIVE_E2E=true npm test` and `npm test` exit `0`

## 2. Package Metadata, Tarball Whitelist, & Licensing

- [x] 2.1 Add an MIT `LICENSE` file copyrighted to Arif Widipratomo and verify the file exists at the repository root
- [x] 2.2 Update `package.json` with `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, `"exports"`, `"files": ["dist", "!dist/test.*"]`, `"prepublishOnly": "npm run build && npm test"`, clean build script, `"license": "MIT"`, `"author"`, `"repository"`, `"homepage"`, `"bugs"`, and `"keywords"`, and verify `npm pack --dry-run` lists only `dist/` runtime artifacts, `package.json`, `README.md`, and `LICENSE`

## 3. GitHub Actions Release Workflow & Documentation

- [x] 3.1 Create `.github/workflows/publish.yml` triggered on `v*` tags and `workflow_dispatch` to run `npm ci`, `npm run build`, `npm test`, and `npm publish --provenance --access public`, and verify the workflow YAML is valid
- [x] 3.2 Update `README.md` with `npx agy-openai-bridge` / `npm install -g agy-openai-bridge` installation instructions, programmatic library usage, OpenCode provider configuration, and publishing instructions, and verify `npm run prepublishOnly` succeeds end-to-end
