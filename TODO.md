# TODO items

Work on these one at a time. Delete when the user confirms they're done:

- Adopt the short-description + "help" action pattern for all tools with complex usage
  (manage_cron, manage_knowledge, etc.) to reduce system prompt context size.
- Allow scoping subagent tool permissions to specific actions (e.g.,
  "manage_interlocutors.list" but not "manage_interlocutors.create"). Currently tool
  whitelisting is tool-level only.
