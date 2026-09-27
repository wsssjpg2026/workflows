# Spec Delivery

由任意合适的宿主主会话协调、真实 L1 会话决策的 TypeScript 工作流，交付当前 GitHub 仓库中**已经存在的 spec 和 sub-issues**。入口为 [spec-delivery.workflow.ts](../spec-delivery.workflow.ts)；执行者按 [roles.md](roles.md) 读取共同约束、自己的角色和回执格式。

运行环境：Node.js 24+、Git、已授权的 `gh`，以及能执行命令、读写文件、选择指定模型并查询任务状态的 agent 宿主。核心维护依赖、队列、资源与证据门禁；模型由宿主真实调用。退出主会话不会自行唤醒后台模型。

## v0.3 过渡范围

`version` 报告 `0.3.0`。新建运行写入协议 `3`，summary 继续输出独立的 `schemaVersion: 1`。协议 3 的 `v3.decisionRecords`、`skillInvocations`、`skillChildren` 和 `dispatchRecords` 分别持久保存 L1 决策、技能调用、技能子任务及宿主派发。当前阶段仍使用下文的旧审查流程。此仓库的开发候选不会自动更新正式安装版。

## 启动只需五项

在目标仓库中向宿主主会话说明：

> 读取并执行 `~/.agents/workflows/spec-delivery.workflow.ts`。完成 spec #编号，合并到目标分支。L1 使用模型一，L2 使用模型二，L3 使用模型三。将需要判断的工作派给实际角色会话；其它安排由 L1 决定。

宿主生成输入：

```json
{
  "spec": "<已有 spec 的编号或 URL>",
  "targetBranch": "<目标分支>",
  "models": {"L1": "<实际模型 ID>", "L2": "<实际模型 ID>", "L3": "<实际模型 ID>"}
}
```

仓库从 cwd 和 Git remote 识别。L1 读取完整 spec、sub-issues、blocked 关系和目标仓库规范，决定 agent 总预算、并行工单、测试批次和无进展上限。用户不填写内部路径、资源参数或 job ID。三档模型必须能真实选择；persona 不能替代模型路由。

## 主控执行步骤

命令统一为 `node <entry> <command> ...`；`help` 列出完整接口。以下文件均由宿主生成，用户无需逐步填写。

1. `init <input.json>`：在目标仓库初始化，取得 `statePath`、原始来源和 `decisionContext`。主会话身份能由宿主观测时记录，否则为 `unknown`。已有运行返回原账本。
2. `plan <state> <plan.json>`：真实 L1 提交执行图、验收映射、能力检查与资源预算。计划包含 `init` 或 `plan-context <state>` 返回的 `inputVersion/sourceVersion`，以及原生 L1 会话的 `decisionNativeId`。来源或模型配置变化后，旧计划会被拒绝。
3. `drive <state>`：收取已完成 actor 的结果，在有界步数内推进确定性命令，返回所有尚未派发 jobs 和 packet 路径。配置派发适配器时，它也启动新 agent 任务；命令任务包含认领、验证、关闭与清理。
4. 按 job 的 `model/contextIntent` 派发，取得真实宿主身份与上下文证明后立即绑定。完成事件到达即调用 `collect` 或 `drive`；独立工单和同批快 actor 无需等待慢 actor。
5. 无可运行 job 时，查询在途任务或按退避等待 CI。明确阻断、等待人工、用户暂停或完成时返回相应状态，避免空轮询。

`next <state>` 是只预留、不执行命令的底层接口；它也会返回之前未派发的租约。每个 agent 租约同时写入不可变的派发请求：job、attempt、随机 token、目标宿主、请求模型和 packet 路径。`execute <state> <jobId>` 执行单个核心签发的确定性 job。主控操作状态的读改写由 CLI 加锁；actor 通过宿主 `stage` 返回内容，不直接编辑账本。

同一运行可并行计划、实现多张工单。候选完成实现后排队，优先让能解除下游依赖的工单进入队首，同时限制插队次数。**从集成基线、作者自检、验证、发布、regular/fresh review、验收到合并，只有队首候选推进。** 其它候选到队首再集成最新目标分支，避免同批合并使其它候选的完整审查反复失效。队列仅约束本运行；真实外部更新仍会撤销旧证据，连续失效进入有限重规划。

