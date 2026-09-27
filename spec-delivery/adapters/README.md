# DeepSeek Harness adapter (v0.3 candidate)

`dsh.mjs` implements the workflow's host, native-session observer, and bound-skill observer protocols. It accepts an immutable dispatch request from the workflow and creates one isolated DSH home per token. The adapter has no repository, issue, target branch, role model, or run-directory defaults. The workflow owns the ledger; the adapter never edits `state.json`.

## Configure and install in an isolated directory

Use Node.js 24+, `dsh` and `zstd`. Keep the config outside the repository and readable only by the host account. Each route's settings file must select the same provider/model that its entry declares; the observer checks the actual native session events before the workflow binds the job. A routed model ID can contain both provider and model segments.

```json
{
  "schema": 1,
  "hostId": "<the plan's capabilities.framework>",
  "runtimeRoot": "/absolute/private/adapter-runtime",
  "legacyRuntimeRoot": "/absolute/old-dsh-actors",
  "migrationExternalObserver": "/absolute/trusted/external-action-observer",
  "dshBin": "/absolute/path/to/dsh",
  "zstdBin": "/absolute/path/to/zstd",
  "credentialsFile": "/absolute/private/credentials.yaml",
  "workflowEntry": "/absolute/isolated/candidate/spec-delivery.workflow.ts",
  "routes": [
    {
      "requestedModel": "<one of the L1/L2/L3 model IDs>",
      "provider": "<provider observed in DSH events>",
      "model": "<model observed in DSH events>",
      "settingsFile": "/absolute/private/route-settings.yaml"
    }
  ],
  "startWaitMs": 10000,
  "taskTimeoutMs": 900000,
  "sourceExecution": true
}
```

Add one `routes` entry for each distinct requested model. The credentials file is symlinked into each private DSH home; the route settings file is copied there. The config, credentials, runtime, session logs, stdout and stderr must remain outside the candidate/source tree and out of published reports. `permissionMode` and `profile` are optional host settings; the default profile is `headless`. `sourceExecution:false` disables source-loaded skills when the host cannot provide them.

The synthetic `adapterProbeTask` packet field is accepted only when a disposable test config explicitly sets `allowProbeTask:true`. Leave that setting absent in a workflow run.

```sh
node /absolute/isolated/candidate/spec-delivery/adapters/dsh.mjs probe /absolute/private/config.json
node /absolute/isolated/candidate/spec-delivery/adapters/dsh.mjs install /absolute/private/config.json /absolute/isolated/candidate/bin
export SPEC_DELIVERY_HOST_ADAPTER=/absolute/isolated/candidate/bin/dsh-host
export SPEC_DELIVERY_HOST_OBSERVER=/absolute/isolated/candidate/bin/dsh-observer
export SPEC_DELIVERY_SKILL_OBSERVER=/absolute/isolated/candidate/bin/dsh-skill-observer
export SPEC_DELIVERY_MIGRATION_OBSERVER=/absolute/isolated/candidate/bin/dsh-migration-observer
export SPEC_DELIVERY_MAIN_OBSERVER=/absolute/isolated/candidate/spec-delivery/adapters/codex-main-observer.mjs
```

`probe` checks executable availability and route-file presence **without starting a model**. Its `nativeRouteVerified:false` is intentional. `install` writes four wrappers in the specified output directory; it does not replace a live installation. Use the same fixed candidate copy of the workflow, adapter and skill bindings for one run. Run `node <workflowEntry> version` and `npm test` from the candidate before using it.

`legacyRuntimeRoot` is needed to query old DSH homes and is the parent of their `runs/<legacy-run-id>` directories. `migrationExternalObserver` is needed whenever external action state cannot be ruled out from native evidence. It is a separately trusted, read-only executable called as `settled <state>` with the migration challenge/context on stdin; it must query external action state and echo the challenge, run ID, inventory/ledger hashes, current `observedAt`, `source:"native_host"`, `state:"settled"`, and `unknown:0`. Without this executable, the DSH observer reports `settled` only for an isolated ledger consisting solely of finished `review-lens` agents with **zero native `tool/call` events**, no command/test/dispatch job or PR intent, and no other jobs. All other runs return `unknown` and block. A failed, stale, or pending external query also blocks. Keep these paths outside the candidate tree; do not supply operator-written booleans as a substitute.

