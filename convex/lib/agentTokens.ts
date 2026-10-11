import { ConvexError } from 'convex/values'
import type { MutationCtx, QueryCtx } from '../_generated/server'

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function validateTokenFormat(token: string) {
  if (!/^tsk_[a-f0-9]{64}$/.test(token)) {
    throw new ConvexError({ code: 'UNAUTHORIZED', message: 'Invalid agent token.' })
  }
}

export async function requireAgentUser(ctx: QueryCtx | MutationCtx, token: string) {
  validateTokenFormat(token)
  const tokenHash = await hashToken(token)
  const credential = await ctx.db.query('agentTokens')
    .withIndex('by_tokenHash', q => q.eq('tokenHash', tokenHash))
    .unique()
  if (!credential || credential.revokedAt !== undefined || (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())) {
    throw new ConvexError({ code: 'UNAUTHORIZED', message: 'Agent token is invalid, expired, or revoked.' })
  }
  const user = await ctx.db.get(credential.userId)
  if (!user?.isActive) {
    throw new ConvexError({ code: 'FORBIDDEN', message: 'The token owner is not an active user.' })
  }
  return { user, credential }
}
