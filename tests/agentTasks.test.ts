import { describe, expect, it, vi } from 'vitest'
import type { MutationCtx } from '../convex/_generated/server'
import type { Id } from '../convex/_generated/dataModel'
import * as tasks from '../convex/agentTasks'
import * as tokens from '../convex/agentTokens'
import { hashToken } from '../convex/lib/agentTokens'
import { DEFAULT_PROJECT_STATUSES } from '../convex/lib/projectStatuses'

const token = `tsk_${'a'.repeat(64)}`
const userId = 'user' as Id<'users'>
const projectId = 'project' as Id<'projects'>
const issueId = 'issue' as Id<'issues'>
const tokenId = 'token' as Id<'agentTokens'>
const handler = (fn: unknown) => (fn as { _handler: (ctx: MutationCtx, args: Record<string, unknown>) => Promise<any> })._handler

async function context(role = 'member') {
  const records = new Map<string, any>([
    [userId, { _id: userId, clerkUserId: 'clerk', isActive: true, globalRole: role, name: 'User' }],
    [projectId, { _id: projectId, createdBy: userId, key: 'TEST', name: 'Project', archived: false, statuses: DEFAULT_PROJECT_STATUSES }],
    [issueId, { _id: issueId, projectId, issueNumber: 1, title: 'Work', description: 'Do the work', status: 'todo', archived: false, assigneeId: userId, updatedAt: 1 }],
    [tokenId, { _id: tokenId, userId, tokenHash: await hashToken(token), name: 'Agent', tokenPrefix: token.slice(0, 12), createdAt: 1 }],
  ])
  const tableFor = (id: string) => id === userId ? 'users' : id === projectId || id.startsWith('project-') ? 'projects' : id === tokenId ? 'agentTokens' : id === issueId || id.startsWith('issue-') ? 'issues' : id.split('-')[0]
  const query = (table: string) => {
    const conditions: [string, unknown][] = []
    const rows = () => [...records.entries()].filter(([id, row]) => tableFor(id) === table && conditions.every(([key, value]) => row[key] === value)).map(([, row]) => row)
    const chain = {
      withIndex: (_name: string, cb: (q: any) => unknown) => {
        const q = { eq: (key: string, value: unknown) => { conditions.push([key, value]); return q } }
        cb(q)
        return chain
      },
      collect: async () => rows(), unique: async () => rows()[0] ?? null,
      take: async (limit: number) => rows().slice(0, limit), order: () => chain,
    }
    return chain
  }
  const patch = vi.fn(async (id: string, changes: object) => records.set(id, { ...records.get(id), ...changes }))
  let counter = 0
  const insert = vi.fn(async (table: string, fields: object) => {
    const id = `${table}-${++counter}`
    records.set(id, { _id: id, ...fields })
    return id
  })
  const ctx = { auth: { getUserIdentity: async () => ({ subject: 'clerk' }) }, db: { get: async (id: string) => records.get(id) ?? null, query, patch, insert } } as unknown as MutationCtx
  return { ctx, records, patch, insert }
}

describe('agent token authentication', () => {
  it('rejects invalid, revoked, expired tokens and inactive owners', async () => {
    const { ctx, records } = await context()
    await expect(handler(tasks.list)(ctx, { token: 'invalid' })).rejects.toThrow()
    for (const changes of [{ revokedAt: 1 }, { expiresAt: 1 }]) {
      const original = records.get(tokenId)
      records.set(tokenId, { ...original, ...changes })
      await expect(handler(tasks.list)(ctx, { token })).rejects.toThrow()
      records.set(tokenId, original)
    }
    records.get(userId).isActive = false
    await expect(handler(tasks.list)(ctx, { token })).rejects.toThrow()
  })
  it('stores only a token hash and lists safe metadata', async () => {
    const { ctx, records } = await context()
    const newToken = `tsk_${'b'.repeat(64)}`
    await handler(tokens.create)(ctx, { name: 'Second agent', token: newToken })
    const rows = await handler(tokens.list)(ctx, {})
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain('tokenHash')
    expect(JSON.stringify([...records.values()])).not.toContain(newToken)
  })
  it('cannot revoke another user’s token', async () => {
    const { ctx, records } = await context()
    records.get(tokenId).userId = 'someone-else'
    await expect(handler(tokens.revoke)(ctx, { tokenId })).rejects.toThrow()
  })
})