## 宿主适配与逐项回执

### 已绑定技能的显式调用

新运行在 `init` 时固定 `implementation`、`diagnosis`、`authorReview`、`prReview`、`handoff` 五项默认绑定。默认 `authorReview` 指向仓库内版本化的 [`code-review` 包](review-skills/code-review/SKILL.md)，其双轴方法和报告格式由技能维护。状态中的 `v3.skillBindings` 记录每个 `SKILL.md` 的实际路径、原文和包内资源的 SHA-256 指纹；这不是新增用户输入。已绑定阶段获得显式调用授权，`disable-model-invocation` 不会被解释为要求用户再手动触发。原始 implement/handoff 文件只读，交接技能仍按原要求先写 OS 临时目录，再由宿主逐字归档。

宿主先为 actor 登记可核验的原生会话，再调用 `skill-start <state> <jobId> <request.json>`。请求只需 `{capability}`；CLI 通过绝对路径环境变量 `SPEC_DELIVERY_SKILL_OBSERVER` 指向宿主可信查询适配器，以 `capabilities <capability> <jobId>` 取得实际注册入口和源码执行能力。响应为 `{source:"native_host",jobId,capability,capabilities:{nativeExplicit?,sourceExecution?}}`，其中原生注册包含 `{entry,sourcePath,fingerprint}`。匹配绑定路径与指纹的原生注册存在时，返回 `native_explicit` 和入口名；否则只有宿主允许读入原技能及资源时返回 `source_execution` 和持久 `sourceArchivePath`。返回 `alreadyStarted:true` 时先查询原调用，不能重启。真正缺少两种入口时命令指出缺口；工作流不更改宿主全局技能策略。

宿主**实际完成调用**后保存原始产物、专业证据，以及 JSON 宿主回执 `{source:"native_host",invocationId,jobId,nativeId,observationId,mode,bindingFingerprint,terminal:true,nativeEntry?}`；适配器以 `result <invocationId> <jobId>` 返回该回执；CLI 归档宿主响应后调用 `skill-finish <state> <invocationId> <outcome.json>`。源码执行回执另列出逐文件 `{relativePath,sha256}` 的 `loadedFiles`。外围 outcome 为 `{status:"pass"|"changes_required"|"incomplete"|"skipped",blocking,rawOutputPath?,evidencePaths?}`。技能无需原生输出 workflow JSON；状态/阻断判断由执行者提供，适配层只核对身份、原始文件、完整性及版本。空白或缺失产物不能形成 pass；实现 job 的外层 Result 用 `data.skillInvocationIds` 关联 implement/diagnosis 与 handoff 的已完成调用，handoff 归档内容必须与原文相同。

TypeScript 宿主也可使用 `spec-delivery/skills.ts` 的 `invokeBoundSkill`：适配器提供 `capabilities` 与 `invokeNative` / `executeSource` 实际入口；函数先持久登记调用，再执行相应入口、校验宿主回执并收取结果。

实现 packet 携带 L1 批准的 `planPath`、`checksPath`、issue URL 和当前技能绑定。`implement` 内请求 `/code-review` 时，其 implementation 父调用使用 `skill-delegate` 登记一个 `skillCapability:"authorReview"` 子任务，并指定当前已提交的候选 head。该子任务调用绑定的审查技能及其专业子任务；`implementation` 父调用通过 `skill-continue` 读取完成结果。外层实现回执只引用 implementation/diagnosis 与 handoff，核心从父子调用账本复用恰好一次有效作者自检。诊断技能若没有内嵌审查，候选进入单个 `author-review` 补审 job。审查必须匹配候选、issue/spec 来源、仓库 Markdown 规范候选、计划/检查文件和技能包指纹；来源变动后旧证据撤销，`next` 重新派发补审。跳过或未完成的调用不能通过门禁。默认包的双轴独立方法留在技能文件；替代包无需改变调度算法。

