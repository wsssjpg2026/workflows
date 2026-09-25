# Spec Delivery

由 L1 主 agent 驱动的 TypeScript 工作流，交付当前 GitHub 仓库中**已经存在的 spec 和 sub-issues**。入口为 [spec-delivery.workflow.ts](../spec-delivery.workflow.ts)；执行者按 [roles.md](roles.md) 读取共同约束、自己的角色和回执格式。

运行环境：Node.js 24+、Git、已授权的 `gh`，以及能执行命令、读写文件、选择指定模型并查询任务状态的 agent 宿主。核心维护依赖、队列、资源与证据门禁；模型由宿主真实调用。退出主会话不会自行唤醒后台模型。

## 启动只需五项

在目标仓库中向实际使用 L1 的主 agent 说明：

> 读取并执行 `~/.agents/workflows/spec-delivery.workflow.ts`。完成 spec #编号，合并到目标分支。L1 使用模型一，L2 使用模型二，L3 使用模型三。其它安排由你决定。

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

1. `init <input.json>`：在目标仓库初始化，取得 `statePath` 和原始来源。已有运行返回原账本。
2. `plan <state> <plan.json>`：L1 提交执行图、验收映射、能力检查与资源预算。类型见 [core.ts](core.ts) 的 `ExecutionPlan`。
3. `drive <state>`：收取已完成 actor 的结果，在有界步数内推进确定性命令，返回所有尚未派发 jobs 和 packet 路径。命令任务包含认领、验证、关闭与清理；主控不能只关注原生 agent 批次。
4. 按 job 的 `model/fresh/contextKey` 派发，取得真实宿主身份后立即绑定。完成事件到达即推进下一次 `drive`，独立工单无需等待整个批次结束。
5. 无可运行 job 时，查询在途任务或按退避等待 CI。明确阻断、等待人工、用户暂停或完成时返回相应状态，避免空轮询。

`next <state>` 是只预留、不执行命令的底层接口；它也会返回之前未派发的租约。`execute <state> <jobId>` 执行单个核心签发的确定性 job。主控操作状态的读改写由 CLI 加锁；actor 通过宿主 `stage` 返回内容，不直接编辑账本。

同一运行可并行计划、实现多张工单。候选完成实现后排队，优先让能解除下游依赖的工单进入队首，同时限制插队次数。**从集成基线、作者自检、验证、发布、regular/fresh review、验收到合并，只有队首候选推进。** 其它候选到队首再集成最新目标分支，避免同批合并使其它候选的完整审查反复失效。队列仅约束本运行；真实外部更新仍会撤销旧证据，连续失效进入有限重规划。

## 宿主适配与逐项回执

**ZCode**：先读取本机 `dynamic-workflows` 技能。`zcode <state>` 为已预留的同模型 jobs 生成原生脚本、`CreateWorkflow` 参数和 `binding` 模板。实际调用后，把返回的 `runId` 加入模板并调用 `bind-batch <state> <binding.json>`。身份格式为 `{runId,model,jobs:[{jobId,actorName}]}`。响应不确定时先查询原生运行，不能重新启动同一批。

每个 actor 返回 `{resultJson,summary}`。生成脚本在该 actor 的 `ask` 完成后立即调用 `world.run` 执行 `stage`；宿主持久化结果、补入任务和模型身份、核对证据，再提交核心。actor 只负责语义结果和真实证据，不必写 `result.json` 或抄写模型 ID。先完成后绑定的结果会暂存，绑定时收取。`world.run` 日志回放不等于重新观察 GitHub。

**其它支持指定模型的宿主（包括 Codex）**：对已返回的 job 调用真实 agent 工具，以 `bind <state> <jobId> <binding.json>` 记录 `{nativeId,model}`。任务真正完成后，由宿主把语义 Result 交给 `stage <state> <jobId> <result-json>`；这是 JSON 内容参数，应使用参数数组传递。旧的 `submit <state> <jobId> <result.json>` 仍可用，但需要完整 Result 身份。当前宿主无法选择指定模型或查询任务时明确阻断。

同模型且宿主确实支持恢复上下文时使用 `contextKey`；跨模型、跨 ZCode run 或不可恢复时读持久化 handoff。fresh 始终使用新上下文。packet 只内联当前证据索引；有历史需求再按 `historyIndexPath` 读取，避免每轮复制所有旧结果。fresh 初审排除旧结论，完整 diff 和原始证据仍须读取。

`collect <state>` 批量收取已完成、已绑定的暂存结果，并共享一次易变事实观测。检查返回的 `rejected[]`；被拒绝的原始结果会保留，不能覆盖成成功。主控核对错误、候选和原生终态后决定恢复或重派。`stage` 的存在须来自宿主完成事件，不能靠扫描 actor 自行写出的文件判定任务完成。

## 测试与 GitHub 观测