describe('agent task queue', () => {
  it('paginates without duplicates and only includes live claims when requested', async () => {
    const { ctx, records } = await context()
    records.set('issue-other', { ...records.get(issueId), _id: 'issue-other' })
    const first = await handler(tasks.list)(ctx, { token, limit: 1 })
    expect(first.nextCursor).toBe(issueId)
    const second = await handler(tasks.list)(ctx, { token, limit: 1, cursor: first.nextCursor })
    expect(second.tasks[0].issue._id).toBe('issue-other')
    expect(second.nextCursor).toBeNull()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })
    expect((await handler(tasks.list)(ctx, { token })).tasks).toHaveLength(1)
    expect((await handler(tasks.list)(ctx, { token, includeClaimed: true })).tasks).toHaveLength(2)
    records.get(issueId).agentClaim.expiresAt = 1
    expect((await handler(tasks.list)(ctx, { token })).tasks).toHaveLength(2)
  })
  it('reads the task context but defaults to skipping review work in the queue', async () => {
    const { ctx, records } = await context()
    records.get(issueId).status = 'in_review'
    expect((await handler(tasks.list)(ctx, { token })).tasks).toHaveLength(0)
    expect((await handler(tasks.list)(ctx, { token, statuses: ['in_review'] })).tasks).toHaveLength(1)
    const result = await handler(tasks.get)(ctx, { token, issueId })
    expect(result).toMatchObject({ issue: { title: 'Work' }, project: { key: 'TEST' }, assignee: { _id: userId, name: 'User' }, canWrite: true })
  })
  it('filters mine, others, unassigned, and a specific assignee without leaking other projects', async () => {
    const { ctx, records } = await context()
    records.set('issue-other', { ...records.get(issueId), _id: 'issue-other', assigneeId: 'other' })
    records.set('issue-unassigned', { ...records.get(issueId), _id: 'issue-unassigned', assigneeId: undefined })
    records.set('project-private', { ...records.get(projectId), _id: 'project-private', createdBy: 'other' })
    records.set('issue-private', { ...records.get(issueId), _id: 'issue-private', projectId: 'project-private' })
    for (const [scope, id] of [['mine', issueId], ['others', 'issue-other'], ['unassigned', 'issue-unassigned']]) {
      const result = await handler(tasks.list)(ctx, { token, assignment: scope })
      expect(result.tasks.map((row: any) => row.issue._id)).toEqual([id])
    }
    expect((await handler(tasks.list)(ctx, { token, assignment: 'all' })).tasks).toHaveLength(3)
    expect((await handler(tasks.list)(ctx, { token, assignment: 'assignee', assigneeId: 'other' })).tasks).toHaveLength(1)
    await expect(handler(tasks.get)(ctx, { token, issueId: 'issue-private' })).rejects.toThrow()
    await expect(handler(tasks.list)(ctx, { token, assignment: 'assignee' })).rejects.toThrow()
  })
  it('lets viewers read but rejects claims', async () => {
    const { ctx, patch } = await context('viewer')
    expect((await handler(tasks.list)(ctx, { token })).tasks).toHaveLength(1)
    await expect(handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })).rejects.toThrow()
    expect(patch).not.toHaveBeenCalled()
  })
  it('excludes done, deleted, archived tasks and archived projects', async () => {
    const { ctx, records } = await context()
    for (const change of [{ status: 'done' }, { archived: true }, { deletedAt: 1 }]) {
      const original = records.get(issueId)
      records.set(issueId, { ...original, ...change })
      expect((await handler(tasks.list)(ctx, { token })).tasks).toEqual([])
      await expect(handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })).rejects.toThrow()
      records.set(issueId, original)
    }
    records.get(projectId).archived = true
    expect((await handler(tasks.list)(ctx, { token })).tasks).toEqual([])
    await expect(handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })).rejects.toThrow()
  })
})

