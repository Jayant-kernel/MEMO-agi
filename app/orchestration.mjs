import { assessRisk } from "../.opencode/lib/memo-risk.mjs"

export const modelChoices = [
  { id: "memo", label: "Memo Auto", route: "frontier-orchestrator", detail: "Plans, delegates, verifies, and synthesizes." },
  { id: "local", label: "Local Qwen", route: "local-worker", detail: "Runs locally through Ollama." },
  { id: "luna", label: "GPT-5.6 Luna", route: "luna-worker", detail: "Bounded cloud drafting and transformation." },
  { id: "terra", label: "GPT-5.6 Terra", route: "terra-implementer", detail: "Cloud implementation and diagnosis." },
  { id: "sol", label: "GPT-5.6 Sol", route: "frontier-orchestrator", detail: "Cloud frontier orchestration and final synthesis." },
]

const choice = (id) => modelChoices.find((item) => item.id === id) ?? modelChoices[0]
export const planTask = (content, requested = "memo") => {
  const risk = assessRisk(content), selected = choice(requested)
  if (risk.risk === "high") return { selected: "memo", route: risk.required_route, risk, steps: [{ id: "preflight", title: "Risk review", worker: "codex-supervisor", state: "approval-required" }, { id: "execute", title: "Approved execution", worker: "codex-supervisor", state: "blocked" }] }
  if (selected.id !== "memo") return { selected: selected.id, route: selected.route, risk, steps: [{ id: "execute", title: "Direct task execution", worker: selected.route, state: "queued" }, { id: "verify", title: "Check result", worker: "local-utility", state: "planned" }] }
  return { selected: "memo", route: selected.route, risk, steps: [{ id: "analyze", title: "Understand and divide task", worker: "memo-task-analyzer", state: "planned" }, { id: "execute", title: "Execute bounded work", worker: "local-worker / Luna / Terra", state: "planned" }, { id: "verify", title: "Verify evidence and synthesize", worker: "frontier-orchestrator", state: "planned" }] }
}
