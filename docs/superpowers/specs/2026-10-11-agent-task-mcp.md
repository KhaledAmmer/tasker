# Agent task consumption through MCP

Agents can discover accessible tasks assigned to the token owner, another user, or nobody; read task context; claim work; execute it using the agent's own tools; and submit a result for human review.

Personal tokens are generated in Settings, stored only as SHA-256 hashes, and can be revoked. Every call checks the owner's current active state, role, and project access. Tokens grant task-specific MCP operations only, not administrative or general API access.

Claims preserve the human assignee and expire after one hour. A run ID plus token identifies the claiming agent; renewing the same claim extends its lease. Competing live claims fail atomically. Claiming moves the task to `in_progress`; submission requires a nonempty result summary and moves it to `in_review`, recording a comment and activity in the same transaction. Projects with customized workflows may pass explicit work/review status keys; `todo` and `done` cannot be used as work/review targets. Missing statuses fail without changing data. Done, deleted, archived tasks and archived projects cannot be consumed. Existing ancestor completion rules apply.

MCP transport uses local stdio, following the recommended first version discussed with the user. The MCP server exposes tools, not an autonomous task executor: the connected agent performs the actual work before submission.
