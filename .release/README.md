# Component release policy

Authoritative policy and tooling: EVYAR/evyar issue #382. This directory is a vendored, standard-library-only copy of release policy v1; update it through reviewed PRs. No script deploys, publishes a package, creates a tag or runs a migration.

Every feature PR adds a uniquely named `.release/changes/*.json` record: `type` is `patch`, `minor`, `major` or `none`, and `summary` explains the resulting behavior. `major` also requires `migration` with affected consumers, compatibility/deployment order and recovery notes. The largest pending change determines the next version. Breaking consumer contracts require a major bump even while a component is 0.x; routine additive database migrations do not inherently require a major bump. `none` is for docs, tests and release/CI infrastructure, never runtime/package changes. Pending records are append-only until a release consumes them.

Do not bump versions in feature PRs. For a release, use a clean isolated checkout of the exact approved dev commit, create `release/<component>-v<version>`, and run:

```
python3 .release/release.py prepare
```

It changes the component version source, root npm lock versions, Expo display version where applicable, changelog, and an auditable consumed-change history. Native Android/iOS build counters remain managed by EAS. Open the resulting release PR against prod. Include service tests, migration/config review and artifact verification. The release check verifies consumed records against the frozen dev commit and rejects source changes after freezing. Bring the release/version-history commit back to dev after promotion before preparing another release.

The first adoption PR establishes tooling only. Baselines preserve existing package versions; they are not assertions that all existing code is production-accepted. Repositories without a package version use `VERSION` with an explicitly reviewed initial 0.1.0 baseline. Upstream forks retain upstream version syntax and require reviewed upstream releases; automated preparation refuses to rewrite them.

```
python3 .release/release.py check --base <base-sha>
python3 .release/release.py check --base <prod-base-sha> --release
python3 .release/release.py build-info --output /tmp/build-info.json
```

Build metadata identifies the component version, exact source commit, dirty status and CI run; it contains no credentials. CI archives it for every successful policy run. This is source/build evidence, not proof of what a server or browser is currently running. Runtime endpoint/asset embedding and the CSMS release inventory must consume actual deployed artifacts before reporting observed deployment versions.

Current GitHub private-repository branch protection is unavailable under the organization's plan (HTTP 403). These workflows report checks but cannot make merges server-enforced by themselves. Enable an eligible plan/ruleset and require `Component version policy / policy` on dev/prod; gate production deployment separately. This setup deliberately creates no production auto-deploy trigger.

To prepare the complete draft PR locally after adoption has merged to dev, run `python3 .release/open-release.py` with authenticated Git and GitHub CLI. It freezes origin/dev in a separate worktree, validates the release against origin/prod, pushes only a new release branch and opens a draft PR. Failures leave the checkout available for inspection. It never merges or publishes. This avoids granting new production credentials to a CI workflow. Existing deployment workflows must remain independently gated.

For repositories without a version field, the source is `.release/baseline-version.json` (initial 0.1.0), rather than altering runtime package metadata. The platform source is `.release/platform-version.json` at the previously published 1.0.0. The reviewed `baselineVersion` is used only for the first release when prod predates the new version source. Upstream components without a SemVer source record their exact upstream revision; automatic bumping remains disabled.

Dev/PR build metadata adds an `artifactVersion` such as `0.1.0-dev.123.abcdef123456`; `version` remains the canonical component baseline. A stable package version alone does not identify a deployable artifact. An RC must be built from the frozen release commit and retain its digest; do not rename or rebuild it as proof of promotion. EAS display versions change through release PRs, while the remote native counters keep increasing independently.

Before the first release, audit historical dev→prod changes and add reviewed patch/minor/major declarations for them. Adoption records deliberately say `none` and do not classify previously merged features retroactively. The platform 1.1.0 candidate is an inventory/checklist, not an approved release.
