# Agent Task MCP Implementation Plan

> Execute task-by-task in this session using native tools; retain the user's transport preference.

**Goal:** Let agents consume accessible tasks and submit completed work for human review through MCP.

**Architecture:** Personal token authentication resolves a current Tasker user, then uses shared project authorization and issue transition helpers. Atomic Convex mutations maintain renewable task claims and review submissions; a thin MCP adapter exposes these operations.

**Tech Stack:** TypeScript, Convex, Clerk, React, MCP TypeScript SDK, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-agent-task-mcp.md`

## Global Constraints

- Node 25.x and pnpm 11.x; preserve current project roles and task hierarchy rules.
- Preserve human assignments; do not complete tasks automatically.
- Store token hashes only; enforce current account/project access on every request.
- Work/review targets must exist in the project and cannot be `todo` or `done`.

## Review Focus

- Revoked tokens and inactive users must fail before data is disclosed or changed.
- Members must never see tasks in inaccessible projects; viewers cannot mutate.
- Concurrent runs cannot overwrite another live claim; expired claims can be replaced.
- Deleted/archived/done tasks and children of done parents cannot be consumed.
- Missing workflow statuses and empty result summaries must leave the task unchanged.

### Task 1: Authentication and claim workflow

**Files:** `convex/schema.ts`, `convex/agentTokens.ts`, `convex/agentTasks.ts`, `convex/lib/agentTokens.ts`, `convex/lib/auth.ts`, `convex/issues.ts`, `tests/agentTasks.test.ts`.

**Interfaces:** Token CRUD uses Clerk authentication. Agent functions accept `{ token }`; list accepts assignment scope/project/status filters, get accepts issue ID, claim/release/submitReview accept issue ID and run ID. Reuse `applyIssueUpdate` and extract `requireProjectViewAccessForUser`.

- [x] Add failing tests for token authorization, scope filters, claims, review submission, lease expiry, and hierarchy/workflow rejection.
- [x] Run tests and observe missing feature failures.
- [x] Implement schema, hash lookup, shared permission helpers, queries, and transactional mutations.
- [x] Run targeted tests and TypeScript checks.

### Task 2: MCP connection and user setup

**Files:** `mcp/server.ts`, `mcp/index.ts`, `tests/mcp.test.ts`, `src/features/tasker/agents/AgentConnectionCard.tsx`, `src/routes/_app.settings.tsx`, `package.json`, `README.md`, `AGENT.md`, `ROADMAP.md`.

**Interfaces:** MCP tools map directly to agent task functions; Settings creates and revokes personal tokens and displays client configuration.

- [x] Test tool discovery, validated arguments, dispatch, errors, and the task-to-review lifecycle over the actual MCP transport.
- [x] Implement the recommended local transport, token settings, setup examples, and agent instructions.
- [x] Run all tests, lint, TypeScript, and production build; update documentation with results.

## Verification results

- `pnpm test`: 25 files, 163 tests passed, including 25 new feature tests.
- `pnpm build`: passed with existing large-chunk warnings.
- `pnpm mcp:check` and `pnpm exec tsc -p convex/tsconfig.json --noEmit`: passed.
- `pnpm exec biome check --formatter-enabled=false --reporter=summary`: passed; changed Settings and agent UI files also pass full Biome formatting/lint checks.
- Full repository `tsc --noEmit` still reports 21 existing errors in unrelated UI/test files. Full Biome check reports 107 formatting errors in existing Windows CRLF files. These are outside the feature scope.
- Frozen-lockfile installation passes, and pre-existing dependency resolutions are preserved.
- No Convex deployment or Clerk credentials are configured in this checkout, so live workspace setup/deployment remains external to local verification. API declarations were regenerated with the installed Convex template because the normal codegen command requires `CONVEX_DEPLOYMENT`.
