import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConvexHttpClient } from 'convex/browser'
import { createTaskerServer } from './server.js'

const url = process.env.TASKER_CONVEX_URL
const token = process.env.TASKER_API_TOKEN
if (!url || !token) {
  console.error('Set TASKER_CONVEX_URL and TASKER_API_TOKEN to start the Tasker MCP server.')
  process.exit(1)
}
try {
  const backend = new ConvexHttpClient(url)
  const server = createTaskerServer(backend, token)
  await server.connect(new StdioServerTransport())
} catch {
  console.error('Could not start the Tasker MCP server. Verify the backend URL and configuration.')
  process.exit(1)
}
