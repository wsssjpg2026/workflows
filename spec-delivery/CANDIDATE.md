# Isolated v0.3 candidate

The candidate is a copy of one exact Git commit plus five pinned skill packages. It is for software and host acceptance before any formal installation switch. The materializer never edits the installed `implement` or `handoff` sources, an existing workflow ledger, or the production skill directory.

## Freeze and verify

Run this only after T19, the DeepSeek bootstrap and all T20 changes have reached one reviewed commit and their tests pass. Use that **final** 40-character SHA; a development SHA or the examples in this document are not a release candidate. Run the materializer from a clean checkout of that same SHA. Keep the external skill root and the resulting manifest digest in the acceptance evidence record.

```sh
REPO=/absolute/path/to/workflows-checkout
CANDIDATE_SHA='FILL_FROM_FINAL_REVIEWED_COMMIT'
INSTALL="$REPO/.agents/acceptance/spec-delivery-$CANDIDATE_SHA"
EXTERNAL_SKILLS=/absolute/path/to/original/skills
cd "$REPO"
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
node spec-delivery/candidate.mjs materialize "$REPO" "$CANDIDATE_SHA" "$INSTALL" "$EXTERNAL_SKILLS"
# Save manifestSha256 from the JSON response outside the install.
node "$INSTALL/spec-delivery/candidate.mjs" verify "$INSTALL" '<manifestSha256>'
# Run the candidate's complete test command and retain its raw output and summary.
node "$INSTALL/spec-delivery/candidate.mjs" replay "$INSTALL" '<manifestSha256>' \
  /absolute/private/new-replay-evidence-directory
```

The checkout's materializer bytes must match the target Git blob. The command refuses an existing install directory, non-blob Git entries, missing skill files, symlinked skill dependencies, changing external packages, or a version entry that cannot run. It copies every tracked file from the commit; the two review packages come from that commit, and `implement`, `diagnosing-bugs`, and `handoff` come from the explicit external skill root. The original `implement/SKILL.md` and `handoff/SKILL.md` must match their task-start SHA-256 values (`6d3fd9e83b8f36e5213854779db49b256a457a7ebb4a503e53fa7dcff696adc3` and `7c62de979fdc7ac32fb5ddb2146156c917f80ee070d30fadc9d40343c4b6ed25`) before and after copying. `candidate-manifest.json` records those checks, the commit, workflow version, every installed file's SHA-256 and Git object where applicable, all five package files and binding fingerprints, the Node/npm dependency declaration, and observed build-tool versions. Host binaries and routes are selected later; their exact versions and native probe results belong in the T21 private evidence, not the source manifest. `verify` requires the separately recorded manifest SHA-256 and rejects changed, missing, extra, or mode-changed files and directories. No credential, host route settings, or runtime state is copied.

The recommended `/.agents/acceptance/` destination is Git ignored. A directory outside the repository is also valid. The materializer sets owner-only read/execute permissions on the resulting files and directories. It is not a Git worktree and must never be used as the issue implementation directory.

## Run without changing the formal installation

Set the installation environment for every workflow process, including `init`, `upgrade`, `migrate-skills`, actors and test commands:

```sh
export SPEC_DELIVERY_SKILL_ROOT="$INSTALL/skills"
export SPEC_DELIVERY_HOST_ADAPTER=/absolute/private/host-wrapper
export SPEC_DELIVERY_HOST_OBSERVER=/absolute/private/session-observer
export SPEC_DELIVERY_SKILL_OBSERVER=/absolute/private/skill-observer
# Only when the actual coordinator can be observed independently:
export SPEC_DELIVERY_MAIN_OBSERVER=/absolute/private/main-session-observer
node "$INSTALL/spec-delivery.workflow.ts" version
cd /absolute/path/to/target-git-worktree
node "$INSTALL/spec-delivery.workflow.ts" init /absolute/private/five-inputs.json
```

