# Spec Delivery

由 L1 主 agent 驱动的 TypeScript 工作流，交付当前 GitHub 仓库中已经存在的 spec 及其子工单。入口是相邻的 [spec-delivery.workflow.ts](../spec-delivery.workflow.ts)，执行角色与验收规则见 [roles.md](roles.md)。

TypeScript 核心维护依赖、持久化状态、派发、资源预留和候选 SHA 门禁；宿主负责真实模型调用、工具执行和语义判断。它不是后台守护进程，也不是把一个 TS 文件交给任意框架就能原生执行的通用插件。

运行环境：Node.js 24+、Git、已授权的 `gh`，以及能执行命令、读写文件并选择指定模型的 agent 宿主。所需技能由主控检查是否可读取；这些能力检查不增加用户的启动配置。

在目标仓库中可以直接向主 agent 说：

> 读取并执行 `~/.agents/workflows/spec-delivery.workflow.ts`。完成 spec #编号，最终合并到目标分支。L1 使用模型一，L2 使用模型二，L3 使用模型三。其他执行安排由你决定。

## 启动只需五项

让实际使用 L1 模型的主会话读取本文件和角色规则，然后提供：

```json
{
  "spec": "<已有 GitHub spec 的编号或 URL>",
  "targetBranch": "<目标分支>",
  "models": {
    "L1": "<主控与计划模型的实际 ID>",
    "L2": "<独立审查与验收模型的实际 ID>",
    "L3": "<实现与修复模型的实际 ID>"
  }
}
```

仓库从 cwd 和 Git remote 识别，工单从 spec 的完整 sub-issues 与阻塞关系获取。L1 自主决定 agent 总预算、并行工单、测试批次与无进展上限；用户不填写这些参数或内部 job/packet 路径。已有信息直接复用，只补齐缺项。

启动时宿主检查实际主会话模型、三档模型可用性、指定模型派发、上下文恢复、运行查询和必要工具能力。无法真实选择要求的模型时明确阻断；角色名称和 persona 不能替代模型路由。

## 主 agent 执行协议

以下是内部命令协议，使用支持该入口的 Node 运行时；具体参数、JSON 结构和返回值以入口代码为准。用户无需手动操作每一步。

| 命令 | 主 agent 的职责 |
| --- | --- |
| `node <entry> init <input.json>` | 只传五项启动输入，在目标仓库 cwd 初始化；记录返回的状态路径 |
| `inspect <state>` | 读取状态、阻断与活动任务，再 live 核对 GitHub/工作区 |
| `plan <state> <plan.json>` | 提交 L1 从真实 spec、DAG、仓库规范与资源检查产生的计划 |
| `next <state>` | 取得可派发 job，读取其 `packetPath`，按 `tier/model/fresh/contextKey/action` 调用宿主 |
| `bind <state> <jobId> <宿主任务标识.json>` | 保存实际原生任务/run ID 和可核验的模型信息 |
| `submit <state> <jobId> <result.json>` | 提交真实执行结果、候选与证据；由核心决定后续阶段 |
| `execute <state> <jobId>` | 直接执行核心签发的 `verify` 或 `cleanup` 命令job，并自动保存、提交结果 |
| `guard <state> <jobId>` | 合并或关闭 spec 前重新观察远端并检查候选门禁；失败就重新验收 |
| `reconcile <state> <host-status.json>` | 用新取得的宿主状态处理中断、不确定派发和资源占用 |
| `resolve <state> <decisions.json>` | L1用新事实和持久交接解除无在途任务的局部阻断，回到认领或重规划 |
| `resume <state>` | 用户明确要求继续后，先核对在途任务，再恢复父级调度；不自动解除工单阻断 |
| `zcode <state>` | 将已预留的同模型agent jobs生成原生批次脚本和 `CreateWorkflow` 参数；该命令本身不启动ZCode |