### 技能子任务与续接

技能执行者可用 `skill-delegate <state> <invocationId> <children.json>` 登记一批专业子任务。文件为 `{children:[{key,instruction,tier,required?,independent?,skillCapability?,head?}]}`；同一父调用内 `key` 稳定且幂等，重新提交不同定义会被拒绝。`tier` 只可为 L1/L2/L3，实际模型始终取运行已确认的三档路由；请求中的其它模型字段会被拒绝。`skillCapability` 引用另一已绑定技能时，子任务记录其包和依赖的固定指纹，完成回执须引用该子任务内真实通过的 `skillInvocationIds`。实现类父任务可为已提交且干净的新候选指定 `head`；其它父任务沿用原候选。

`next` 在同一 agent/测试预算下预留 `skill-child` job，仍由 `dispatch` 或 `drive` 按持久 token 查询、启动和收取真实宿主身份。父 actor 活着时继续占一个 agent 槽位。每个子任务的 packet 包含父调用 ID、请求、候选版本和上下文约束；独立子任务必须有区别于父与兄弟的原生会话，fresh 父任务使所有子任务保持 fresh 和独立。子 actor 以 `completed`、`failed` 或 `incomplete` 回执；`skill-continue <state> <invocationId>` 读取每个请求的 job、实际模型、原生身份、结果与等待状态。技能可依据这些结果再 `skill-delegate` 下一批，因此拓扑与数量由技能决定。失败或确认停止的子任务只由 `skill-retry <state> <invocationId> <keys.json>` 显式重试，文件为 `{keys:["stable-key"]}`；已完成兄弟结果不重跑。父技能的 `pass` 或 `changes_required` 仅在全部在途子任务终结且必需子任务成功后采纳。

若父 actor 中断，先用宿主停止证明 `reconcile`。新预留的同角色、同候选 job 绑定原生会话后，以 `skill-resume <state> <invocationId> <resume.json>` 续接，文件为 `{jobId,evidencePath}`。命令复查当前宿主有相同版本的技能执行能力，并保留旧父身份、续接依据、已完成子结果和在途 child token。新 actor 从 packet 的 `skillResume`、原始技能归档和 `skill-continue` 的结果续接；`skill-start` 不会为同候选未完成技能重新开一套调用。此接口记录技能调用的续接关系，宿主上下文的实际恢复证明由上下文适配层提供。

维护者可在所有在途 job 对账结束后运行 `migrate-skills <state> <migration.json>`，文件含 `{expectedRevision,evidencePath,replacements:{capability:"/absolute/path/SKILL.md"}}`。它显式重新固定被替换技能及依赖，也能为早期缺少绑定的 v3 运行补齐默认来源；受影响候选的自检/审查/验收证据失效，旧调用与原始产物仍可审计。运行中发现指纹漂移会拒绝调用或采纳结果，不自动迁移。
### 可恢复的派发接口

可信宿主设置绝对路径 `SPEC_DELIVERY_HOST_ADAPTER`，指向可执行适配器。CLI 以 `<operation> <request.json>` 调用它；`request.json` 是已落盘的 `{token,jobId,attempt,targetHost,requestedModel,packetPath}`。操作包括 `query`、`start`、`collect`、`cancel`。每次调用的原始 stdout、stderr、退出码和时间会以只追加文件保存在 `host-events/`；账本持有摘要和路径。适配器不能直接修改 `state.json`。

`query` 应按 token 查询原生任务，返回 `{token,jobId,targetHost,state,nativeId?,authoritative?}`。`state` 可为 `not_found`、`running`、`completed`、`cancelled`、`unknown`。只有宿主能权威保证 token 不存在时才返回 `not_found,authoritative:true`。`start` 应先向宿主登记 token 与 job，再返回 `running` 或 `completed` 及稳定 `nativeId`；启动后响应丢失时，下次查询必须能找到同一实例。`collect` 返回 `completed`、`nativeId` 和 actor 的结构化 `result`，或指定 `resultFile`；完成事件也可在 `query` 或 `start` 中携带结果。两者并存时只采用结构化 `result`。`finalText` 是人类摘要，不作为第二份 JSON 来源。指定文件须位于本 job 的 packet `outputDirectory` 内。`cancel` 返回原生身份和终止状态；取消请求本身不释放工作区写权。运行中的回复可附 `startedAt`，终态可附 `completedAt/cancelledAt`、`continuationSupported` 与原始 `usage`。

