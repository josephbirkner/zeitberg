# Zeitberg 1.4.0 release readiness

Implementation is on `release/1.4.0`. The pull request and GitHub release remain
drafts until final review; preparing them does not merge or publish the release.

- [Pull request #55](https://github.com/josephbirkner/zeitberg/pull/55)
- [Milestone 1.4.0](https://github.com/josephbirkner/zeitberg/milestone/4)
- [User-facing changes](CHANGELOG.md#140)
- [English guide](guide.html) / [Deutsche Anleitung](guide.de.html)

## Scope

- Provider onboarding and private repository creation: #50, #30, #51, #52.
  GitHub uses its registered App and a restricted device-flow relay. GitLab
  and Codeberg use registered public OAuth clients with PKCE. Repository
  discovery supports automatic pagination, multiple selections, and existing
  connections. Usable account authorization is reused.
- Independent workspace management: #53. Per-connection status, compact actions,
  module-aware navigation, and one initialization screen for all connections.
- Illustrated English and German guides: #54. Public images use fictional
  playground data; CI also produces reproducible screenshot artifacts.
- Browser-encrypted invitations, app-wide layout refinements, editable time-entry
  times, and consistent editor actions complete the release.

## Verification

The Tests workflow is the release gate: unit and browser regressions, combined
coverage, JavaScript type checking, generated assets, static publication, and
playground screenshots. Check the final branch SHA, not an earlier passing run.

Real-provider authorization, discovery, and creation were exercised during
development with the registered applications. Those checks involve external
accounts and are not replaced by the mocked CI onboarding suite.

## Deployment and compatibility

- No workspace document migration is required. Existing PAT connections and
  capability links remain readable. OAuth grants are not shareable credentials.
- GitHub Pages is already configured for Actions publishing. Merging into main
  builds and deploys the static app; a release-branch push does not deploy it.
- The GitHub authentication relay and encrypted-invitation service are deployed
  separately in Scaleway Paris. Source and operational instructions are in
  [serverless/github-auth](serverless/github-auth/README.md) and
  [serverless/invitations](serverless/invitations/README.md). Do not redeploy or
  rotate credentials merely to publish the frontend.
- Invitations expire after 30 days. Revocation prevents new imports only;
  previously imported access must be revoked at the Git provider.
- Serverless scale limits and a €5 email alert are configured. The alert is not a
  spending cap. Only public client IDs and endpoints belong in the frontend;
  storage credentials remain in the function's secret environment.

## Publication checklist

1. Confirm the final pull-request checks pass and review the release draft.
2. Merge #55 and verify the main-branch Pages deployment.
3. Tag and publish `v1.4.0` from the merged release revision; close the milestone
   after the linked issues are resolved.
4. Smoke-test production sign-in, workspace selection, and both guide languages.