describe('agent claim and review lifecycle', () => {
  it('checks token revocation, role changes, and project access again before submission', async () => {
    const { ctx, records, patch } = await context()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })
    patch.mockClear()
    records.get(tokenId).revokedAt = 1
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', summary: 'Done' })).rejects.toThrow()
    records.get(tokenId).revokedAt = undefined
    records.get(userId).globalRole = 'viewer'
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', summary: 'Done' })).rejects.toThrow()
    records.get(userId).globalRole = 'member'
    records.get(projectId).createdBy = 'other'
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', summary: 'Done' })).rejects.toThrow()
    expect(patch).not.toHaveBeenCalled()
  })
  it('accepts explicit custom workflow keys and rejects identical work and review states', async () => {
    const { ctx, records } = await context()
    records.get(projectId).statuses = [
      { key: 'building', name: 'Building', color: '#64748b', position: 1 },
      { key: 'approval', name: 'Approval', color: '#64748b', position: 2 },
    ]
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run', workStatus: 'building' })
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', summary: 'Done', reviewStatus: 'building' })).rejects.toThrow()
    await handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', summary: 'Done', reviewStatus: 'approval' })
    expect(records.get(issueId).status).toBe('approval')
  })
  it('does not overwrite a person’s status edit when submitting or releasing', async () => {
    const { ctx, records } = await context()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })
    records.get(issueId).status = 'backlog'
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', summary: 'Done' })).rejects.toThrow()
    await handler(tasks.release)(ctx, { token, issueId, runId: 'run' })
    expect(records.get(issueId).status).toBe('backlog')
  })
  it('requires the same token even if another agent copies the run ID', async () => {
    const { ctx } = await context()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })
    const otherToken = `tsk_${'b'.repeat(64)}`
    await handler(tokens.create)(ctx, { token: otherToken, name: 'Other agent' })
    await expect(handler(tasks.claim)(ctx, { token: otherToken, issueId, runId: 'run' })).rejects.toThrow()
    await expect(handler(tasks.submitReview)(ctx, { token: otherToken, issueId, runId: 'run', summary: 'Done' })).rejects.toThrow()
  })
  it('claims without reassignment, rejects competitors, renews and submits a review comment', async () => {
    const { ctx, records } = await context()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run-1' })
    expect(records.get(issueId)).toMatchObject({ status: 'in_progress', assigneeId: userId, agentClaim: { runId: 'run-1', tokenId } })
    await expect(handler(tasks.claim)(ctx, { token, issueId, runId: 'run-2' })).rejects.toThrow()
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run-2', summary: 'Done' })).rejects.toThrow()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run-1' })
    await handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run-1', summary: 'Implemented and tested. PR: example' })
    expect(records.get(issueId)).toMatchObject({ status: 'in_review', assigneeId: userId })
    expect(records.get(issueId).agentClaim).toBeUndefined()
    expect([...records.values()].find(row => row.body)?.body).toContain('Implemented and tested')
    expect([...records.values()].some(row => row.action === 'issue.status_changed' && row.metadata.to === 'in_review')).toBe(true)
  })
  it('allows takeover after expiry but prevents an expired worker from submitting', async () => {
    const { ctx, records } = await context()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'old' })
    records.get(issueId).agentClaim.expiresAt = 1
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'old', summary: 'Done' })).rejects.toThrow()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'new' })
    expect(records.get(issueId).agentClaim.runId).toBe('new')
  })
  it('releases only its own claim and returns to the previous status', async () => {
    const { ctx, records } = await context()
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })
    await expect(handler(tasks.release)(ctx, { token, issueId, runId: 'other' })).rejects.toThrow()
    await handler(tasks.release)(ctx, { token, issueId, runId: 'run' })
    expect(records.get(issueId).status).toBe('todo')
    expect(records.get(issueId).agentClaim).toBeUndefined()
  })
  it('rejects missing statuses and empty summaries without writing', async () => {
    const { ctx, records, patch } = await context()
    records.get(projectId).statuses = []
    await expect(handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })).rejects.toThrow()
    expect(patch).not.toHaveBeenCalled()
    records.get(projectId).statuses = DEFAULT_PROJECT_STATUSES
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })
    patch.mockClear()
    for (const args of [{ summary: ' ' }, { summary: 'Done', reviewStatus: 'done' }, { summary: 'Done', reviewStatus: 'missing' }]) {
      await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', ...args })).rejects.toThrow()
    }
    expect(patch).not.toHaveBeenCalled()
  })
  it('respects done ancestor guards when claiming or submitting', async () => {
    const { ctx, records } = await context()
    records.set('issue-parent', { ...records.get(issueId), _id: 'issue-parent', status: 'done' })
    records.get(issueId).parentIssueId = 'issue-parent'
    await expect(handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })).rejects.toThrow(/parent/)
    records.get('issue-parent').status = 'todo'
    await handler(tasks.claim)(ctx, { token, issueId, runId: 'run' })
    records.get('issue-parent').status = 'done'
    await expect(handler(tasks.submitReview)(ctx, { token, issueId, runId: 'run', summary: 'Done' })).rejects.toThrow(/parent/)
  })
})
