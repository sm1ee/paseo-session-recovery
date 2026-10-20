# session-recovery

Recover interrupted Paseo sessions after a daemon restart. Optionally continue a session when its turn ends but its goal is still active. Existing idle sessions are only included when you choose to watch their goal.

![Recovery and goal settings](assets/goal-settings.png)

## Defaults

| Setting | Default |
| --- | --- |
| Automatic recovery | On for eligible main sessions |
| Initial delay | 60 seconds |
| Maximum attempts | 3 per interruption |
| Recovery window | 24 hours since last observation |
| Automatic subagent recovery | Off |
| Temporary provider error retries | Off |
| Goal continuation | Off |
| Goal continuation delay | 60 seconds |
| Maximum goal continuations | 10 per objective |

The delay doubles after each attempt, up to 15 minutes. Attempt counts survive daemon restarts. A normal completion or an explicit stop ends the recovery incident.

## Review and control

Open **session-recovery** in the sidebar. Settings are in the upper-right corner and under Paseo's plugin settings.

- **Recovery queue:** scheduled continuations and interruptions that need review.
- **Watching:** observed turns, including pending user input.
- **Goals:** recorded goal states and their continuation counts.
- **History:** completed, stopped, and dismissed records.
- **Excluded:** sessions excluded from recovery.

**Resume…** previews the continuation message and rechecks the session before sending it. **Dismiss** ends a pending recovery and releases its cleanup protection. **Exclude recovery** also excludes future turns until you allow them again. Command Center has per-session exclusion and inclusion actions.

Turning automatic recovery off leaves monitoring and manual review available. Settings are shared by clients connected to the same daemon.

## Goal continuation

Enable **Continue active goals** in settings. After a normal turn ends, the plugin checks the goal, waits for the configured delay, then checks again before sending a continuation. If the provider has already started its own next turn, the plugin leaves that turn running.

Codex goals are read through the official `thread/goal/get` API. A local subprocess uses the configured Codex command and environment. It receives only initialization and goal lookup requests; it never loads or resumes a thread. Codex must support the goals feature and this API. An unavailable or unrecognized response requires review.

For OMP, the plugin reads structured `goal` tool results and Paseo's `omp_goal_updated` timeline records. It also reads structured `create_goal`, `get_goal`, and `update_goal` results, including compatible Pi goal extensions. Detection depends on the provider exposing these records in Paseo. Ordinary chat text, plans, and to-do lists are not treated as goals. Conversation inspection is bounded to the most recent 2,000 canonical timeline entries; an unverifiable state requires review.

Paused, blocked, completed, cleared, and limited goals are not automatically resumed. Questions, approvals, direct stops, exclusions, and uncertain delivery also block continuation. The continuation message asks the agent to verify its work before marking the goal complete. The plugin cannot independently prove that a provider's completed goal was actually achieved.

The per-objective limit survives turns and daemon restarts. A different objective gets a new count. Recreating the same objective retains its count; **Watch goal again** explicitly resets it. Use **Watch this session's goal** in the Command Center to include an existing session. No provider settings are changed.

## Recovery rules

Explicit stops and completed goals are never automatically resumed. A completed turn is only continued when goal continuation is enabled and its goal is still active. Pending questions and approvals require user input. Archived or missing sessions, unavailable history, and unavailable workspaces are excluded. Subagent recovery checks every parent; an active, archived, missing, or excluded parent blocks it. Provider-internal subagents are outside this plugin's scope.

Unknown interruptions go to review. Temporary provider errors are retried only when enabled and when their code is recognized. Uncertain delivery is not automatically retried, even after another restart. Open the conversation to check the result.

Worker birth times distinguish daemon restarts from plugin reloads, including when the supervisor stays alive. Graceful shutdown detection uses Paseo 0.11.4 and 0.12.0's removal of the local credential before closing sessions. A runtime close without shutdown evidence requires review.

Lifecycle hooks are live and best effort. Missed events can leave an interruption unclassified. The plugin checks the latest completion, activity, permissions, archive state, and conversation timestamp before recovery. Paseo 0.11 and 0.12 have no atomic send-if-idle request, so a concurrent user action can still race submission. The request uses steering if a turn starts concurrently; providers may fall back to replacing a turn. Exclude sessions where this tradeoff is unacceptable.

Recovery starts a new turn using saved conversation history and current project state. The default message asks the agent to check existing work before repeating commands or external actions. It cannot restore a killed process or guarantee that an external action will not be repeated. Normal provider usage and billing apply.

## Cleanup integration

The paired **session-janitor 0.1.2+** reads the recovery protection list. Unresolved recovery protects sessions and their descendants from cleanup and manual tree deletion. Dismiss or exclude a candidate to release it. Protections remain if recovery is disabled or removed; resolve the candidates before removing it.

Other cleanup scripts do not read this list. Their configuration is not changed.

## Install locally

Requires a macOS or Linux daemon running **stable Paseo >=0.11.4 <0.13.0** and a provider with persistent history. The UI supports compact clients.

```sh
npm ci --ignore-scripts
npm run typecheck
paseo plugin install /absolute/path/to/paseo-session-recovery
```

Reload changes with `paseo plugin reload session-recovery`. A daemon restart is not needed.

For a direct Git installation, use `paseo plugin add git:sm1ee/paseo-session-recovery --ref v0.2.0`. The public registry listing requires a separate review.

## Local data

Session IDs, titles, providers, turn IDs, timestamps, attempt counts, exclusions, goal fingerprints and states, and recent outcomes stay under `plugin-data/session-recovery/` in the daemon's Paseo home. `state.json` is the journal, `holds.json` is the cleanup protection list, and `worker.lock` prevents duplicate monitors. Files use owner-only permissions. Journal writes use sync and atomic rename.

With goal continuation enabled or an explicit Watch goal action, conversation records are inspected in memory. Conversation bodies, goal objectives, raw provider errors, API tokens, and credentials are not stored in the journal. The local credential is read in memory to authenticate to the owning daemon's loopback listener or Unix socket. Continuations go through the session's existing provider. No separate model or external review service is used.

The startup connection uses a version-pinned adapter because Paseo does not provide an SDK context at plugin entry startup. Stable 0.11.4 through 0.12.x are supported. On 0.12, workspace lookups include background workspaces. Unknown versions and prereleases pause recovery until compatibility has been checked.

A Paseo update does not normally require a plugin update. This plugin checks its daemon adapter more closely because it relies on the daemon's credential and process lifecycle. CI checks both the 0.11.4 and 0.12.0 plugin SDKs.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests simulate restarts, stops, approvals, lost responses, retry limits, concurrent user actions, and storage failures. They do not restart the real daemon or resume user sessions.
