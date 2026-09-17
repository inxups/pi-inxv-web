# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
npm run test:e2e:gateway
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`, then runs the Gateway auth flow
with a Chromium virtual WebAuthn authenticator. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Unknown sessions and paths outside the fixture project are rejected.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.
- The Gateway flow registers a virtual Passkey, finishes setup with TOTP,
  creates a read-only API token, verifies scope and account-boundary rejection,
  checks the audit view, logs out, and signs back in with the virtual Passkey.

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save screenshots, Playwright traces, and server logs under
`test-results/`; CI uploads that directory. Open the main suite trace with
`npx playwright show-trace test-results/e2e/trace.zip`; the Gateway auth flow
saves a failure screenshot under `test-results/gateway-auth/`.
