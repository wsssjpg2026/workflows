# ZCode workflow adapter (v0.3 candidate)

This adapter turns each durable v3 job into **one native ZCode dynamic workflow with one actor**. The top-level spec-delivery coordinator owns budgets, model routing, child jobs, candidate versions, handoffs and recovery. A skill may register child work through `skill-delegate`; the next top-level `drive` dispatches those children. Generated scripts never create a nested workflow or encode review axes, lens counts or score thresholds.

## Native-tool boundary

ZCode's `CreateWorkflow`, `GetWorkflowRun` and `ListWorkflowRuns` are application tools. The local `/usr/bin/zcode` executable opens Electron and does not provide a headless workflow API. This Codex environment has no callable ZCode workflow tools, so the adapter's default `probe` reports `nativeToolsAvailable:false` and `host query/start` return `unknown`. A ZCode host must supply a **trusted executable bridge** that invokes the real native tools and normalizes their observations. A bridge simulator is used in contract tests only. A `source:"native_host"` string in actor output is never accepted as native identity by itself.

The bridge is configured in a private JSON file, outside the repository:

```json
{
  "schema": 1,
  "hostId": "<plan capabilities.framework>",
  "runtimeRoot": "/absolute/private/zcode-runtime",
  "workflowEntry": "/absolute/isolated/candidate/spec-delivery.workflow.ts",
  "bridgePath": "/absolute/path/to/trusted-native-tool-bridge"
}
```

`bridgePath` may be omitted for a read-only gap probe. The bridge is invoked as `<bridgePath> <operation> <input.json>`; the adapter writes each private input file before the call. Required bridge operations are:

| Operation | Native source and required result |
| --- | --- |
| `capabilities` | Confirm callable `CreateWorkflow`, `GetWorkflowRun`, `ListWorkflowRuns`, authoritative `tokenLookup`, `nativeActorIdentity` and `observedProviderModel`. Merely finding the Electron launcher is insufficient. |
| `query` | Find a run by the stable token in its native name/metadata via `ListWorkflowRuns`, then inspect it with `GetWorkflowRun`. Return `{token,jobId,state,authoritative?}`; running/completed/cancelled also need `runId`, `actorName`, native times and optional raw usage. Completed needs `report:{kind:"spec-delivery-result",token,jobId,actorName,resultFile}`, taken from that actor's native report item. |
| `create` | Call `CreateWorkflow` with the persisted `createWorkflow:{name,path,subagent_model}` descriptor. Its name embeds the token hash. Return `{token,runId}` when known. Response loss may still mean the run exists. |
| `observe` | Re-read native run/actor/model/context evidence and return the workflow `NativeSession` observation for the exact `{nativeId,jobId}`. Provider/model must come from native facts, not the requested model echoed back. |
| `stop` | Request native stop; subsequent `query` must establish terminal cancellation before the workflow releases any resource. |
| `skill-capabilities`, `skill-result` | Report actual registered skill or source loading ability, then the terminal mode/version/actor receipt. `source_execution` must list every archived file loaded by that actor. |
| `availability` | Report whether an old actor can produce the original handoff. Reconstruction requires a trusted `unavailable` observation. |

Do not return authoritative `not_found` unless native discovery covers the requested token. If the bridge cannot disambiguate an attempted launch, return `unknown`. The adapter writes `launch-attempted.json` **before** `create`; after a lost response, `query` can recover the original run but `start` will never issue a second create for that token. An intent recorded before the marker is safely resumable because no native call has begun. One job per run lets the top-level `drive` collect fast jobs while slow jobs remain active, including different role models.

## Install and operate

```sh
node /absolute/isolated/candidate/spec-delivery/adapters/zcode.mjs probe /absolute/private/zcode.json
node /absolute/isolated/candidate/spec-delivery/adapters/zcode.mjs install /absolute/private/zcode.json /absolute/isolated/candidate/bin
export SPEC_DELIVERY_HOST_ADAPTER=/absolute/isolated/candidate/bin/zcode-host
export SPEC_DELIVERY_HOST_OBSERVER=/absolute/isolated/candidate/bin/zcode-observer
export SPEC_DELIVERY_SKILL_OBSERVER=/absolute/isolated/candidate/bin/zcode-skill-observer
```

After `init` and a real L1 plan, `next`/`drive` persist each request and token. `zcode <state>` shows the corresponding one-job `CreateWorkflow` descriptors and script paths for inspection; this read does not start native work. With a trusted bridge installed, `drive` or `dispatch <state> <jobId>` queries by token, starts only on an authoritative negative, observes native run/actor/model, binds immediately and collects the actor's raw result file at completion. A bridge host should load its installed `dynamic-workflows` skill before creating a run. The output path is under that job's packet `outputDirectory`; core verifies the terminal host event and file boundary before accepting bytes.

Every separate run starts a new actor context unless the native bridge proves a real resume. The current one-job generator uses new runs and advertises `continuationSupported:false`. For an author/regular successor, the original actor invokes the bound handoff skill, writes its original output to an OS temporary file, and completes `skill-finish`. A separate L1 session verifies the archived original via `context-handoff`; a new actor reads the forwarded reference. If the old actor is proven unavailable, use `context-reconstruct` with explicit unknowns. Fresh jobs are independent and receive raw source material from the packet.

For uncertain starts, run `dispatch <state> <jobId>` to query the same token. An unknown native state blocks relaunch. For stop, use `dispatch-cancel` and then `reconcile` with process/actor stop evidence. For malformed results, use the public `recover-result` revision flow, including `prepare-repair` when the original actor cannot reliably continue. Do not edit `state.json`, create a second run to “try again”, or call `bind-batch` for new v3 jobs. Original implement/handoff skill files remain unchanged; the generic skill observer records the actual mode and fixed fingerprint.

## Validation levels

| Level | This ticket |
| --- | --- |
| Adapter/facade contract | Passed with a controlled bridge: token lookup after lost create response, one run per token, two role models, native identity observation, fast/slow independent collection, stop uncertainty and skill mode/version checks. |
| Generated script control flow | Passed locally with a TypeScript-stripped facade simulation: one actor/report per script, no nested workflow or batch barrier. |
| Native ZCode compilation and bounded run | **Not executed.** No `CreateWorkflow`/`GetWorkflowRun` tool is exposed to this Codex process. The Electron launcher is not a substitute. |
| Full spec round | **Not executed.** It requires a native bridge and separate end-to-end acceptance. |

The adapter preserves raw bridge usage without synthesizing costs. The bridge must retain native snapshots and source IDs as restricted evidence; no credentials should be copied into reports or candidate source. Keep the candidate installation separate from any production ZCode workflow configuration.
