# Spec Delta

## Purpose

Defines the distribution, entrypoint, packaging hygiene, CI test adaptability, and automated release behavior for publishing `agy-openai-bridge` to the public npm registry.

## ADDED Requirements

### Requirement: Dual CLI and Side-Effect-Free Library Entrypoints
The package SHALL expose both an executable CLI entrypoint (`agy-openai-bridge`) and a side-effect-free ESM/TypeScript library entrypoint that exports the bridge server, ACP client, session manager, tool stream parser, and TypeScript declarations without starting an HTTP server on import.

#### Scenario: Importing the package as a library
- **WHEN** a Node.js or TypeScript consumer imports the root package `agy-openai-bridge`
- **THEN** the module resolves to `./dist/index.js` (with declarations at `./dist/index.d.ts`) and exports `BridgeServer`, `AcpClient`, `SessionManager`, `ToolStreamParser`, and associated types without spawning `agy acp` or binding a network port

#### Scenario: Running the package as a CLI binary
- **WHEN** a user runs `npx agy-openai-bridge --help` or invokes the globally installed `agy-openai-bridge` binary
- **THEN** `./dist/cli.js` executes and prints the CLI usage and options

### Requirement: Clean npm Tarball Whitelisting
The package SHALL restrict its published npm tarball contents to compiled runtime artifacts (`dist/` excluding compiled test files), `package.json`, `README.md`, and `LICENSE`, excluding repository-internal directories such as `.agents/`, `openspec/`, and `src/`.

#### Scenario: Inspecting packaged tarball contents
- **WHEN** `npm pack --dry-run` is executed after building the project
- **THEN** the tarball includes `./dist/*.js` and `./dist/*.d.ts` (excluding `dist/test.*`), `package.json`, `README.md`, and `LICENSE`, and excludes `.agents/`, `openspec/`, `src/`, and `tsconfig.json`

### Requirement: Prepublish Build and Test Guard
The package MUST automatically compile TypeScript sources and run the test suite during `prepublishOnly` before any `npm publish` operation completes.

#### Scenario: Running prepublish verification
- **WHEN** `npm publish` (or `npm run prepublishOnly`) is invoked
- **THEN** the package runs `npm run build` followed by `npm test` and aborts publishing if compilation or any active test fails

### Requirement: Environment-Aware Test Suite for CI Runners
The test suite SHALL execute offline unit tests in all environments and SHALL automatically skip live `agy` end-to-end tests when the `agy` binary is not present on `PATH`.

#### Scenario: Running tests in CI without the agy binary
- **WHEN** `npm test` runs in an environment where `agy` is not found on `PATH`
- **THEN** offline unit tests execute and pass while the live `agy` E2E test is marked as skipped with a diagnostic reason, and the test command exits with code `0`

#### Scenario: Running tests locally with the agy binary installed
- **WHEN** `npm test` runs in an environment where `agy` is available on `PATH`
- **THEN** both offline unit tests and the live `agy` E2E test execute

### Requirement: Tag-Driven GitHub Actions npm Release
The repository SHALL include a GitHub Actions workflow that builds, tests, and publishes `agy-openai-bridge` to the public npm registry with provenance when a `v*` version tag is pushed.

#### Scenario: Pushing a release version tag
- **WHEN** a git tag matching `v*` (such as `v0.1.0`) is pushed to GitHub
- **THEN** the release workflow installs dependencies via `npm ci`, builds the project, runs `npm test`, and publishes the package via `npm publish --provenance --access public` using `NPM_TOKEN`