`dispatch <state> <jobId>` 总是先查询 token，确认不存在后才启动。`collect <state> [jobId]` 按 actor 独立查询、绑定和收取，重复调用不会覆盖完成结果。原生身份与角色模型由 `SPEC_DELIVERY_HOST_OBSERVER` 再次查询核验；适配器回复中声称的模型或 caller JSON 中的 `source` 不能充当该观测。查询错误、身份不符、无法确认是否已启动或结果尚不可读时，账本记为 `uncertain`，保留实际实例和原始事件。后续按同一 token 查询；不能盲目启动另一个 actor，也不宣称跨宿主事务的 exactly-once。

### 回执修订与正式恢复

`stage <state> <jobId> <result-json>` 与 `stage-raw <state> <jobId> <raw-file>` 先逐字节归档原始回执，再依次检查宿主终态、结果出现、JSON/schema 和语义。畸形 JSON、非法转义、截断或代码块包装均保留原字节、SHA-256、来源和失败事件；`result.json` 只是可再生缓存。重复收取同一内容不会重复计失败预算，已经接纳的修订不能覆盖。

`recover-result <state> <decision.json>` 接受 `kind` 为 `cancel`、`confirm-stop`、`correct-binding`、`revise-receipt`、`prepare-repair` 或 `abandon` 的决定。共同字段为 `{jobId,expectedRevision,dispatchToken,attempt,expectedCandidateVersion,reason,evidencePath}`，均取自最新 `inspect` 与派发记录，并指向已存在的证据文件。`dispatch-cancel <state> <decision.json>` 是 `kind:"cancel"` 的兼容入口。取消只归档请求；`confirm-stop` 还需 `{observedState:"stopped"|"lost",processTreeStopped:true}`，并确认宿主实例与测试进程树停止后才释放租约。`correct-binding` 需 `{expectedNativeId,nativeId}`，新身份必须在当前 token 的实例日志中，并由原生会话查询再次核对真实模型；仍可能运行的旧实例还需完整进程树停止证明。

格式修订用 `kind:"revise-receipt"`，增加 `{previousRevisionId,rawPath}`。托管宿主还须提供 `continuationHostEvent`，指向当前 token 的后续 `query/collect/start` 原始事件；命令核对同一原生 actor 的续接能力、终态及权威结果字节。命令在锁内检查版本和原始修订，追加链接原件的新修订，只重新验证结果，不重新执行实现、推送、评论或合并。宿主无法可靠续接时，可用 `kind:"prepare-repair"` 加 `{previousRevisionId}` 登记独立 `repair-receipt` job；其 packet 带原始字节、错误、候选与预期 head/base，禁止工作区写入。按普通 `dispatch/collect` 收取该 job 的真实宿主身份和新回执，原 job 仍须通过全部门禁。候选变化或证据不足需按正常诊断和重规划处理。

**ZCode**：先读取本机 `dynamic-workflows` 技能。`zcode <state>` 为已预留的同模型 jobs 生成原生脚本、`CreateWorkflow` 参数和 `binding` 模板。实际调用后，把返回的 `runId` 加入模板并调用 `bind-batch <state> <binding.json>`。身份格式为 `{runId,jobs:[{jobId,actorName}]}`。CLI 以 `{runId}/{actorName}` 查询宿主观测。响应不确定时先查询原生运行，不能重新启动同一批。

每个 actor 返回 `{resultJson,summary}`。生成脚本在该 actor 的 `ask` 完成后立即调用 `world.run` 执行 `stage`；宿主持久化结果、补入任务和模型身份、核对证据，再提交核心。actor 只负责语义结果和真实证据，不必写 `result.json` 或抄写模型 ID。先完成后绑定的结果会暂存，绑定时收取。`world.run` 日志回放不等于重新观察 GitHub。

