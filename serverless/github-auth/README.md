# GitHub authentication relay

Small, dependency-free Scaleway Function for GitHub App device authorization.
This is a server-side exception to the otherwise static application: GitHub's
authentication endpoints do not permit browser CORS access. Repository reads and
writes still go directly from the browser to GitHub.

## Deployment

Live endpoint: <https://zeitbergauthjktlgxby-githubauth.functions.fnc.fr-par.scw.cloud/>.
Function ID: `954f2fcd-eca1-4c08-942f-594aab6114b4`.
Namespace ID: `e1299703-a835-4083-b66f-f81fffbaa204`.

- Project: `zeitberg`; namespace: `zeitberg-auth`; region: Paris (`fr-par`).
- Runtime: Node 24; handler: `handler.handle`.
- Upload a ZIP containing `handler.js` and `package.json` at its root.
- Memory: 128 MB; minimum instances: 0; maximum instances: 1.
- Request timeout: 15 seconds (upstream requests time out after 10 seconds).
- Public invocation, HTTPS-only. No environment secrets or private keys needed.
- Set the generated HTTPS root URL in `GITHUB_RELAY_URL` in `oauth.js` after
  verifying the live deployment. An empty value retains GitHub PAT onboarding.
- Configure a recurring email billing alert at 100% of a €5 monthly budget.
  This is an alert, **not a spending cap**; scale-to-zero and maximum instances
  also do not provide a hard spending cap.

Example packaging command, executed inside this directory:

```sh
zip /tmp/zeitberg-github-auth.zip handler.js package.json
```

Use a fresh output path for subsequent packages to avoid stale ZIP entries.
Deployments are separate from GitHub Pages releases; the Pages staging script
does not publish this directory. Keep the deployed source in sync with this
directory when changing validation or rate limiting.

## Protocol and boundaries

Only JSON `POST /` is supported (plus CORS `OPTIONS /`). No query parameters,
arbitrary target URLs, client IDs, scopes or authorization-code grants are accepted.
The public GitHub App Client ID is fixed in source, not a secret.

Request bodies have one of these forms:

```json
{"action":"device"}
{"action":"token","device_code":"..."}
{"action":"refresh","refresh_token":"..."}
```

The response contains only whitelisted GitHub fields. Unknown provider failures
become generic errors, never reflected request data or raw exception details.
Redirects are refused. Responses are not cached. Browser credentials/cookies are
not used, and authorization data stays in POST bodies rather than URLs.

Allowed browser origins are `https://zeitberg.io`, `http://localhost:8000`, and
`http://127.0.0.1:8000`. Adding another origin requires a reviewed deployment.
CORS is not authentication: non-browser callers can forge Origin headers.

Warm-instance rate limits allow 30 upstream requests per client address per
minute and 120 globally. Only transient hashes/counters are kept; they reset on
cold starts and are neither durable nor a billing guarantee. Restricting instance
count limits scaling, not cumulative calls. Platform-level protection should be
revisited if usage grows or abuse occurs. Browser polling respects GitHub's
interval, slow_down, expiry, cancellation and relay throttling.

## Credential handling

The relay does not log, persist, cache, or place credentials in URLs. Access and
refresh tokens necessarily pass through the Scaleway runtime in Paris and then
return to the browser. Do not enable request/response body logging, tracing that
captures payloads, or caching at a proxy. Platform infrastructure may retain
ordinary operational metadata; this is not a promise of zero platform logs.

The frontend never accepts a relay URL from a workspace, share link or stored
grant. Otherwise a hostile repository could redirect refresh tokens to itself.
PAT connections and direct GitLab/Codeberg OAuth do not depend on this function.

## Verification

Run `node --test tests/github-relay.test.mjs tests/github-device.test.mjs` from
the repository root, plus `npm test` and `npm run typecheck` before deployment.
Verify browser CORS from a supported origin, rejection of a foreign Origin and
invalid actions, and one explicit GitHub authorization. Never print real token
responses into logs or commit test credentials.
