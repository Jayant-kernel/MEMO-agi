import { type Plugin, tool } from "@opencode-ai/plugin"
import { addCheckpoint, createManifest, createRun, finishRun, getMemoState, recordRunEvent } from "../lib/memo-state.mjs"

const statePermission = async (context: { ask: Function; directory: string }, action: string) =>
  context.ask({ permission: "memo-state", patterns: [`${action}:${context.directory}/.memo`], always: [] })

export default (async () => ({
  tool: {
    memo_manifest_create: tool({
      description: "Create a durable local task manifest with explicit acceptance and verification criteria. It does not execute work.",
      args: {
        task_id: tool.schema.string().min(3).max(80), title: tool.schema.string().min(1).max(300), request: tool.schema.string().min(1).max(8000),
        risk: tool.schema.enum(["standard", "high"]).default("standard"), route: tool.schema.string().max(100).optional(),
        acceptance_criteria: tool.schema.array(tool.schema.string().min(1).max(1000)).min(1).max(30), verification: tool.schema.array(tool.schema.string().min(1).max(1000)).min(1).max(30),
      },
      async execute(args, context) { await statePermission(context, "create-manifest"); return { title: "Memo task manifest", output: JSON.stringify(await createManifest(context.directory, args), null, 2) } },
    }),
    memo_run_start: tool({
      description: "Start a local Memo trace and cost ledger run. It records planning metadata only and never executes the task.",
      args: { run_id: tool.schema.string().min(3).max(80).optional(), task: tool.schema.string().min(1).max(4000), route: tool.schema.string().min(1).max(100), models: tool.schema.array(tool.schema.string().min(1).max(200)).max(10).default([]), task_id: tool.schema.string().min(3).max(80).optional() },
      async execute(args, context) { await statePermission(context, "start-run"); return { title: "Memo run started", output: JSON.stringify(await createRun(context.directory, args), null, 2) } },
    }),
    memo_run_event: tool({
      description: "Append a compact trace event for a running Memo task: routing, delegation, tool result, check, failure, or checkpoint.",
      args: {
        run_id: tool.schema.string().min(3).max(80), type: tool.schema.enum(["note", "route", "delegation", "tool", "check", "failure", "checkpoint"]), summary: tool.schema.string().min(1).max(4000),
        outcome: tool.schema.enum(["passed", "failed"]).optional(), model: tool.schema.string().max(200).optional(), duration_ms: tool.schema.number().int().min(0).optional(),
        tokens: tool.schema.object({ input: tool.schema.number().int().min(0).optional(), output: tool.schema.number().int().min(0).optional() }).optional(), evidence: tool.schema.array(tool.schema.string().min(1).max(1000)).max(20).default([]),
      },
      async execute(args, context) { await statePermission(context, "append-event"); return { title: "Memo run event", output: JSON.stringify(await recordRunEvent(context.directory, args), null, 2) } },
    }),
    memo_run_finish: tool({
      description: "Finalize a Memo run with a verified outcome. It cannot finalize a run twice.",
      args: { run_id: tool.schema.string().min(3).max(80), status: tool.schema.enum(["passed", "failed", "blocked", "cancelled"]), outcome: tool.schema.string().max(4000).optional() },
      async execute(args, context) { await statePermission(context, "finish-run"); return { title: "Memo run finished", output: JSON.stringify(await finishRun(context.directory, args), null, 2) } },
    }),
    memo_checkpoint: tool({
      description: "Record resumable task progress in a local Memo manifest. It does not mark acceptance criteria complete by itself.",
      args: { task_id: tool.schema.string().min(3).max(80), status: tool.schema.enum(["planned", "in_progress", "blocked", "completed"]).default("in_progress"), summary: tool.schema.string().min(1).max(4000), evidence: tool.schema.array(tool.schema.string().min(1).max(1000)).max(20).default([]) },
      async execute(args, context) { await statePermission(context, "checkpoint"); return { title: "Memo checkpoint", output: JSON.stringify(await addCheckpoint(context.directory, args), null, 2) } },
    }),
    memo_state_read: tool({
      description: "Read one local Memo run or task manifest for recovery, auditing, or final synthesis.",
      args: { run_id: tool.schema.string().min(3).max(80).optional(), task_id: tool.schema.string().min(3).max(80).optional() },
      async execute(args, context) { await context.ask({ permission: "memo-state", patterns: [`read:${context.directory}/.memo`], always: [] }); return { title: "Memo state", output: JSON.stringify(await getMemoState(context.directory, args), null, 2) } },
    }),
  },
})) satisfies Plugin
