import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { applyIssueUpdate } from './issues'
import { createActivity } from './lib/activity'
import { requireAgentUser } from './lib/agentTokens'
import { canWrite, getAccessibleProjectIds, isAdmin, requireProjectViewAccessForUser } from './lib/auth'
import { ensureProjectStatusExists, normalizeProject } from './lib/projectStatuses'

const LEASE_MS = 60 * 60 * 1000
const assignmentValidator = v.union(v.literal('mine'), v.literal('others'), v.literal('unassigned'), v.literal('assignee'), v.literal('all'))
const runArgs = { token: v.string(), issueId: v.id('issues'), runId: v.string() }

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message })
}

async function taskAccess(ctx: QueryCtx | MutationCtx, token: string, issueId: Id<'issues'>, write = false) {
  const { user, credential } = await requireAgentUser(ctx, token)
  const issue = await ctx.db.get(issueId)
  if (!issue || issue.deletedAt !== undefined) fail('NOT_FOUND', 'Task not found.')
  const { project } = await requireProjectViewAccessForUser(ctx, issue.projectId, user)
  if (write && !canWrite(user.globalRole)) fail('FORBIDDEN', 'This task is read-only for your role.')
  if (write && (project.archived || issue.archived || issue.status === 'done')) {
    fail('VALIDATION_ERROR', 'Archived or completed work cannot be consumed.')
  }
  return { issue, project, user, credential }
}

function validateRunId(runId: string) {
  if (!runId.trim() || runId.length > 200) fail('VALIDATION_ERROR', 'Provide a nonempty run ID up to 200 characters.')
}

function validateStatus(project: Doc<'projects'>, key: string) {
  if (key === 'done' || key === 'todo' || !ensureProjectStatusExists(project, key)) {
    fail('VALIDATION_ERROR', `Configure a project work/review status or pass its existing key. Invalid target: ${key}.`)
  }
}

function requireClaim(issue: Doc<'issues'>, tokenId: Id<'agentTokens'>, runId: string) {
  validateRunId(runId)
  const claim = issue.agentClaim
  if (!claim || claim.tokenId !== tokenId || claim.runId !== runId || claim.expiresAt <= Date.now()) {
    fail('CONFLICT', 'This run does not hold an active claim. Claim the task before continuing.')
  }
  if (claim.invalidated || issue.status !== claim.workStatus) fail('CONFLICT', 'The task status changed while the agent was working. Release the claim and read the task again.')
  return claim
}

export const list = query({
  args: { token: v.string(), projectId: v.optional(v.id('projects')), assignment: v.optional(assignmentValidator), assigneeId: v.optional(v.id('users')), statuses: v.optional(v.array(v.string())), limit: v.optional(v.number()), cursor: v.optional(v.string()), includeClaimed: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { user } = await requireAgentUser(ctx, args.token)
    const assignment = args.assignment ?? 'mine'
    if (assignment === 'assignee' && !args.assigneeId) fail('VALIDATION_ERROR', 'assigneeId is required for the assignee filter.')
    if (args.assigneeId && assignment !== 'assignee') fail('VALIDATION_ERROR', 'Use assignment="assignee" with assigneeId.')
    const limit = args.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('VALIDATION_ERROR', 'limit must be an integer from 1 to 100.')
    let projects: Doc<'projects'>[]
    if (args.projectId) {
      projects = [(await requireProjectViewAccessForUser(ctx, args.projectId, user)).project]
    } else if (isAdmin(user.globalRole)) {
      projects = await ctx.db.query('projects').collect()
    } else {
      const ids = await getAccessibleProjectIds(ctx, user._id)
      projects = (await Promise.all(ids.map(id => ctx.db.get(id)))).filter((project): project is Doc<'projects'> => project !== null)
    }
    const rows = []
    for (const project of projects.filter(project => !project.archived)) {
      const issues = await ctx.db.query('issues').withIndex('by_projectId', q => q.eq('projectId', project._id)).collect()
      for (const issue of issues) {
        if (issue.deletedAt !== undefined || issue.archived || issue.status === 'done') continue
        if (args.statuses?.length ? !args.statuses.includes(issue.status) : issue.status === 'in_review') continue
        if (!args.includeClaimed && issue.agentClaim && issue.agentClaim.expiresAt > Date.now()) continue
        if (assignment === 'mine' && issue.assigneeId !== user._id) continue
        if (assignment === 'others' && (!issue.assigneeId || issue.assigneeId === user._id)) continue
        if (assignment === 'unassigned' && issue.assigneeId) continue
        if (assignment === 'assignee' && issue.assigneeId !== args.assigneeId) continue
        if (args.cursor && issue._id <= args.cursor) continue
        rows.push({ issue, project: { _id: project._id, name: project.name, key: project.key }, canWrite: canWrite(user.globalRole) })
      }
    }
    rows.sort((a, b) => a.issue._id < b.issue._id ? -1 : a.issue._id > b.issue._id ? 1 : 0)
    const tasks = rows.slice(0, limit)
    return { tasks, nextCursor: rows.length > limit ? tasks[tasks.length - 1].issue._id : null }
  },
})

