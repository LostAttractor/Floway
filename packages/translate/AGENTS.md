# Translation Protocols and Shared Helpers

`src/protocols/<protocol>/` owns translation entrypoints and protocol-specific
code. `__tests__/protocols/` mirrors production ownership. Package callers
import the source protocol's subpath and call
`route<Protocol>(input).via<Target>(context)` to create an independent trip.

## Categories

1. **Single-pair helper** — keep it in
   `protocols/<source>/via-<target>/`, beside its request and event translators.
2. **Source-only helper** — keep it in `protocols/<protocol>/as-source/`.
   Only routes whose source is that protocol may import it.
3. **Target-only helper** — keep it in `protocols/<protocol>/as-target/`.
   Only routes whose target is that protocol may import it.
4. **Both directions** — keep it in `protocols/<protocol>/common/`.
   Routes using that protocol as source or target may import it. A helper that
   also names another protocol retains that narrower pair scope.
5. **Protocol-independent utility** — keep it in `shared/`, with tests under
   `__tests__/shared/`. Protocol behavior belongs in its owning protocol directory.

## Current Production Subdirectories

- `protocols/anthropic-messages/as-source/` — interprets Messages requests.
- `protocols/anthropic-messages/as-target/` — maps requests and upstream events to Messages.
- `protocols/anthropic-messages/common/` — carries reasoning across Messages and Responses.
- `protocols/gemini-generate-content/as-source/` — interprets GenerateContent parts and schemas.
- `protocols/openai-chat-completions/common/` — maps content and reasoning across Chat Completions, Responses, and Messages.
- `protocols/openai-responses/as-source/` — interprets Responses tools and restores their event identities.
- `protocols/openai-responses/as-target/` — coordinates Responses output ordering and stream-part keys.

## Rules

- Shallow wrappers that only rename or stringify must be inlined at every call
  site, not extracted. A helper that defines a format two or more routes must
  agree on is not such a wrapper: the Responses stream-part key lives in
  `protocols/openai-responses/as-target/openai-responses-stream.ts`.
- Tests stay under `__tests__/` in the same category as their production code.
  Cross-protocol public route contract tests belong under `__tests__/protocols/`.
- Helpers that fit no shared category stay in their route directory.
- A helper that is not translation logic, such as defense against a malformed
  upstream stream, belongs to the gateway boundary that owns that policy.

See the project root `AGENTS.md` for package boundary rules
(`packages/protocols` vs `packages/translate` vs `packages/gateway`).
