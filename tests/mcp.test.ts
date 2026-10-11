import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { ConvexError } from 'convex/values'
import { describe, expect, it, vi } from 'vitest'
import { createTaskerServer } from '../mcp/server'

async function connection() {
  const backend = {
    query: vi.fn(async () => ({ tasks: [{ issue: { _id: 'task', title: 'Work' } }], nextCursor: null })),
    mutation: vi.fn(async () => ({ _id: 'task', status: 'in_review' })),
  }
  const server = createTaskerServer(backend, 'secret-token')
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { backend, client, close: () => client.close() }
}

describe('Tasker MCP protocol', () => {
  it.each(['node', 'pnpm'])('starts the real stdio entrypoint through %s and discovers tools', async (launcher) => {
    const transport = new StdioClientTransport({
      command: launcher === 'node' ? process.execPath : 'pnpm',
      args: launcher === 'node'
        ? [resolve('node_modules/tsx/dist/cli.mjs'), resolve('mcp/index.ts')]
        : ['--dir', process.cwd(), 'exec', 'tsx', 'mcp/index.ts'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), TASKER_CONVEX_URL: 'https://example.convex.cloud', TASKER_API_TOKEN: 'test-token' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-test', version: '1.0.0' })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools).toHaveLength(5)
    } finally { await client.close() }
  }, 20000)
  it('discovers tools and dispatches the claim-to-review workflow without exposing credentials', async () => {
    const { client, backend, close } = await connection()
    try {
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toEqual(['list_tasks', 'get_task', 'claim_task', 'submit_task_for_review', 'release_task'])
      const queue = await client.callTool({ name: 'list_tasks', arguments: { assignment: 'unassigned' } })
      expect(queue.isError).not.toBe(true)
      expect(backend.query).toHaveBeenCalledWith(expect.anything(), { token: 'secret-token', assignment: 'unassigned' })
      await client.callTool({ name: 'get_task', arguments: { issueId: 'task' } })
      await client.callTool({ name: 'claim_task', arguments: { issueId: 'task', runId: 'run' } })
      await client.callTool({ name: 'submit_task_for_review', arguments: { issueId: 'task', runId: 'run', summary: 'Completed and tested' } })
      expect(backend.mutation).toHaveBeenLastCalledWith(expect.anything(), { token: 'secret-token', issueId: 'task', runId: 'run', summary: 'Completed and tested' })
      expect(JSON.stringify(queue)).not.toContain('secret-token')
      expect(JSON.stringify(tools)).not.toContain('secret-token')
    } finally { await close() }
  })
  it('rejects invalid tool arguments before contacting the backend', async () => {
    const { client, backend, close } = await connection()
    try {
      const result = await client.callTool({ name: 'submit_task_for_review', arguments: { issueId: 'task', runId: 'run', summary: ' ' } })
      expect(result.isError).toBe(true)
      expect(backend.mutation).not.toHaveBeenCalled()
    } finally { await close() }
  })
  it('returns useful domain errors and hides transport errors that might contain the token', async () => {
    const { client, backend, close } = await connection()
    try {
      backend.query.mockRejectedValueOnce(new ConvexError({ code: 'CONFLICT', message: 'Already claimed' }))
      const conflict = await client.callTool({ name: 'get_task', arguments: { issueId: 'task' } })
      expect(conflict.isError).toBe(true)
      expect(JSON.stringify(conflict)).toContain('Already claimed')
      backend.query.mockRejectedValueOnce(new Error('transport failed: secret-token'))
      const failure = await client.callTool({ name: 'get_task', arguments: { issueId: 'task' } })
      expect(failure.isError).toBe(true)
      expect(JSON.stringify(failure)).not.toContain('secret-token')
    } finally { await close() }
  })
})
