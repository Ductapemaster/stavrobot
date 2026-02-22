# Decision log

Architectural decisions made during discussion. Only decisions from user discussion are recorded here. Format: "Decision: Reason".

- Internal HTTP listener on port 3001 for inter-service communication: Avoids distributing the app password to every container that needs to call back. Network-level isolation instead of auth.
- Init scripts declared in manifest, not conventional filenames: Needed a place to put the `async` flag. Manifest field is explicit and extensible.
- Init scripts run on both install and update: Ensures setup steps are re-run when plugin code changes (e.g., new dependencies, schema migrations).
- Init script output is returned to the agent: Lets init scripts report generated data (credentials, setup results) back to the agent.
- Async execution is opt-in per tool/init via manifest: Sync is the default. Async adds complexity and should only be used for long-running operations.
- Async timeout is 5 minutes, sync timeout is 30 seconds: Async scripts don't block the runner, so a longer timeout is safe.
- Unified tool-runner and plugin-runner into a single plugin-runner container: Eliminates duplicate code and simplifies the architecture. Unix user isolation per plugin is sufficient — there is no need for container-level separation between locally created tools and git-installed plugins. Editability is determined by the presence of a `.git` directory and enforced by the main app before dispatching coding tasks.