**其它支持指定模型的宿主（包括 Codex）**：对已返回的 job 调用真实 agent 工具，以 `bind <state> <jobId> <binding.json>` 记录 `{nativeId}`。任务真正完成后，由宿主把语义 Result 交给 `stage <state> <jobId> <result-json>`；这是 JSON 内容参数，应使用参数数组传递。旧的 `submit <state> <jobId> <result.json>` 仍可用，但需要完整 Result 身份。当前宿主无法选择指定模型或查询任务时明确阻断。

协议 3 的模型任务要求宿主设置绝对路径环境变量 `SPEC_DELIVERY_HOST_OBSERVER`，指向可信的原生会话查询适配器。CLI 以 `observe <nativeId> <jobId>` 调用它；适配器从宿主 API/原生事件返回 `{source:"native_host",observationId,jobId,nativeId,provider,model,observedAt}`。CLI 将原始响应追加归档到运行目录并验证 provider/model 与请求角色一致。`binding.json` 中自填 `model`、`source` 或证据路径没有证明力。路由 ID 可为 `provider/model`，例如配置 `deepseek-official/deepseek/deepseek-v4.1-flash` 对应观测 `provider=deepseek-official`、`model=deepseek/deepseek-v4.1-flash`。适配器的可信性和工具权限取决于宿主；无隔离能力时协议依赖宿主遵守角色边界，不宣称提示词形成强隔离。

`observe-main <state> <native-id>` 可记录当前主会话观测；省略或查询失败时 `init/reconfigure/resume` 记为 `unknown`。主会话观测不能代替 L1 计划、计划复核或审计证据。每个 L1 决策记录输入版本、作用范围、候选版本、产物路径及指纹和原生会话；每票计划与计划复核必须来自两个不同的原生会话。改变输入或产物后旧决策不能进入下一门禁。

`contextKey` 是宿主路由提示。每个模型 job 的 `contextIntent` 指明 `independent` 或 `continue`；作者实现/修复与 regular 同一审查职责可寻找前序 actor，计划复核、fresh、独立验收、重规划、裁决及最终审计要求新上下文。派发请求带前序 nativeId/contextId。可信 `SPEC_DELIVERY_HOST_OBSERVER` 的 `observe` 响应还须带 `context:{contextId,mode:"new"|"resumed",resumedFromContextId?,proofId}`；CLI 将原始响应归档，核对续接祖先或新上下文身份。`binding.json` 自填这些字段没有证明力。不能证明续接时，宿主创建新上下文，并经交接门禁后执行；未知身份不会被写成已续接。

原 actor 可用时，由该 actor 显式调用固定版本的 `handoff` 技能，原文先落 OS 临时目录，再由 `skill-finish` 逐字归档。后继新会话的 `context-handoff <state> <jobId> <verification.json>` 接收 `{invocationId,decisionNativeId,verificationPath,expectedCandidateVersion}`。`verificationPath` 是 L1 的 JSON 核验记录，绑定后继 job、当前候选 head/base、前序 job/head/base、原文归档路径与 SHA-256，以及原文实际引用的 `sourceLinks`。CLI 查询独立 L1 会话，登记决策，向后继者转发原文路径和核验引用；不会把 L1 摘要当作原始 handoff。后继从 packet 的 `contextReferencePath` 读取此引用，复核当前候选。

原 actor 已不可恢复时，宿主 `availability <nativeId> <jobId>` 必须返回 `state:"unavailable"` 的可信观测；然后 L1 可用 `context-reconstruct <state> <jobId> <reconstruction.json>`。请求包含 `decisionNativeId`、`expectedCandidateVersion` 和 `reconstructedPath`；重建 JSON 明确写 `kind:"l1_reconstructed"`、当前 job/候选、前序 job、`sourceLinks`、非空 `unknowns`、`suggestedSkills` 与理由。账本将其标为 `reconstructed`，保留原 actor 不可恢复证据。新会话在交接核验前不能启动其它绑定技能或提交结果。交接原文、核验文件及宿主观测的指纹变化会拒绝继续。

