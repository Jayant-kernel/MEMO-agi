import { createMemoServer } from "../../app/server.mjs"
import { MemoBridge } from "../../app/bridge.mjs"

const server = createMemoServer(process.argv[2], { bridge: new MemoBridge({}) })
server.listen(0, "127.0.0.1", () => process.send?.({ type: "ready" }))
process.once("SIGTERM", () => server.close(() => process.exit(0)))
