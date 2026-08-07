# Slash Command Integration

Slash commands are handled locally by the Linco Bridge connector inside a remote IM session. `src/command/index.js` dispatches commands, and more complex command logic is split into `src/command/*.js`.

Commands not listed here are passed through to the current Agent by default. Some native Agent commands only make sense in interactive CLI/TUI mode and may produce no output in bridge mode.

## Common Commands

| Command | Description |
| --- | --- |
| `/help` | Shows local commands available for the current Agent type. |
| `/status` | Shows current session, Agent, model, approval mode, and queue status. |
| `/session` | Shows current Claude/Codex native Agent session ID. |
| `/stop` | Stops the current Agent process while keeping the resumable session ID. |
| `/reload` | Refreshes current Agent memory and tries to prestart the process. |
| `/update` / `/upgrade` | Views, upgrades, or downgrades the linco-connect CLI. |
| `/remove-account` / `/delete-account` | Removes the current or specified Agent account configuration. |
| `/accounts --channel <channel>` | Lists configured account IDs for the specified channel. |
| `/base` | Shows Linco runtime, session runtime, and attachment directories. |
| `/get <path>` | Reads any ordinary local file accessible to the connector Node.js process and returns it to remote IM. |
| `/approve` | Shows the current approval mode. |
| `/approve manual` | Requires manual confirmation for later permission requests and dangerous operations. |
| `/approve auto` | Automatically confirms later permission requests and dangerous operations while keeping the default permission boundary. |
| `/approve yolo` | Attempts to use the Agent's native permission or sandbox bypass mode. |
| `/model` | Shows or switches the current Agent model. |
| `/reasoning` | Shows or switches Claude/Codex reasoning or effort. |
| `/settings` | Shows Claude/Codex model and reasoning settings. |
| `/settings apply --model <id> --reasoning <effort>` | Applies Claude/Codex model and reasoning settings in one step. |
| `/usage` | Shows token usage when available. |
| `/compact` / `/compress` | Triggers native context compaction if the Agent supports it. |

## Claude And Codex Commands

| Command | Description |
| --- | --- |
| `/pwd` | Shows the current project directory. |
| `/cd <path>` | Binds the specified directory as the current project and starts a new Agent session. |
| `/project` | Lists known projects from local records. Remote IM can render buttons for selection. |
| `/project --select <path>` | Selects a project and starts a new Agent session. |
| `/sessions [limit]` | Lists recent local Agent sessions for the current project. |
| `/bind <Session ID>` | Binds the current IM session to an existing Agent session in the current project. |
| `/history [limit]` | Shows recent history of the currently bound Agent session. Default is 3 rounds. |
| `/history-reload [limit]` / `/sync-history [limit]` | Refreshes local Agent memory, then reloads history. |
| `/pc` | Shows the command for opening the current Agent session on PC. |

Additional Codex commands:

| Command | Description |
| --- | --- |
| `/chats [limit]` | Lists Codex Desktop sidebar chats. |
| `/bind --chat <Chat ID>` | Binds to an existing Codex Desktop Chat. |
| `/history --chat <Chat ID> [limit]` | Previews a Codex Desktop Chat history without automatic binding. |

## Hermes Commands

| Command | Description |
| --- | --- |
| `/profile` | Shows Hermes Profiles and the current binding. |
| `/profile --bind <name>` | Binds the default Profile for future sessions under the current IM account. The current session Profile is not switched. |

## OpenClaw Commands

| Command | Description |
| --- | --- |
| `/agent` | Shows OpenClaw Agents and the current binding. |
| `/agent --bind <id>` | Binds the default Agent for future sessions under the current IM account. The current session Agent is not switched. |

## Removed Commands

| Command | Description |
| --- | --- |
| `/commands` | Removed. Use `/help`. |
| `/refresh` | Removed. Use `/reload`. |
| `/new`, `/list`, `/switch`, `/delete` | Removed. The current IM session is bound to one Agent session. Create a new session in remote IM when a new Agent session is needed. |

## Frontend Display

Frontend command lists should be filtered by `agentType`:

| Agent | Recommended display |
| --- | --- |
| Claude | `/pwd`, `/cd`, `/project`, `/sessions`, `/bind`, `/history`, `/history-reload`, `/pc`. |
| Codex | Claude commands plus `/chats`, `/bind --chat`, and `/history --chat`. |
| Hermes | `/profile`. |
| OpenClaw | `/agent`. |

Common commands such as `/help`, `/status`, `/stop`, `/reload`, `/base`, `/get`, `/approve`, `/model`, `/reasoning`, `/settings`, `/usage`, `/compact`, `/accounts`, and `/remove-account` can be shown when supported by the current mode.

## Structured Results

The following commands return `slash_command_result`; remote IM should render them by `command` and `data`:

| Command | Data shape |
| --- | --- |
| `/help` | `data.items[].command`, `data.items[].description`. |
| `/accounts` | `data.channel`, `data.accountIds`. |
| `/project` | `data.items[].path`, `data.items[].selectCommand`. |
| `/sessions` | `data.items[].id`, `data.items[].bindCommand`. |
| `/chats` | `data.items[].id`, `data.items[].historyCommand`, `data.items[].bindCommand`. |
| `/history` | `data.rounds`. |
| `/agent` | OpenClaw Agent list and binding actions. |
| `/profile` | Hermes Profile list and binding actions. |
| `/model` / `/settings` | Current values, available options, and apply commands. |

Every local command turn still ends with `turn_end`.