fresh 首轮 packet 只传原始 spec/issue 链接、候选 head/base/worktree、仓库规范路径及原始测试/视觉证据；不传作者交接、regular 判断、辩解或历史索引。独立审查完成后再比较历史。普通 packet 只内联当前有限索引；完整历史按 `historyIndexPath` 读取。

`collect <state>` 批量收取已完成、已绑定的暂存结果，并共享一次易变事实观测。检查返回的 `rejected[]`；被拒绝的原始结果会保留，不能覆盖成成功。主控核对错误、候选和原生终态后决定恢复或重派。`stage` 的存在须来自宿主完成事件，不能靠扫描 actor 自行写出的文件判定任务完成。

写任务以 `implemented` 或 `replan` 结束时，必须交回真实已提交的 `head/base` 和 `handoffPath`；`replan` 还需 `data.reason`。核心登记新候选、撤销旧审查和验收证据，然后让 L1 在同一 SHA 上重规划。未推送的新提交保留在任务分支和 `refs/spec-delivery/recovery/…` 中；远端旧 PR head 不会覆盖它。只读规划回执若仍引用旧 SHA 会被拒绝。

## Git 工作区恢复

未提交 WIP、未解决冲突、无回执的新提交或候选来源不明会让对应工单进入 `recovery` 阶段。`inspect` 和 `next.recoveries` 提供原因、观测 SHA、recovery ref 与快照路径。快照保存 Git 状态、索引冲突阶段、二进制补丁以及未跟踪文件和冲突文件的原始副本；原 worktree 不会被 reset、stash 或删除。正在运行的 actor 或测试仍占用资源，须先查宿主并以 `reconcile` 登记停止及 `processTreeStopped:true` 证据。未知执行状态不能释放工作区。

解决 WIP/冲突并提交之后，使用 `recover-workspace <state> <ticket> <decision.json>`。决定文件包含 `expectedRevision`、`expectedRecoveryHead`（可为 `null`）、`resolvedHead`、`resolvedBase`、`evidencePath`、`handoffPath` 和 `reason`。恢复 SHA 必须是干净的原任务分支 HEAD；若声明新的集成基线，它还必须是实时目标分支 SHA 且已包含于候选。若恢复提交不继承已保全提交，还需 `sourceEvidencePath` 核对来源。命令检查相关执行者和测试已停止，保留旧快照及新提交的 recovery ref，然后回到 `replan`；后续照常经过计划复核、实现与验证。运行处于 `paused` 时不会由此自动恢复派发。

## 测试与 GitHub 观测

所有 agent 的测试/构建/重型核验通过 `test <state> <jobId> <request.json>` 执行，请求格式 `{argv,timeoutSeconds,env?,reason}`。cwd 为任务 worktree。测试配额按实际执行占用；不足时等待，不改用未登记的旁路命令。退出码、候选、日志和失败证据保留，完成后释放配额。最终 spec 审计的测试会临时建立冻结目标 SHA 的 detached worktree，完成后清理干净的审计目录；`candidateStable:false` 的结果不能用于验收。确定性 `verify` 直接使用核心预留的配额。该协议依赖宿主和角色遵守，无法限制框架外的任意 shell 进程。

测试回执的 `candidate` 分别记录观察到的 `prHead`、`targetBase`、`localHead`、`testedHead`、`testedTree` 和适用时的 `integrationHead`。未提交工作参与测试时 `testedTree` 为 `null`，另记工作区内容指纹；不能把 Git HEAD 的树称为实际测试树。确定性 `verify` 对干净工作区记录真实 Git tree，候选变动则撤销旧测试证据。

普通观测批量读取目标 SHA、issue 状态和 PR 候选；正文、评论、依赖由需要它们的角色读取。验收、合并和最终审计重新获取适用 CI，合并 actor 操作前调用 `guard <state> <jobId>`。只读瞬时网络故障有界重试，权限/不完整响应明确失败；外部写操作先查状态，不盲目重试。