The installed `dsh-migration-observer` reads the **existing** old native session log (one exact session ID), requires a complete zstd frame, native `turn/end`, `finished-at`, and `exit-code:0`, and checks current Linux `/proc` for a process retaining that run's `DSH_HOME`. The old runner did not record a process group: an old session containing any `tool/call` may have left an untracked child and remains `unknown`. A native response-only old session can migrate if the separate external-action query also proves settled. Current adapter token manifests are queried through their existing durable identity. The observer also refuses ambiguous/missing native evidence and any untracked command, test, or dispatch PID; an exited parent PID alone does not prove its descendants stopped. This is a read-only query; it never launches or cancels an actor. Use `migration-context` and `upgrade` as described in [MIGRATION.md](../MIGRATION.md). Old homes with tool calls or unknown descendants and any unqueryable external action remain blocked until stronger host evidence exists. Codex and ZCode historical migration remains unsupported.

## Pre-plan L1 bootstrap and coordinator observation

`init` does not create a normal job for `$spec:execution-plan`. Before `plan`, create a private bootstrap request with a stable token. `promptPath` must tell L1 to read the current `plan-context <state>` result, parent spec and actual sub-issues, then author an `ExecutionPlan` JSON with `inputVersion` and `sourceVersion`. The adapter appends `decisionNativeId` and `evidencePath` from the native DSH session and its exact final response. Do not ask L1 to invent those proof fields. `plan` independently refreshes the sources and queries the DSH observer again.

```json
{
  "schema": 1,
  "token": "<stable-private-token>",
  "jobId": "$spec:execution-plan",
  "targetHost": "<configured-hostId>",
  "requestedModel": "<configured-L1-route-ID>",
  "worktree": "/absolute/entry-worktree",
  "promptPath": "/absolute/private/l1-plan-prompt.txt",
  "outputDirectory": "/absolute/private/new-plan-output-directory"
}
```

```sh
node <workflowEntry> plan-context <state> > /absolute/private/plan-context.json
node <adapter>/dsh.mjs bootstrap <config.json> query <request.json>
# Call start only after an authoritative not_found; keep the same token and request bytes on retries.
node <adapter>/dsh.mjs bootstrap <config.json> start <request.json>
node <adapter>/dsh.mjs bootstrap <config.json> collect <request.json>
# When collect says completed, use its planPath:
node <workflowEntry> plan <state> <returned-planPath>
```

The adapter persists the token, prompt bytes and route settings before spawning DSH. A lost `start` response is reconciled by `query` with the same request; it never launches a second session for that token. `collect` returns `planPath`, `planSha256`, `rawSha256`, native ID and raw usage only after a completed DSH process, one observed provider/model route, and matching plan/raw artifact hashes. Invalid or changed output stays `unknown`, preserving the native instance for inspection. Keep the private prompt, settings, output and runtime out of the repository and published evidence. This bootstrap starts an L1 planning session; it does not bypass the public `plan` validation.

`SPEC_DELIVERY_MAIN_OBSERVER` is a separate trusted executable used only for `observe-main <state> <native-id>`. The supplied `codex-main-observer.mjs` reads the **actual current** Codex coordinator rollout selected by `CODEX_SESSION_ID` and `CODEX_THREAD_ID`, requires both IDs to match the requested native ID, and emits only provider/model, observation time and hashes of the session and latest turn metadata. It does not emit prompts or full logs. It rejects a subagent session, an arbitrary probe session, a missing rollout, or a different requested ID. Run `observe-main` from the real coordinator with its actual `CODEX_SESSION_ID`; when that environment or trusted native log is unavailable, leave main identity unknown and stop any acceptance that requires proof of a different main model. Ordinary DSH jobs and L1 plans continue to use `SPEC_DELIVERY_HOST_OBSERVER`.

## Dispatch, skills, and recovery

After `init` and a real L1 `plan`, use `drive <state>` or `dispatch <state> <jobId>` with the three environment variables above. The workflow persists the token, attempt, target host and packet before calling `query`, then calls `start` only after an authoritative `not_found`. The adapter creates the token home and manifest before spawning DSH. `query` after a lost response returns the same native session; it cannot start a second session for the token. Once DSH emits a model event, the reply includes its native ID. The workflow immediately calls the session observer, checks the actual provider/model/context, binds that job, and collects each completed actor independently. The adapter returns raw DSH usage events and native times for the instance journal, including instances that fail binding.

