# Lunagraph agent setup

Connect Claude Code, Codex and Cursor to the DNA in a chosen Lunagraph file.
This installer is independent of the optional lunagraph-skills library.
Design rules and working methods stay inside the selected file.

## Run

Requires Node.js 22.13 or later and the Lunagraph desktop app, signed in.

```sh
git clone https://github.com/lunagraph/agent-setup.git
cd agent-setup
node bin/lunagraph-dna.mjs
```

The wizard lists accessible files, asks which file to use, then shows agent
checkboxes. All supported agents are selected by default: press Enter for all,
Space to toggle an agent, or a to toggle all. Confirm to install. Mark the intended canvases, documents or elements as
DNA in Lunagraph first. A page name containing DNA does not create a mark.
The native DNA feature must be available in the running app and database.

The package is prepared for npm as @lunagraph/dna but is not yet published.
After publication, the intended command is `npx @lunagraph/dna`.

## What it installs

- A user-level MCP bridge pinned to the selected Lunagraph file.
- SessionStart and UserPromptSubmit hooks for Claude Code and Codex.
- A sessionStart hook for Cursor.

Hooks load the native DNA marks. Agents then read the marked documents,
canvas structure, rendered screenshots and referenced project workflows.
No app repository files are modified by the default wizard. No generic skills
plugin is required. The selected file becomes the default across these agents;
rerun setup to select another file.

Runtime and connection settings live under ~/.lunagraph/dna/.
MCP configuration is merged into ~/.claude.json, ~/.codex/config.toml and
~/.cursor/mcp.json. Hooks are merged into ~/.claude/settings.json,
~/.codex/hooks.json and ~/.cursor/hooks.json. Existing unrelated settings are
preserved. Restart agents and review their normal connection and hook trust
prompts. The installer never approves its own hooks.

The default desktop endpoint is http://127.0.0.1:21209/mcp. Use
`node bin/lunagraph-dna.mjs setup --url <url>` for another endpoint. Native
project_list, project_pick/project_open and mark_list tools are used; there
is no required DNA.md filename. Each MCP session binds to the chosen file,
so switching the active app tab does not redirect the agent.

## Limits

Current hook-capable clients are required. Cursor sessionStart context is
non-blocking. Hooks supply instructions and references; they do not prove
visual compliance or prevent every noncompliant action. Unavailable DNA is
reported instead of being replaced with generic design defaults.

The local HTTP connection must accept requests without interactive OAuth.
Cloud authentication, CI review-bot setup and npm publication are not included.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

Tests use a local mock MCP server and isolated fixture homes. No private
Lunagraph app source, project contents, credentials or installed settings are
part of this repository. The npm files allowlist includes only bin/, dna/
and LICENSE; npm also includes its standard package metadata and README.