默认作者技能保留双轴自检。v3 的 PR 审查在 regular 和独立 fresh 两轮各执行一次固定版本的 `prReview` 绑定。默认包位于 `spec-delivery/review-skills/code-review-from-claude/`，其 `SKILL.md` 保留五视角、独立确认与 **≥50** 规则；`automation-context.md` 和 `automation-contract.json` 分别说明工作流输入/回执与必需子任务，完整包指纹写入运行账本。`pr-review` 归档原始报告与宿主终态，`review-report` 命令按稳定标记发布报告原文。核心只根据当前候选、技能版本及明确阻断结论推进；替代包可采用其它审查方法。通过两轮后仍须独立验收与 CI。CI 未配置或有证据的计费未启动才可按角色规则豁免；实际执行失败不可豁免，并回到 L3 修复。CI 仍在正常执行时保留队首、等待状态事件；长期环境阻断由 L1 对账、重规划或释放队首，不能改成通过。

## summary：离线只读摘要

`summary` 是运行账本的离线只读摘要：把调度状态压成紧凑投影，适合快速查看当前运行，或归档一份不需要完整历史的快照。它与完整账本和运行指标的用途不同：

| 命令 | 用途 |
| --- | --- |
| `summary <state>` | 离线只读摘要：工单与任务计数、运行状态，适合快速查看和归档快照 |
| `inspect <state>` | 完整账本：全部工单、jobs、事件、facts 等内部细节，用于诊断与对账 |
| `metrics <state>` | 运行指标：阶段数量、候选失效、队列与观测指标，用于复盘调度表现 |

用法：`node spec-delivery.workflow.ts summary <state.json>`。入口为 [spec-delivery.workflow.ts](../spec-delivery.workflow.ts)，输出一个 JSON 对象，主要字段：

- `schemaVersion`：摘要契约版本，当前恒为 `1`；
- `spec`：spec 编号；`targetBranch`：目标分支；`status`：运行状态（`planning`、`running`、`blocked`、`paused`、`waiting_human`、`complete`、`retired` 等）；
- `tickets`：`{total, done, human, blocked, pending}`；
- `jobs`：`{active, leased, running}`；
- `validationOwner`：当前持有验证队列的工单 key，没有则为 `null`。

计数语义：`pending = total - done - human - blocked`，即不处于 `done`、`human`、`blocked` 的工单（包括工作区 `recovery`、认领、计划、实现、验证和清理等阶段）都计入 `pending`；`active = leased + running`，只统计当前持有租约或正在执行的 job，`done`、`cancelled` 等终态不计入。恒等式为 `tickets.total = done + human + blocked + pending`。

与 `inspect`/`metrics` 相同，`summary` 豁免版本门禁：没有 `upgrade` 的旧账本和已经 `retire` 的账本都可直接读取。它只读取状态文件并输出摘要，不创建、等待或恢复锁，不进入写路径，不调用 GitHub，也不改变状态、历史或租约。

路径不存在、不是普通文件、不可读、内容不是合法 JSON 或结构不符合 `schema 1` 时，命令以非零退出并在 stderr 给出对应错误；可读性故障不会被说成 JSON 语法问题。

下面是合成数据，只用于说明输出形状，**不是本轮运行的实测结果**（spec 编号、目标分支与工单号都是虚构的，不要引用其中数值）：

```json
{
  "schemaVersion": 1,
  "spec": 42,
  "targetBranch": "codex/example-target",
  "status": "running",
  "tickets": { "total": 6, "done": 2, "human": 1, "blocked": 1, "pending": 2 },
  "jobs": { "active": 2, "leased": 1, "running": 1 },
  "validationOwner": "17"
}
```

示例形状与真实 `summary` CLI 在合成 fixture 上的输出一致；请以自己账本的实际输出为准。

宿主配置仍只需用户提供 spec、目标分支和 L1/L2/L3 三个模型，其它安排由 L1 决定（见上文「启动只需五项」）。运行记录方面，用 `record-host <state> <observations.json>` 保存真实的宿主任务身份（`nativeId`）与阶段时间；未取得的模型时间、token、费用保持未知，绑定时间不能当作模型开始时间（见下文「完成、指标与验证」）。

