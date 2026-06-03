# Security Policy

## Reporting a vulnerability

Don't open a public issue for security problems.

Report privately through GitHub: the **Security** tab, then **Report a vulnerability** (https://github.com/bursora/sdk/security/advisories/new). The advisory stays private to the maintainers. You can also email security@bursora.com.

Include a repro or proof of concept where you can. We aim to acknowledge within 72 hours and to ship a fix or mitigation before public disclosure.

## What we care about most

`@bursora/sdk` wraps AI provider clients to enforce spend budgets, so the sharp edges are:

- Leaking the Bursora API key, provider keys, or the tag data the SDK handles.
- Budget-check bypass: the wrapper letting a call through after Bursora returned block.
- Tampering with the usage events the SDK reports.

Anthropic's `messages.stream()` / `beta.messages.stream()` helpers fire their request synchronously, so they are metered but not pre-blocked by design (the spend still counts toward the budget). Use `messages.create({ stream: true })` for a hard pre-call block. This is documented behavior, not a bypass.

## Supported versions

Only the latest published `@bursora/sdk` is supported. Fixes ship on `main` first.
