# Zeitberg 1.4.0 release plan

Status: planning only. No application implementation, provider registration,
version bump, or deployment is included in the initial release-branch commit.

## Objective

Make Zeitberg approachable without Git knowledge: authorize a provider, create
or connect a private workspace, save a first edit, and return successfully.
Manage multiple workspaces naturally and learn the app from illustrated guides.

## Tracked scope

Milestone: [Release 1.4.0](https://github.com/josephbirkner/zeitberg/milestone/4).
Issue acceptance criteria are the source of truth as the plan is refined.

- [#50: End-to-end provider onboarding](https://github.com/josephbirkner/zeitberg/issues/50).
  - [#30: GitHub registration and authentication feasibility](https://github.com/josephbirkner/zeitberg/issues/30).
  - [#51: GitLab registration and onboarding](https://github.com/josephbirkner/zeitberg/issues/51).
  - [#52: Codeberg registration and onboarding](https://github.com/josephbirkner/zeitberg/issues/52).
- [#53: Independent workspace connections and compact actions](https://github.com/josephbirkner/zeitberg/issues/53).
- [#54: Documentation with tested playground screenshots](https://github.com/josephbirkner/zeitberg/issues/54).

## Sequence

1. Validate provider authentication, browser CORS, refresh, repository creation,
   permissions, and production/development callback requirements. Agree app
   ownership and resolve the GitHub authentication architecture before building it.
2. Register the actual provider applications and develop the shared onboarding
   journey together with account/credential and workspace-management changes.
3. Write task-oriented guides alongside finished flows, extending the existing
   seeded, clock-frozen playground screenshot integration tests.
4. Verify real-provider journeys and desktop/mobile regressions before release.

## Open decisions and constraints

- Backend-free is preferred. GitHub device flow is a candidate, not a proven
  browser solution. Any authentication backend requires explicit agreement;
  never expose a client secret or app private key in the frontend.
- Agree provider-app ownership and any account-owner authorization required for
  registration. Record public configuration and recovery instructions, not secrets.
- Verify and explain each provider's effective permissions; do not describe a
  broadly scoped OAuth grant as repository-limited.
- Preserve PAT and capability-link connections. Do not incidentally make broad
  OAuth credentials shareable through capability links.
- Replace the global-active-workspace UX with independent connections while
  preserving per-module selections, combined views, drafts, and pending saves.
- All release implementation stays on `release/1.4.0`; the PR remains a draft
  until implementation, verification, and release review are complete.

## Release acceptance

- Real registered applications work with GitHub, GitLab, and Codeberg.
- A new user can authorize, create/connect a private workspace, choose apps,
  save an edit, and return later; cancellation and reconnection are recoverable.
- Workspace actions target their own connection without unexpectedly switching
  the displayed document or discarding edits.
- Desktop and mobile Safari are covered by automated regressions and appropriate
  real-provider smoke tests; mocked tests are not a substitute for registration checks.
- Public documentation includes deterministic desktop/mobile screenshots from
  verified fictional playground scenarios, without private data or credentials.