## 中断、迁移与退役

`inspect <state>` 查看账本。先查询原生执行者和子进程，再提交 `reconcile <state> <host-status.json>`：数组项为 `{jobId,nativeId,state,evidencePath,userStopped?,processTreeStopped?}`，state 为 `running/stopped/lost/completed`。真实运行保留租约；完成则提交原结果；确认终止才取消。中断任务 worktree 中的 agent、测试或命令时须核对整个进程树，并提供 `processTreeStopped:true` 及证据；父进程消失本身不证明工作已停止。命令要恢复同一 job 时指定 `commandDisposition:"recover"`；选择 `"cancel"` 或省略则取消租约，保留已有结果、意图和资源，随后可退役或改模型。

确定性命令先保存结果再提交状态。同一 job 的命令进程已退出且结果存在时，`execute/drive` 使用原结果恢复；不会重跑已完成验证。认领使用预期基线 SHA 创建 branch/worktree，并用稳定评论标记对账。若命令退出但没有结果，`drive` 返回 `recoveryRequired`；L1 先确认其子进程和不确定远端动作，再用 `reconcile` 对账授权命令恢复。锁等待有界；锁的恢复者自身异常退出时，L1 核对 `.lock.recovery` 的持有者后恢复，不能删仍在使用的锁。

旧版运行（无 `protocol` 或协议 `2`）可以直接 `inspect/metrics/summary`，也可用 `bind/stage/collect/submit` 登记原租约已经完成的结果；新派发由版本门禁拒绝。继续派发前先对账并排空在途任务，再显式执行 `upgrade <state> <evidence.json>`，内容为 `{evidencePath}`。命令先把原账本逐字节备份到返回的 `backupPath`，再迁移到协议 `3`；保留原结果与已完成工单，未完成验证从队列重新获取证据，不混用旧版部分审查。`paused` 和 `waiting_human` 状态保持原样，退役运行不能升级或复活。查看历史运行无需迁移；未知协议会明确报错。

`reconfigure <state> <models.json>` 在无在途任务时调整路由，文件为 `{models,capabilities,evidencePath,decisionNativeId,sourceVersion}`；真实 L1 重新确认资源和模型，旧工单计划与复核失效并进入重规划。主会话模型可以不同于新 L1；未取得当前主会话观测时记录为 `unknown`。`retire <state> <reason.json>` 需要 `{reason,evidencePath}`，要求已停止所有任务；保留证据和未交付资源，常规调度无法复活它。

`resolve <state> <decisions.json>` 接收 L1 取得新事实后的 `[{ticket,evidencePath,handoffPath,decisionNativeId,inputVersion,candidateVersion}]`，版本由只读 `decision-context <state>` 取得。CLI 查询真实 L1 会话，只解除无在途任务的局部阻断，回到认领或重规划。用户要求继续时使用 `resume <state>`；它不自动消除工单阻断或人工条件。

## 完成、指标与验证

PR 合并并且关联 issue 关闭后清理登记的本地/远程分支和 worktree；保留未提交、未推送或仍被使用的工作。父 spec 由独立 L1 审计。软件缺口走相同收尾循环；必须人工的验收留下可操作交接，既有人工单和父 spec 保持打开。

`metrics <state>` 输出阶段数量、候选失效、队列和观测指标。`record-host <state> <observations.json>` 可追加真实宿主的 `{jobId,nativeId,evidencePath,startedAt?,usage?}`。未取得的模型时间、token、费用为未知；绑定时间不能充当模型开始时间，`ghInvocations` 不是 HTTP 请求数。

本地验证入口为 `npm test`。覆盖状态转换、并行队列、逐项回执、恢复、配额和隔离 Git 工作区；GitHub 故障通过外部接口模拟。批量查询另已用真实测试仓库只读验证。生成脚本的本地 facade 控制流测试不等于 ZCode 原生编译/provider 端到端通过；新版真实运行耗时仍需下一次 ZCode 测量，不能预先宣称从 7 小时 34 分钟降到某个数值。