export const get = query({
  args: { token: v.string(), issueId: v.id('issues') },
  handler: async (ctx, args) => {
    const { issue, project, user } = await taskAccess(ctx, args.token, args.issueId)
    const comments = await ctx.db.query('comments').withIndex('by_issueId', q => q.eq('issueId', issue._id)).order('asc').collect()
    const children = await ctx.db.query('issues').withIndex('by_projectId_parentIssueId', q => q.eq('projectId', project._id).eq('parentIssueId', issue._id)).collect()
    const parent = issue.parentIssueId ? await ctx.db.get(issue.parentIssueId) : null
    const assignee = issue.assigneeId ? await ctx.db.get(issue.assigneeId) : null
    return {
      issue, project: normalizeProject(project), comments,
      parentIssue: parent && !parent.archived && parent.deletedAt === undefined ? parent : null,
      childIssues: children.filter(child => !child.archived && child.deletedAt === undefined),
      assignee: assignee ? { _id: assignee._id, name: assignee.name } : null,
      canWrite: canWrite(user.globalRole),
    }
  },
})

export const claim = mutation({
  args: { ...runArgs, workStatus: v.optional(v.string()) },
  handler: async (ctx, args) => {
    validateRunId(args.runId)
    const { issue, project, user, credential } = await taskAccess(ctx, args.token, args.issueId, true)
    const now = Date.now()
    const current = issue.agentClaim
    if (current && current.expiresAt > now && (current.tokenId !== credential._id || current.runId !== args.runId)) {
      fail('CONFLICT', 'Another agent run already holds this task.')
    }
    const sameRun = current?.tokenId === credential._id && current.runId === args.runId && current.expiresAt > now
    const workStatus = args.workStatus ?? (sameRun ? current.workStatus : 'in_progress')
    validateStatus(project, workStatus)
    if (sameRun && (current.invalidated || issue.status !== current.workStatus || workStatus !== current.workStatus)) {
      fail('CONFLICT', 'The task or work status changed. Release the claim and read the task again.')
    }
    await applyIssueUpdate(ctx, { issue, user, source: 'agent', changes: { status: workStatus }, now })
    await ctx.db.patch(issue._id, { agentClaim: {
      tokenId: credential._id, userId: user._id, runId: args.runId,
      expiresAt: now + LEASE_MS,
      previousStatus: sameRun ? current.previousStatus : issue.status,
      workStatus,
    } })
    return await ctx.db.get(issue._id)
  },
})

export const submitReview = mutation({
  args: { ...runArgs, summary: v.string(), reviewStatus: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const summary = args.summary.trim()
    if (!summary || summary.length > 20000) fail('VALIDATION_ERROR', 'Provide a result summary up to 20,000 characters, including verification and relevant links.')
    const { issue, project, user, credential } = await taskAccess(ctx, args.token, args.issueId, true)
    const activeClaim = requireClaim(issue, credential._id, args.runId)
    const reviewStatus = args.reviewStatus ?? 'in_review'
    validateStatus(project, reviewStatus)
    if (reviewStatus === activeClaim.workStatus) fail('VALIDATION_ERROR', 'Review status must differ from the work status.')
    const now = Date.now()
    await applyIssueUpdate(ctx, { issue, user, source: 'agent', changes: { status: reviewStatus }, now })
    const commentId = await ctx.db.insert('comments', { issueId: issue._id, projectId: project._id, authorId: user._id, body: `Agent result (${args.runId})\n\n${summary}`, createdAt: now, updatedAt: now })
    await createActivity(ctx, { actorId: user._id, projectId: project._id, issueId: issue._id, entityType: 'comment', entityId: commentId, action: 'comment.created', metadata: { source: 'mcp', runId: args.runId } })
    await ctx.db.patch(issue._id, { agentClaim: undefined })
    return await ctx.db.get(issue._id)
  },
})

export const release = mutation({
  args: runArgs,
  handler: async (ctx, args) => {
    const { issue, project, user, credential } = await taskAccess(ctx, args.token, args.issueId, true)
    validateRunId(args.runId)
    const activeClaim = issue.agentClaim
    if (!activeClaim || activeClaim.tokenId !== credential._id || activeClaim.runId !== args.runId) fail('CONFLICT', 'This run does not own the claim.')
    // Do not overwrite a human's intervening status edit or restore a deleted status.
    if (!activeClaim.invalidated && issue.status === activeClaim.workStatus && ensureProjectStatusExists(project, activeClaim.previousStatus)) {
      await applyIssueUpdate(ctx, { issue, user, source: 'agent', changes: { status: activeClaim.previousStatus } })
    }
    await ctx.db.patch(issue._id, { agentClaim: undefined, updatedAt: Date.now() })
    return await ctx.db.get(issue._id)
  },
})
