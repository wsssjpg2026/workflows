# Historical run migration

The current execution path is `unified-v03`. Historical ledgers remain readable through `summary`, `inspect`, and `metrics` without taking the run lock or contacting GitHub. A ledger without `protocol`, with protocol `2`, or with the transitional protocol `3` marker cannot dispatch new work.

## Stop and inspect

Use the public CLI on the existing ledger:

```bash
node spec-delivery.workflow.ts summary "$STATE"
node spec-delivery.workflow.ts inspect "$STATE"
node spec-delivery.workflow.ts metrics "$STATE"
node spec-delivery.workflow.ts migration-context "$STATE" > migration-context.json
```

`migration-context` is also offline and does not alter the ledger. It lists every job status and native ID, dispatch token and instance, child request, current and recorded test PID, and open wait interval. Its `inventorySha256` and `ledgerSha256` bind the migration to both the relevant work inventory and the exact ledger bytes. Query the configured native host by each existing token/identity, collect completed results, and use `reconcile` or `recover-result` to settle actors and command processes. A dead parent PID alone is insufficient: confirm its descendants and external effects. `starting`, `running`, or `uncertain` dispatches, unknown or unbound instances, pending children, unaccounted test processes, and cancelled actors without process-tree stop confirmation block migration. Terminal native event files and recorded test receipts are rehashed during preflight.

Write an operator evidence file containing the actual host queries, process-tree inspection, and external-action disposition. Configure a **trusted executable** that queries the native host and OS again while the CLI holds the ledger lock:

```bash
export SPEC_DELIVERY_MIGRATION_OBSERVER=/absolute/path/to/your-host-migration-observer
```

The CLI invokes it as `observer quiescence "$STATE"`, sending a JSON request on stdin with `schemaVersion:1`, a random `challenge`, `runId`, and the complete `migration-context` including its two hashes. The observer must return JSON on stdout with `source:"native_host"`, the same challenge/run ID/hashes, and a current `observedAt`. It must **query**, rather than copy ledger status: return one `actors` row per native agent (`jobId`, `nativeId`, terminal `state`, unique `observationId`), one `dispatches` row per token (`token`, `jobId`, `targetHost`, `state`, `nativeId` for terminal or `authoritative:true` for `not_found`), one `instances` row per recorded native instance (`key`, `nativeId`, terminal `state`), and one `processes` row per command, dispatch, and recorded test PID (`jobId`, `kind`, `pid`, `state:"stopped"`, `descendantsStopped:true`). Each row needs a unique ID from the underlying query. The response also needs `processTree:{state:"stopped",unknownChildren:0,observationId}` and `externalActions:{state:"settled",unknown:0,observationId}`. The process-tree query must cover the run directory and all descendant/process groups, including historical tests whose PID was not retained by an older ledger. A surviving orphan or an unqueryable process is `unknown`, never `stopped`.

The CLI verifies exact row membership and terminal states against the locked ledger, checks the fresh challenge and hashes, and archives the complete observer response with a SHA-256 digest **after** copying the original ledger. A caller-written JSON, boolean flags, or a text note cannot substitute for this observer. `processTreeStopped` and `externalActionsSettled` in the decision record operator intent; they do not prove host state. The controlled observer in `migration-cli.test.ts` tests this contract against a separate simulated host-state file, including ledger-terminal/host-running and surviving-test-child cases. The bundled DSH, ZCode, and Codex adapters currently do not implement `quiescence`; no real historical migration is verified by these tests. Without a capable host-specific observer, migration stops before backup and leaves the ledger unchanged.

Create a decision JSON using the current `migration-context` values:

```json
{
  "schemaVersion": 1,
  "expectedRevision": 7,
  "inventorySha256": "<migration-context.inventorySha256>",
  "ledgerSha256": "<migration-context.ledgerSha256>",
  "evidencePath": "/absolute/path/to/host-and-process-observations.md",
  "observedAt": "<current ISO-8601 UTC time>",
  "statusIntent": "preserve",
  "processTreeStopped": true,
  "externalActionsSettled": true
}
```

The observation must be at most ten minutes old when the locked preflight runs. Revision, inventory, byte hash, missing evidence, or any in-flight state cause a nonzero exit before a backup or state write.

For protocol `1`/`2`:

```bash
node spec-delivery.workflow.ts upgrade "$STATE" migration-decision.json
```

For transitional protocol `3`, use the same fields plus `"replacements": {}` (or explicit skill paths):

```bash
node spec-delivery.workflow.ts migrate-skills "$STATE" migration-decision.json
```

Both paths copy the original state byte for byte into `migrations/pre-v3-*.json`, return `backupPath`, and record its SHA-256 in `state.migrations`. Completed jobs, results, provider/model observations, receipts, and prior source references remain in the new ledger. Old partial review, author, acceptance, and CI evidence cannot become a new skill pass; affected unfinished tickets return to `claim` or `replan`. `paused`, `waiting_human`, and `complete` remain unchanged. `retired` never migrates.

## Continue separately

Migration does not dispatch or resume. After reviewing the migrated state and resolving any still-open condition, a paused run needs a fresh decision with `kind: "user_resume"`; a waiting-human run needs `kind: "human_condition_resolved"` and `humanEvidencePath`. Both require the current `expectedRevision`, `expectedStatus`, `inputVersion`, nonblank `evidencePath` and `reason`, plus a `decisionNativeId` observed by the trusted host as `$resume` on the configured L1 model:

```json
{
  "schemaVersion": 1,
  "expectedRevision": 8,
  "expectedStatus": "paused",
  "kind": "user_resume",
  "inputVersion": "<decision-context.inputVersion>",
  "decisionNativeId": "<native L1 session ID>",
  "evidencePath": "/absolute/path/to/user-continuation.md",
  "reason": "User explicitly continued the inspected run"
}
```

Then run `node spec-delivery.workflow.ts resume "$STATE" resume-decision.json`. The CLI records the decision, source digests, and native session in `state.continuations`. It does not clear individual blocked tickets. A waiting-human run also requires all registered human tickets to be closed in a fresh GitHub observation. A complete or retired run cannot resume.

## Disposable CLI demonstration

`migration-cli.test.ts` creates an isolated protocol `1`/`2` fixture with a completed historical `review-lens` job and a partial regular review. It runs the four read commands, verifies their bytes did not change, generates a current decision, and calls `upgrade`. It checks that the backup hash equals the original bytes, the original `old-provider/old-model` session and result remain intact, the ticket returns to `replan` with no review pass, and status stays `paused`. The same test exercises transitional protocol `3`, all stop blockers, stale decisions, and explicit continuation. Run it with:

```bash
node --test spec-delivery/migration-cli.test.ts
```