表中 `<entry>` 指相邻的 TS 入口；后续各子命令同样由该入口执行。`next` 返回 `jobs[]` 和 `packetPath`；主控读取packet，按其 `executor` 分别执行自身认领、真实模型派发或 `execute`。Result与action对照见 [角色回执](roles.md#结果回执与动作字段)，无需用户手填。

状态、packet、检查与历史证据保存在初始化返回的 `.agents/workflow-runs/` 子目录；当前锁与恢复实现面向同一机器，不承诺跨主机同时调度。L1持续消费宿主完成事件并推进 `next`；进程退出后不会自行唤醒模型。恢复时先核对原生任务和远端动作，再继续，不能盲目重新派发。

等待 CI 时由主控使用宿主事件或有期限的退避查询，不重复派模型空转。正常执行失败仍回到修复，不能通过等待把失败改成豁免。`execute` 仅领取一次命令任务；进程中断后先确认原进程已终止，再通过 reconcile 生成新的执行尝试。

L1生成的`ExecutionPlan`包含`capabilities:{framework,mainModel,modelRouting,models}`、`policy:{agents,issues,tests,noProgress,rounds}`、完整`tickets`、`specCriteria`与`evidencePath`。`modelRouting`取`per_agent/per_run`；资源值由L1确定，agent总额包含主控。每个ticket携带`number/kind/dependencies/criteria/visual`，延期验收按核心类型保留两端记录；读取 [core.ts](core.ts) 的类型定义生成，不让用户填写。

绑定文件是`{nativeId,model}`，必须取实际宿主返回值。`host-status.json`是观察数组，每项含`jobId/nativeId/state/evidencePath`，state为`running/stopped/lost/completed`，用户主动停止可附`userStopped:true`；运行中保留租约，完成后提交原结果。接口检查身份与证据文件，但宿主模型和任务状态的真实性仍须主控核验。

`decisions.json`由L1生成，结构为`[{ticket,evidencePath,handoffPath}]`，其中ticket为状态中的工单key。先取得足以解除阻断的新事实，确认该票没有在途任务；`resolve`有worktree时回到`replan`，否则回到`claim`，不跳过计划复核和后续验证，也不覆盖用户暂停。人工补充结果写入既有工单后，由L1选择相应恢复命令。

## 宿主适配

- **Codex**：通过原生子 agent 工具指定真实模型。同模型且上下文可用时按 `contextKey` 继续已有 agent；模型改变或原上下文不可恢复时，建立新 agent 并读取交接文档。fresh job 始终使用新上下文。
- **ZCode**：将同模型的同批次 jobs 映射到生成的原生 dynamic-workflow 脚本，以 `CreateWorkflow.subagent_model` 设置 run 模型。当前生成器每job一个actor，跨批次/run用交接文档恢复；不能声称沿用同一物理上下文。每 actor/每 ask 选模型不属于其公开接口；需要先加载本机 `dynamic-workflows` 技能，并完成原生工具实际要求的确认。
- **其它框架**：先实现并检查模型选择、任务查询、结果提交和上下文能力，再消费相同协议。缺少能力时输出具体阻断，不静默降级为另一模型或普通文字回答。

检查、清理等确定性 job 使用受控命令执行，不占用一个虚构的“模型角色”。所有真实模型工作包括计划复核、作者双轴自检、独立五路审查与置信度复核，都显式派发并计入预算。

## 运行单元测试

在仓库根执行：

```bash
node --test spec-delivery/workflow.test.ts
```

需要 Node.js 24+：测试与被测的 `core.ts` 依赖原生类型剥离（type stripping）直接运行 `.ts`，无需预编译或安装额外依赖。当前共 16 项测试，覆盖 `core.ts` 的状态转换（派发、资源预留、候选 SHA 门禁、审查置信度、CI 边界与恢复）。

## 完成与限制

流程遵循依赖调度，先计划与实现，再进行作者自检、独立 review/修复循环、fresh 完整审查和独立验收。冲突修复或基线更新后，重新自检、验证和审查；只有当前候选达到关闭工单条件才合并。

父 spec 由新的 L1 验收。可自动补齐的缺口继续走收尾流程；必须人工的尾部验收保持现有工单和父 spec 打开，并留下操作、证据与恢复入口。

本包的存在、静态检查、原生编译、真实启动、任务完成和 GitHub 合并是不同事实。没有 `CreateWorkflow` 的宿主不能声称已启动 ZCode workflow；代码中的状态门禁也不能证明由模型自行填报的远端事实。L1 必须提供真实宿主与 GitHub 观察，并保留原始命令/测试证据。仅查看或验证本包时，不启动实际 spec、认领工单或合并 PR。

本版已做严格 TypeScript 类型检查、16 项状态转换测试，以及隔离仓库中的 CLI/worktree/验证命令检查。GitHub 适配器用模拟响应验证，尚未用真实 spec 跑端到端；生成的 ZCode 批次仍需在 ZCode 中进行原生编译与执行确认。

依赖读取使用 GitHub 官方的 [sub-issues API](https://docs.github.com/en/rest/issues/sub-issues) 与 [issue dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies)。程序不会把 API 权限失败误判成没有依赖。
