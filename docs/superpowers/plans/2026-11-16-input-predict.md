# Input prediction implementation plan

**Goal:** Deliver a DSH 0.2.2-rc.3 input prediction bundle with bounded session context, separate tips, and explicit guarded insertion.

**Architecture:** Host Session-authorized Remote methods read detached bounded context and call the existing llm service. Client state machine owns request identities, debounce, cancellation and transient suggestions. A version-specific fail-closed input bridge verifies local DOM session identity; it never writes the editor. Acceptance uses captureInsertion/insertText and normal keyboard arbitration.

**Tech Stack:** ESM JavaScript, React supplied by DSH, Node test runner, esbuild browser bundle, real installed Gateway integration. Authenticated browser interaction remains unverified.

## Decisions

- Implement the previously proposed single-tip design with next-message and suffix modes and explicit accept/dismiss buttons.
- No changes to the installed DSH core. Keep DOM compatibility in one module; unsupported structure disables the feature rather than intercepting unrelated inputs.
- Users explicitly enable prediction per mounted input. Host configuration supports disabling it globally and choosing a model; missing model overrides use the profile default.
- Default budgets: 12 messages / 12000 context characters, 6000 draft characters, 600 candidate characters, 256 output tokens, 15 seconds, 2 global concurrent requests, 1500 ms per-session interval, 900 ms debounce.
- Candidate acceptance is user-only. No send, tool execution, session history writes or prediction text persistence.
- Unloading, reconnecting, session activity, edits, selection movement, IME and focus loss invalidate requests and suggestions. Host validates context before and after generation. Acceptance stays synchronous so Tab is consumed only after insertion succeeds; Client invalidates on session activity/connection changes and expires candidates after 20 seconds. Remote activity delivery can lag, so no cross-process atomic context-at-insertion guarantee is claimed.
- Installation may activate the plugin UI but must not initiate model calls before opt-in. Do not publish a package or initialize a remote repository.

## Tasks and ownership

- [x] Host worker: index.js, host/*.js, tests/host*.test.js. First test bounded extraction, output parsing, authorization metadata, cancellation and stale context. Run node --test tests/host*.test.js. Use inspected Service signatures, public Remote registration, no generated-descriptor fabrication.
- [x] Input worker: web/input-bridge.js and tests/input-bridge.test.js. Test local session mapping, ambiguity, selection movement, composition and disposal before implementation. Validate editor identity against data-conversation-session and fail closed.
- [x] Lead: web/prediction-controller.js, tests/controller.test.js. Test late-response rejection, dedupe, dismissal, atomic insertion failure and cancellation before implementation.
- [x] Lead: web/client.js, scripts/build.js, package.json, cordis.patch.yml, locales and icon. Bundle browser module-loader factory with no bundled React or DSH internals.
- [x] Integration: run npm test, npm run check, npm run build and npm pack --dry-run; inspect final sources and packaged files. Install only after tests pass, then inspect live slot registration and verify the existing GUI if browser access is available.
- [x] Documentation: replace initialization-only README with configuration, activation, architecture, tested scope and compatibility limits. Record real browser/model verification separately from deterministic unit tests.

## Acceptance matrix

1. Preview leaves draft and undo history unchanged; successful acceptance is exactly one guarded insert and does not send.
2. New draft, selection, focus, session or context makes a prior response unusable.
3. Composition, local menus, Shift+Tab and consumed keys retain native behavior.
4. Unauthorized callers cannot read a session or call the model; malformed inputs fail before context reads.
5. Missing/failed/slow model calls do not block typing and are bounded.
6. Plugin disposal removes listeners/timers and aborts outstanding calls.
7. Package includes all runtime modules and metadata; installed UI has a discoverable opt-in control and no automatic cost on activation.
