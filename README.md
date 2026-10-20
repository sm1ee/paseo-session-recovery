# session-recovery

Recover interrupted Paseo sessions after a daemon restart. Use a toggle on each session to continue its current goal after a turn ends. Only goals you select are continued; new objectives need a new selection.

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
| Goal continuation | Off; each session also needs an explicit selection |
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

**Goal · On / Off** appears beside Tasks and Subagents above the message composer when a supported current goal is found. Open it to toggle **Continue this goal**, check its state and continuation count, or open settings. Sessions without a verified goal and completed or cleared goals have no pill. A previously selected goal with an unavailable state keeps the control so you can turn it off.

Goal sessions also have a toggle on their recovery card. Turning either toggle off cancels that goal's pending continuation while keeping interruption recovery available.

You can select a paused, blocked, or limited goal. Selection does not change its provider status or resume it. Automatic continuation waits until a later turn records the same objective as active.

**Resume…** previews the continuation message and rechecks the session before sending it. **Dismiss** ends a pending recovery and releases its cleanup protection. **Exclude recovery** also excludes future turns until you allow them again. Command Center has per-session exclusion and inclusion actions.

Turning automatic recovery off leaves monitoring and manual review available. Settings are shared by clients connected to the same daemon.

## Goal continuation

Enable **Continue selected goals** in settings, then turn on **Continue this session's goal** for the sessions you want. The settings switch is a master control; turning it on does not select any goals. You can also select an existing session from the Command Center.

After a normal turn ends, the plugin checks the goal, waits for the configured delay, then checks again before sending a continuation. If the provider has already started its own next turn, the plugin leaves that turn running.

Codex goals are read through the official `thread/goal/get` API. A local subprocess uses the configured Codex command and environment. It receives only initialization and goal lookup requests; it never loads or resumes a thread. Codex must support the goals feature and this API. An unavailable or unrecognized response requires review.

For OMP, the plugin reads structured `goal` tool results and Paseo's `omp_goal_updated` timeline records. It also reads structured `create_goal`, `get_goal`, and `update_goal` results, including compatible Pi goal extensions. Detection depends on the provider exposing these records in Paseo. Ordinary chat text, plans, and to-do lists are not treated as goals. Conversation inspection is bounded to the most recent 2,000 canonical timeline entries; an unverifiable state requires review.

Paused, blocked, completed, cleared, and limited goals are not automatically resumed. Questions, approvals, direct stops, exclusions, and uncertain delivery also block continuation. The continuation message asks the agent to verify its work before marking the goal complete. The plugin cannot independently prove that a provider's completed goal was actually achieved.

Selection is tied to the current objective in that session. A different objective, completion, or clearing the goal removes the selection. Existing goals from earlier plugin versions start unselected. An unselected goal does not create a cleanup hold just because it remains active.

The per-objective limit survives turns, daemon restarts, and cycling the toggle. A different objective gets a new count. Recreating the same objective retains its count; **Reset continuation count** at the limit explicitly resets it. Turning a session toggle off cancels pending goal continuation, and leaves active turns, uncertain delivery, approvals, and ordinary interruption recovery intact. No provider settings are changed.

## Recovery rules

Explicit stops and completed goals are never automatically resumed. A completed turn is only continued when goal continuation is enabled, the current goal is selected, and that goal is still active. Pending questions and approvals require user input. Archived or missing sessions, unavailable history, and unavailable workspaces are excluded. Subagent recovery checks every parent; an active, archived, missing, or excluded parent blocks it. Provider-internal subagents are outside this plugin's scope.

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

For a direct Git installation, use `paseo plugin add git:sm1ee/paseo-session-recovery --ref v0.3.1`. The public registry listing requires a separate review.

## Local data

Session IDs, titles, providers, turn IDs, timestamps, attempt counts, exclusions, goal fingerprints, selections and states, and recent outcomes stay under `plugin-data/session-recovery/` in the daemon's Paseo home. `state.json` is the journal, `holds.json` is the cleanup protection list, and `worker.lock` prevents duplicate monitors. Files use owner-only permissions. Journal writes use sync and atomic rename.

Composer visibility checks, goal continuation, and explicit goal selection inspect supported goal state and conversation records in memory. Connected clients check the unarchived session directory. Running sessions and visible goal controls are checked about every 15 seconds; other idle sessions about every minute. The daemon briefly caches these read-only results. Discovery does not select, schedule, or resume sessions, and still works when the automatic continuation setting is off. Conversation bodies, goal objectives, raw provider errors, API tokens, and credentials are not stored in the journal. The local credential is read in memory to authenticate to the owning daemon's loopback listener or Unix socket. Continuations go through the session's existing provider. No separate model or external review service is used.

The startup connection uses a version-pinned adapter because Paseo does not provide an SDK context at plugin entry startup. Stable 0.11.4 through 0.12.x are supported. On 0.12, workspace lookups include background workspaces. Unknown versions and prereleases pause recovery until compatibility has been checked.

A Paseo update does not normally require a plugin update. This plugin checks its daemon adapter more closely because it relies on the daemon's credential and process lifecycle. CI checks both the 0.11.4 and 0.12.0 plugin SDKs.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests simulate restarts, stops, approvals, lost responses, retry limits, concurrent user actions, and storage failures. They do not restart the real daemon or resume user sessions.