For ordinary jobs, the actor writes one Result JSON object to the packet's exact `resultPath` (`outputDirectory/result.json`) and cites that path in its final message. DSH final text is preserved privately with the native session log, but it is not a second result source. The adapter snapshots the packet and requires the result path to be absent before native launch. It returns the designated file only after exit code 0, a complete native log and `turn/end`, a matching observed route, and a stable file hash. A file that appears while the actor is running does not establish completion. Missing, preexisting, linked or changed files and failed native exits remain `unknown`. The workflow archives and validates the exact file bytes after that terminal gate, including malformed JSON for formal receipt repair.

The installed DSH headless surface has no demonstrated same-context resume command. The adapter therefore reports `continuationSupported:false` and a genuinely new context ID for every launched actor. For an author or regular continuation, let the original actor invoke the bound `handoff` skill while it is available. The original handoff writes first to an OS temporary file; `skill-finish` archives those exact bytes. A separate L1 session then verifies the archived original with `context-handoff`; the next actor reads that reference. If the original actor is unavailable, `context-reconstruct` requires a native `availability: unavailable` proof. This DSH headless adapter has no demonstrated interface that proves an actor cannot resume, so its `availability` call fails explicitly and reconstruction stops. Do not infer unavailability from a missing process, or claim a DSH context resume from matching `contextKey` text.

For a bound skill, the actor calls the public `skill-start` command. DSH has no verified native explicit-skill registration, so this adapter advertises only `source_execution`. `skill-open` reads the archived skill bundle, checks every file hash, writes the original files into the actor-specific runtime directory, and prints `SKILL.md`; the actor must read and follow it, including `skill-delegate` / `skill-continue` for requested child work. `skill-complete` records the raw output from that actor. Only then can the observer issue the terminal `source_execution` receipt used by `skill-finish`. A resumed invocation reloads the same bundle under the replacement actor's identity; old actor load/completion records cannot satisfy the new receipt. Implement and handoff source files are read only and are never rewritten by this adapter.

On uncertainty, inspect `inspect <state>` and the adapter's token run home, then use public `dispatch <state> <jobId>` to query the existing token. A dead worker without a durable completion marker stays `unknown`; do not relaunch the task under that token. For cancellation, call `dispatch-cancel` and reconcile the entire process group; without an observed native session identity, the adapter cannot assert a confirmed cancelled instance. For a rejected or malformed actor result, keep the archived raw bytes and use `recover-result` with the current revision/token/candidate facts. This adapter denies same-actor continuation, so use `prepare-repair` to create an independent receipt-only job when a corrected result is needed. `correct-binding`, `confirm-stop`, and `abandon` are also public `recover-result` decisions. Do not modify the workflow ledger or rerun the original business action to repair its receipt.

## Capability and evidence boundary

| Capability | Verified level in this ticket | Remaining proof |
| --- | --- | --- |
| Durable token query, one launch, independent collection | Adapter contract and a bounded real DSH actor; lost start response queried the same completed native ID and one session | Full workflow round and crash injection belong to T21 |
| Provider/model/native session and raw usage | Bounded real DSH actor observed one provider/model route and raw usage events | Every configured L1/L2/L3 route in a real round |
| Source-loaded skill | Adapter contract plus one real DSH actor executing `skill-open` and `skill-complete`; the observer returned a terminal `source_execution` receipt and the actor returned valid Result JSON | Public workflow skill-start/finish during a full native role task, original implement/handoff run, and child-skill completion |
| Native explicit skill call | Unsupported and not advertised | A real DSH registration API with verifiable source fingerprint |
| Pre-plan L1 bootstrap | Adapter/CLI contract and one bounded real GLM native route probe with one session, matching provider/model, terminal plan and usage | Full spec plan authored against current GitHub sources in T21 |
| Main coordinator observer | Actual Codex rollout metadata observer plus fixture CLI seam; ordinary jobs remain on DSH | Run from the real T21 coordinator session and verify model difference from L1 |
| Same-context resume | Unsupported and not advertised | A documented DSH resume API plus native proof |
| Handoff/new-context and formal receipt recovery | Core public CLI contract; this adapter reports a new context and supports independent repair packets | Native handoff/reconstruction and malformed receipt recovery in T21 |
| Stop/process-tree reconciliation | Controlled adapter contract only | Real native process-group stop and full workflow reconcile |

The bounded actor/skill probes used private local temporary evidence and no GitHub delivery. No full spec round, multi-route authorization, native explicit skill call, or production installation is claimed here.