所有 agent 的测试/构建/重型核验通过 `test <state> <jobId> <request.json>` 执行，请求格式 `{argv,timeoutSeconds,env?,reason}`。cwd 为任务 worktree。测试配额按实际执行占用；不足时等待，不改用未登记的旁路命令。退出码、候选、日志和失败证据保留，完成后释放配额。最终 spec 审计的测试会临时建立冻结目标 SHA 的 detached worktree，完成后清理干净的审计目录；`candidateStable:false` 的结果不能用于验收。确定性 `verify` 直接使用核心预留的配额。该协议依赖宿主和角色遵守，无法限制框架外的任意 shell 进程。

普通观测批量读取目标 SHA、issue 状态和 PR 候选；正文、评论、依赖由需要它们的角色读取。验收、合并和最终审计重新获取适用 CI，合并 actor 操作前调用 `guard <state> <jobId>`。只读瞬时网络故障有界重试，权限/不完整响应明确失败；外部写操作先查状态，不盲目重试。

作者双轴、L2 五视角 regular/fresh 和独立验收均保留；问题确认门槛仍为 **≥50**。同一候选的判定跨过门槛时，由新的 L1 依据原始证据裁决。CI 未配置或有证据的计费未启动才可按角色规则豁免；实际执行失败不可豁免，并回到 L3 修复。CI 仍在正常执行时保留队首、等待状态事件；长期环境阻断由 L1 对账、重规划或释放队首，不能改成通过。

## 中断、迁移与退役

`inspect <state>` 查看账本。先查询原生执行者和子进程，再提交 `reconcile <state> <host-status.json>`：数组项为 `{jobId,nativeId,state,evidencePath,userStopped?}`，state 为 `running/stopped/lost/completed`。真实运行保留租约；完成则提交原结果；确认终止才取消。中断测试/命令需核对整个进程树，并提供 `processTreeStopped:true` 及证据；父进程消失本身不证明测试已停止。命令要恢复同一 job 时指定 `commandDisposition:"recover"`；选择 `"cancel"` 或省略则取消租约，保留已有结果、意图和资源，随后可退役或改模型。

确定性命令先保存结果再提交状态。同一 job 的命令进程已退出且结果存在时，`execute/drive` 使用原结果恢复；不会重跑已完成验证。认领使用预期基线 SHA 创建 branch/worktree，并用稳定评论标记对账。若命令退出但没有结果，`drive` 返回 `recoveryRequired`；L1 先确认其子进程和不确定远端动作，再用上述 recover 对账授权恢复。锁等待有界；锁的恢复者自身异常退出时，L1 核对 `.lock.recovery` 的持有者后恢复，不能删仍在使用的锁。

旧版运行可以直接 `inspect/metrics`，也可用 `bind/stage/collect/submit` 登记原租约已经完成的结果；继续新派发前先对账并排空在途任务，再执行 `upgrade <state> <evidence.json>`，内容为 `{evidencePath}`。迁移保留全部原结果和已完成工单，未完成验证从队列重新获取证据，不混用旧版部分审查。查看已完成的历史运行无需迁移。

`reconfigure <state> <models.json>` 在无在途任务时调整路由，文件为 `{models,capabilities,evidencePath}`；保留已完成任务的原模型与证据，仅新派发使用新模型。`retire <state> <reason.json>` 需要 `{reason,evidencePath}`，要求已停止所有任务；保留证据和未交付资源，常规调度无法复活它。

`resolve <state> <decisions.json>` 接收 L1 取得新事实后的 `[{ticket,evidencePath,handoffPath}]`，只解除无在途任务的局部阻断，回到认领或重规划。用户要求继续时使用 `resume <state>`；它不自动消除工单阻断或人工条件。

## 完成、指标与验证

PR 合并并且关联 issue 关闭后清理登记的本地/远程分支和 worktree；保留未提交、未推送或仍被使用的工作。父 spec 由独立 L1 审计。软件缺口走相同收尾循环；必须人工的验收留下可操作交接，既有人工单和父 spec 保持打开。

`metrics <state>` 输出阶段数量、候选失效、队列和观测指标。`record-host <state> <observations.json>` 可追加真实宿主的 `{jobId,nativeId,evidencePath,startedAt?,usage?}`。未取得的模型时间、token、费用为未知；绑定时间不能充当模型开始时间，`ghInvocations` 不是 HTTP 请求数。

本地验证入口为 `npm test`。覆盖状态转换、并行队列、逐项回执、恢复、配额和隔离 Git 工作区；GitHub 故障通过外部接口模拟。批量查询另已用真实测试仓库只读验证。生成脚本的本地 facade 控制流测试不等于 ZCode 原生编译/provider 端到端通过；新版真实运行耗时仍需下一次 ZCode 测量，不能预先宣称从 7 小时 34 分钟降到某个数值。
