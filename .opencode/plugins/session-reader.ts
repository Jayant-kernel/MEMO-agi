import { type Plugin, tool } from "@opencode-ai/plugin"

const redactSensitive = (value: string) =>
  value
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:[\w-]*api[_-]?key|[\w-]*token|password|passwd|secret)["']?\s*[:=]\s*["']?)[^"'\s,}\]]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:fc-|exa_)[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")

const isoDate = (value: number) => new Date(value).toISOString()

export const SessionReaderPlugin: Plugin = async ({ client }) => ({
  tool: {
    session_history_list: tool({
      description: "List persisted sessions only when the user explicitly requests them.",
      args: {
        directory: tool.schema.string().optional(),
        search: tool.schema.string().optional(),
        limit: tool.schema.number().int().min(1).max(50).default(20),
        roots_only: tool.schema.boolean().default(true),
        include_current: tool.schema.boolean().default(false),
      },
      async execute(args, context) {
        const directory = args.directory || context.directory
        await context.ask({ permission: "session-history", patterns: [`list:${directory}`], always: [] })
        const response = await client.session.list({ query: { directory }, throwOnError: true })
        const needle = args.search?.trim().toLowerCase()
        const sessions = response.data
          .filter((item) => !args.roots_only || !item.parentID)
          .filter((item) => args.include_current || item.id !== context.sessionID)
          .filter((item) => !needle || item.title.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
          .sort((left, right) => right.time.updated - left.time.updated)
          .slice(0, args.limit)
          .map((item) => ({ id: item.id, title: item.title, directory: item.directory, created_at: isoDate(item.time.created), updated_at: isoDate(item.time.updated), parent_id: item.parentID ?? null }))
        return { title: "OpenCode session history", output: JSON.stringify({ directory, count: sessions.length, sessions }, null, 2) }
      },
    }),
    session_history_read: tool({
      description: "Read selected persisted sessions only after the user explicitly identifies them.",
      args: {
        session_ids: tool.schema.array(tool.schema.string().min(1)).min(1).max(5),
        directory: tool.schema.string().optional(),
        message_limit: tool.schema.number().int().min(1).max(100).default(50),
        max_characters: tool.schema.number().int().min(1000).max(50000).default(30000),
      },
      async execute(args, context) {
        const directory = args.directory || context.directory
        await context.ask({ permission: "session-history", patterns: args.session_ids.map((id) => `read:${id}`), always: [] })
        const transcripts: string[] = []
        for (const id of args.session_ids) {
          const [session, messages] = await Promise.all([
            client.session.get({ path: { id }, query: { directory }, throwOnError: true }),
            client.session.messages({ path: { id }, query: { directory, limit: args.message_limit }, throwOnError: true }),
          ])
          const lines = messages.data
            .sort((left, right) => left.info.time.created - right.info.time.created)
            .flatMap(({ info, parts }) => {
              const text = parts.flatMap((part) => part.type === "text" && !part.ignored && !part.synthetic && part.text.trim() ? [part.text.trim()] : []).join("\n")
              return text ? [`[${isoDate(info.time.created)}] ${info.role.toUpperCase()}:\n${redactSensitive(text)}`] : []
            })
          transcripts.push([`# ${session.data.title}`, `Session: ${id}`, `Directory: ${session.data.directory}`, "", ...lines].join("\n\n"))
        }
        const combined = transcripts.join("\n\n---\n\n")
        const output = combined.length > args.max_characters ? `${combined.slice(0, args.max_characters)}\n\n[TRUNCATED AT ${args.max_characters} CHARACTERS]` : combined
        return { title: "Imported OpenCode conversations", output }
      },
    }),
  },
})
