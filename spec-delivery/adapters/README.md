# DeepSeek Harness adapter (v0.3 candidate)

`dsh.mjs` implements the workflow's host, native-session observer, and bound-skill observer protocols. It accepts an immutable dispatch request from the workflow and creates one isolated DSH home per token. The adapter has no repository, issue, target branch, role model, or run-directory defaults. The workflow owns the ledger; the adapter never edits `state.json`.

## Configure and install in an isolated directory

Use Node.js 24+, `dsh` and `zstd`. Keep the config outside the repository and readable only by the host account. Each route's settings file must select the same provider/model that its entry declares; the observer checks the actual native session events before the workflow binds the job. A routed model ID can contain both provider and model segments.

```json
{
  "schema": 1,
  "hostId": "<the plan's capabilities.framework>",
  "runtimeRoot": "/absolute/private/adapter-runtime",
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
```

`probe` checks executable availability and route-file presence **without starting a model**. Its `nativeRouteVerified:false` is intentional. `install` writes only three wrappers in the specified output directory; it does not replace a live installation. Use the same fixed candidate copy of the workflow, adapter and skill bindings for one run. Run `node <workflowEntry> version` and `npm test` from the candidate before using it.

## Dispatch, skills, and recovery

After `init` and a real L1 `plan`, use `drive <state>` or `dispatch <state> <jobId>` with the three environment variables above. The workflow persists the token, attempt, target host and packet before calling `query`, then calls `start` only after an authoritative `not_found`. The adapter creates the token home and manifest before spawning DSH. `query` after a lost response returns the same native session; it cannot start a second session for the token. Once DSH emits a model event, the reply includes its native ID. The workflow immediately calls the session observer, checks the actual provider/model/context, binds that job, and collects each completed actor independently. The adapter returns raw DSH usage events and native times for the instance journal, including instances that fail binding.

The installed DSH headless surface has no demonstrated same-context resume command. The adapter therefore reports `continuationSupported:false` and a genuinely new context ID for every launched actor. For an author or regular continuation, let the original actor invoke the bound `handoff` skill while it is available. The original handoff writes first to an OS temporary file; `skill-finish` archives those exact bytes. A separate L1 session then verifies the archived original with `context-handoff`; the next actor reads that reference. If the original actor is unavailable, use the workflow's `availability` observation and `context-reconstruct` path, including explicit unknowns. Do not claim a DSH context resume from matching `contextKey` text.

For a bound skill, the actor calls the public `skill-start` command. DSH has no verified native explicit-skill registration, so this adapter advertises only `source_execution`. `skill-open` reads the archived skill bundle, checks every file hash, writes the original files into the actor-specific runtime directory, and prints `SKILL.md`; the actor must read and follow it, including `skill-delegate` / `skill-continue` for requested child work. `skill-complete` records the raw output from that actor. Only then can the observer issue the terminal `source_execution` receipt used by `skill-finish`. A resumed invocation reloads the same bundle under the replacement actor's identity; old actor load/completion records cannot satisfy the new receipt. Implement and handoff source files are read only and are never rewritten by this adapter.

On uncertainty, inspect `inspect <state>` and the adapter's token run home, then use public `dispatch <state> <jobId>` to query the existing token. A dead worker without a durable completion marker stays `unknown`; do not relaunch the task under that token. For cancellation, call `dispatch-cancel` and reconcile the entire process group; without an observed native session identity, the adapter cannot assert a confirmed cancelled instance. For a rejected or malformed actor result, keep the archived raw bytes and use `recover-result` with the current revision/token/candidate facts. This adapter denies same-actor continuation, so use `prepare-repair` to create an independent receipt-only job when a corrected result is needed. `correct-binding`, `confirm-stop`, and `abandon` are also public `recover-result` decisions. Do not modify the workflow ledger or rerun the original business action to repair its receipt.

## Capability and evidence boundary

| Capability | Verified level in this ticket | Remaining proof |
| --- | --- | --- |
| Durable token query, one launch, independent collection | Adapter contract and a bounded real DSH actor; lost start response queried the same completed native ID and one session | Full workflow round and crash injection belong to T21 |
| Provider/model/native session and raw usage | Bounded real DSH actor observed one provider/model route and raw usage events | Every configured L1/L2/L3 route in a real round |
| Source-loaded skill | Adapter contract plus one real DSH actor executing `skill-open` and `skill-complete`; the observer returned a terminal `source_execution` receipt and the actor returned valid Result JSON | Public workflow skill-start/finish during a full native role task, original implement/handoff run, and child-skill completion |
| Native explicit skill call | Unsupported and not advertised | A real DSH registration API with verifiable source fingerprint |
| Same-context resume | Unsupported and not advertised | A documented DSH resume API plus native proof |
| Handoff/new-context and formal receipt recovery | Core public CLI contract; this adapter reports a new context and supports independent repair packets | Native handoff/reconstruction and malformed receipt recovery in T21 |
| Stop/process-tree reconciliation | Controlled adapter contract only | Real native process-group stop and full workflow reconcile |

The bounded actor/skill probes used private local temporary evidence and no GitHub delivery. No full spec round, multi-route authorization, native explicit skill call, or production installation is claimed here.
