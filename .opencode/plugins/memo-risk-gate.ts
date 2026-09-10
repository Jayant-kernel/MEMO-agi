import { type Plugin, tool } from "@opencode-ai/plugin"
import { assessRisk } from "../lib/memo-risk.mjs"

export default (async () => ({
  tool: {
    memo_risk_assess: tool({
      description:
        "Deterministically classify a Memo request before task decomposition. It never executes work.",
      args: {
        request: tool.schema.string().min(1).max(20000),
      },
      async execute(args) {
        return {
          title: "Memo risk preflight",
          output: JSON.stringify(assessRisk(args.request), null, 2),
          metadata: assessRisk(args.request),
        }
      },
    }),
  },
})) satisfies Plugin
