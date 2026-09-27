# Codex CLI adapter

`codex.mjs` bridges the protocol 3 host operations to an installed Codex CLI. The three wrapper executables created by `install` implement `SPEC_DELIVERY_HOST_ADAPTER`, `SPEC_DELIVERY_HOST_OBSERVER`, and `SPEC_DELIVERY_SKILL_OBSERVER`. They all use one configuration and the workflow's durable request token. No wrapper edits `state.json`.

## Configure and probe

Create an absolute-path configuration outside the repository:

```json
{
  "schema": 1,
  "hostId": "codex-cli",
  "runtimeRoot": "/absolute/private/codex-adapter-runtime",
  "codexBin": "/absolute/path/to/codex",
  "codexHome": "/absolute/path/to/.codex",
  "workflowEntry": "/absolute/path/to/spec-delivery.workflow.ts",
  "routes": [
    { "requestedModel": "L1-model", "cliModel": "actual-cli-model", "provider": "openai", "model": "actual-cli-model" },
    { "requestedModel": "L2-model", "cliModel": "second-cli-model", "provider": "openai", "model": "second-cli-model" },
    { "requestedModel": "L3-model", "cliModel": "third-cli-model", "provider": "openai", "model": "third-cli-model" }
  ]
}
```

`requestedModel` must equal the workflow's configured L1/L2/L3 value. `cliModel` is passed to `codex exec -m`; `provider` and `model` must match the native session records. A provider qualified request can therefore map to a CLI model name without treating the request string as evidence. The main Codex session can use another model. It never substitutes for an L1 actor.

Run these commands before claiming any model route:

```sh
node spec-delivery/adapters/codex.mjs probe /absolute/config.json
node spec-delivery/adapters/codex.mjs probe-models /absolute/config.json
node spec-delivery/adapters/codex.mjs install /absolute/config.json /absolute/private/wrappers
```

`probe` checks the callable CLI interface and reports route proof status. `probe-models` makes one bounded, read-only native call per configured model. It stores raw JSONL events, the CLI version, exit status, thread ID, and matching `session_meta.model_provider` plus `turn_context.model` proof. A help page or accepted `-m` option alone does not mark a route verified. A changed CLI version invalidates the proof. A failed route cannot start a business job. Set the three `SPEC_DELIVERY_*` variables to the returned wrapper paths, then use the public workflow `init/plan/next/dispatch/collect` commands. The plan's `capabilities.framework` must equal `hostId`, and its model list must contain the verified routes.

## Dispatch and evidence

`query` returns `not_found,authoritative:true` only when the token has no local intent directory. `start` creates that directory before spawning a detached worker. If the response is lost, use the same token and `query`; an existing directory is never launched again. A partially written intent, ambiguous native event, missing provider/model, process exit without a terminal event, or model mismatch yields `unknown`. The workflow records the raw reply as `uncertain` and retains the lease. `collect` only returns a result file after Codex reports a completed turn and a final message exists. The workflow itself archives the original bytes, verifies the receipt, and consumes the job.

The bridge checks native JSONL `thread.started`, the matching rollout's `session_meta.model_provider`, and the current turn's `turn_context.model`. For continuation it runs `codex exec resume <prior-thread-id> -m <route>` and requires the same thread plus a new native turn. A fresh or other independent job runs a new `codex exec` and rejects reuse of an older thread. If the CLI cannot provide these records, no identity is signed. `codex queue` is not used as a status or stop API; its help page does not prove either capability.

The Codex CLI does not expose a verified native explicit Skill entry through this adapter. `skill-start` therefore reports `source_execution`; `skill-open` reads every pinned source file and dependency byte, and `skill-complete` records the raw result before `skill-finish`. The observer signs the loaded file hashes, actual `source_execution` mode, original actor ID, and terminal marker. Professional child tasks still use `skill-delegate/skill-continue` and the same dispatch budget. The original installed `implement` and `handoff` files are read through their bindings without modification.

When a requested continuation cannot be proved, the worker does not claim `resumed`. The workflow's context gate requires the original actor's bound `handoff` plus `context-handoff`, or the narrowly supported `context-reconstruct` path after trustworthy unavailability evidence. This CLI adapter reports persisted sessions as available and does not manufacture an `unavailable` finding.

For stopping, use `dispatch-cancel` or `recover-result` with the current token/revision. The adapter requests process-group termination; only a confirmed stopped group is reported as `cancelled`. The workflow's separate `reconcile` and `processTreeStopped` proof still control lease release. For wrong binding and malformed receipts, use `recover-result` kinds `correct-binding`, `revise-receipt`, or `prepare-repair` with their required native events and source bytes. This adapter reports `continuationSupported:false`; independent `prepare-repair` is the supported receipt repair path. Never restart a completed implementation, comment, push, or merge to fix a receipt.

## Evidence levels on 2026-09-27

| Capability | Contract test | Bounded native result | Full spec round |
| --- | --- | --- | --- |
| CLI interface and model route | Passed | `codex-cli 0.154.0`; `gpt-6-astra` completed with `openai/gpt-6-astra` in native rollout. `gpt-6-luna` was explicitly rejected for this CLI account. | Not run |
| Durable token, query, per-job collect and native identity | Passed with controllable CLI | One read-only actor reached `running` then `completed`; original result and native thread/provider/model were observed. | Not run |
| Continue and independent fresh | Passed with controllable CLI | `exec resume` returned the prior thread and a new turn with `resumed` proof; the first actor used a new thread. | Not run |
| Bound skill and child execution | Source-loading contract passed | No real native skill/subtask round; native explicit Skill mode unavailable through this bridge. | Not run |
| Stop, binding correction, receipt repair, handoff | Stop contract plus workflow recovery tests | No real stop or repair injection in the bounded actor probe. | Not run |

These checks establish a callable bridge and a limited native route. They do not establish end-to-end software delivery, CI, GitHub operations, production suitability, or availability of any other model. If a required model probe fails, retain its failure evidence and stop before L1 planning rather than replacing it with a persona or the main session's model.
