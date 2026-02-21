# Decision log

Architectural decisions made during discussion. Only decisions from user discussion are recorded here. Format: "Decision: Reason".

- Plugin init scripts use conventional filenames, not manifest fields: Avoids requiring a manifest change. If the file exists, it runs.
- Init scripts run on both install and update: Ensures setup steps are re-run when plugin code changes (e.g., new dependencies, schema migrations).
- Init script output is returned to the agent: Lets init scripts report generated data (credentials, setup results) back to the agent.
