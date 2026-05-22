# Changelog

All notable changes to `@bursora/sdk` are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### BREAKING

- Replaced provider-specific wrappers with a unified `wrap(client, manifest, core)`
  API. `wrapOpenAI` and `wrapAnthropic` are gone; build a core with
  `createBursora({ apiKey, endpoint? })` and pair it with `openaiManifest` or
  `anthropicManifest`.
- Removed the `pepper` option. The wire format now sends only
  `X-Bursora-Key: <plaintext>`; the `X-Bursora-Sig` header is gone.
- Migration: drop `pepper` from your client construction. Set `BURSORA_API_KEY`
  to the plaintext secret (`bsk_<workspaceId>_<random>`) shown once at issue
  time in the dashboard. Existing UUID-shaped key ids no longer authenticate.

### Changed

- Cost reports are now flushed synchronously after each wrapped call (both
  request/response and streaming). Adds one network round-trip to the hot path
  but guarantees that a block budget's pre-flight on the next call sees the
  prior call's cost. Required for the server's "no overshoot" guarantee.

## [0.1.0] - 2026-05-10

### Added

- Initial public release.
- `wrapOpenAI(client, opts)` — wraps an OpenAI client with the Bursora
  decision/event lifecycle.
- `wrapAnthropic(client, opts)` — same surface for `@anthropic-ai/sdk`.
- `withTags(tags, fn)` — propagates tag context across awaited calls via
  `AsyncLocalStorage`.
- `BudgetExceededError` — thrown before the provider call when a block-mode
  budget rejects the request.
- LRU decision cache (60 s TTL) and bearer-key event ingest.
- Streaming support: chunks pass through; usage read from the terminal chunk.
- Dual ESM + CJS build with TypeScript declarations.

[0.1.0]: https://github.com/vildanbina/bursora/releases/tag/sdk-v0.1.0