The five user inputs remain `spec`, `targetBranch`, and `models.L1/L2/L3`. `SPEC_DELIVERY_SKILL_ROOT` is an installation binding. A materialized candidate refuses a missing, relative, unreadable, or different skill root; it cannot fall back to mutable `HOME`. New runs and safely migrated legacy runs pin the candidate's absolute skill paths and full dependency fingerprints. A later skill replacement uses the public `migrate-skills` decision with current revision and evidence; it invalidates affected review evidence. Preserve the original output and old fingerprints for audit. Use the v0.3 `drive`/`dispatch`/`collect` protocol for new actors, including skill children. `bind` and `bind-batch` are only for historical leases; they cannot bypass managed dispatch or terminal host events. The optional main observer must query the actual coordinator session; a probe or a requested model string does not establish its identity. See [DeepSeek adapter setup](adapters/README.md) for the bootstrap L1 and main-observer paths.

The `replay` entry runs `npm test` from the candidate with its isolated skill root, clears inherited host adapter and observer settings so the suite uses its declared local fixtures, records Node/npm/Git versions, the command, candidate SHA, manifest digest, status, counts, and hashes of the full stdout/stderr, then verifies every candidate file again. Its evidence directory must be new and outside the read-only install. Failed, skipped, cancelled, or todo tests leave a failed replay with preserved raw output and a nonzero exit. The checked [replay coverage index](replay-coverage.json) requires passing tests for graph/parallel execution, review and L1 disagreement, L2 gaps, GitHub and CI gates, recovery/history/metrics, and candidate isolation. The report records each matched test name and the index hash. Its single-ledger v3 public CLI replay uses isolated real Git and simulated host/GitHub: issue 101 goes through recovery, reviews, L2 gap, revised plan, merge, close, and cleanup while issue 102's implement actor remains active and dependent issue 103 remains blocked. It does **not** deliver 102/103 or close the parent spec. Those complete graph and real-host outcomes belong to T21. The Node 24 CI workflow accepts pull requests into any target branch, including `codex/test-v03-deepseek-<run-id>`; its historical push branch filter remains in place. At T21 launch, check actual branch protection and the remote check on the candidate PR head. An absent check from a configuration error is not a `no_ci` waiver.

## Switch and rollback

Keep the formal installation path and current run ledgers unchanged. To try the candidate, point only the acceptance process at the isolated `INSTALL` and its private adapter wrappers. To roll back, stop and reconcile its native actors and command process trees, preserve the candidate ledger and evidence, then restore the previous entry path and environment in a **new** process. Do not copy candidate files over the formal installation or rewind an existing ledger. An owner who later removes the read-only candidate must restore directory write permission first; removal is separate from rollback and should follow evidence retention. Historical #12/#18 runs remain readable. An old active run requires `migration-context` and a trusted `SPEC_DELIVERY_MIGRATION_OBSERVER` quiescence query before `upgrade`; a user-supplied boolean or text assertion cannot replace the per-actor, token, instance, test-process, and external-action checks. Follow [MIGRATION.md](MIGRATION.md) for the locked backup and revision procedure. Formal installation approval belongs to the later human acceptance step.

## Evidence levels

| Capability | Current evidence before T21 | Required before a full-delivery claim |
| --- | --- | --- |
| Protocol, review gates, recovery, metrics and fixed candidate | Single-ledger public v3 CLI replay with real isolated Git and simulated host/GitHub plus separate regression cases; final fixed candidate manifest and its replay remain to be recorded | Deliver the full graph through a native host, with remote CI on the actual acceptance target |
| DeepSeek Harness | T16 bounded native actor/source-loaded skill probe and contract cases; a separate bootstrap patch added durable L1 launch and the actual Codex main-session observer was run once in the coordinator. These are distinct observations, with no full software round or native unavailable proof | Verify each configured L1/L2/L3 route, bootstrap true L1, observe the actual main identity for this run, test stop/recovery, and finish the T21 round; block if a required route or observation is unavailable |
| Codex CLI | T18 bounded one-model route/actor/resume probe plus contract cases | Required L1/L2/L3 routes and full native round if selected |
| ZCode | T17 controlled bridge contract and generated script control flow | Callable native workflow bridge, compilation, bounded native run and full round |

The adapter [DeepSeek](adapters/README.md), [Codex](adapters/CODEX.md), and [ZCode](adapters/zcode.md) documents describe their narrower evidence. T20 software replay and isolated packaging do not by themselves prove a real end-to-end host run. T21 will publish its own native evidence and explicit gaps.
