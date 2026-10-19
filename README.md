# session-recovery

Continue interrupted Paseo sessions after a daemon restart. The plugin records observed turns and sends a continuation to unfinished sessions after a delay. It does not wake old idle sessions on installation.

## Defaults

| Setting | Default |
| --- | --- |
| Automatic recovery | On for eligible main sessions |
| Initial delay | 60 seconds |
| Maximum attempts | 3 per interruption |
| Recovery window | 24 hours since last observation |
| Automatic subagent recovery | Off |
| Temporary provider error retries | Off |

The delay doubles after each attempt, up to 15 minutes. Attempt counts survive daemon restarts. A normal completion or an explicit stop ends the recovery incident.

## Review and control

Open **session-recovery** in the sidebar. Settings are in the upper-right corner and under Paseo's plugin settings.

- **Recovery queue:** scheduled continuations and interruptions that need review.
- **Watching:** observed turns, including pending user input.
- **History:** completed, stopped, and dismissed records.
- **Excluded:** sessions excluded from recovery.

**Resume…** previews the continuation message and rechecks the session before sending it. **Dismiss** ends a pending recovery and releases its cleanup protection. **Exclude recovery** also excludes future turns until you allow them again. Command Center has per-session exclusion and inclusion actions.

Turning automatic recovery off leaves monitoring and manual review available. Settings are shared by clients connected to the same daemon.

## Recovery rules

Explicit stops and completed turns are never automatically resumed. Pending questions and approvals require user input. Archived or missing sessions, unavailable history, and unavailable workspaces are excluded. Subagent recovery checks every parent; an active, archived, missing, or excluded parent blocks it. Provider-internal subagents are outside this plugin's scope.

Unknown interruptions go to review. Temporary provider errors are retried only when enabled and when their code is recognized. Uncertain delivery is not automatically retried, even after another restart. Open the conversation to check the result.

Worker birth times distinguish daemon restarts from plugin reloads, including when the supervisor stays alive. Graceful shutdown detection uses Paseo 0.11.4's removal of its local credential before closing sessions. A runtime close without shutdown evidence requires review.

Lifecycle hooks are live and best effort. Missed events can leave an interruption unclassified. The plugin checks the latest completion, activity, permissions, archive state, and conversation timestamp before recovery. Paseo 0.11 has no atomic send-if-idle request, so a concurrent user action can still race submission. The request uses steering if a turn starts concurrently; providers may fall back to replacing a turn. Exclude sessions where this tradeoff is unacceptable.

Recovery starts a new turn using saved conversation history and current project state. The default message asks the agent to check existing work before repeating commands or external actions. It cannot restore a killed process or guarantee that an external action will not be repeated. Normal provider usage and billing apply.

## Cleanup integration

The paired **session-janitor 0.1.2+** reads the recovery protection list. Unresolved recovery protects sessions and their descendants from cleanup and manual tree deletion. Dismiss or exclude a candidate to release it. Protections remain if recovery is disabled or removed; resolve the candidates before removing it.

Other cleanup scripts do not read this list. Their configuration is not changed.

## Install locally

Requires a macOS or Linux daemon running **Paseo >=0.11.4 <0.12.0** and a provider with persistent history. The UI supports compact clients.

```sh
npm ci --ignore-scripts
npm run typecheck
paseo plugin install /absolute/path/to/paseo-session-recovery
```

Reload changes with `paseo plugin reload session-recovery`. A daemon restart is not needed.

## Local data

Session IDs, titles, providers, turn IDs, timestamps, attempt counts, exclusions, and recent outcomes stay under `plugin-data/session-recovery/` in the daemon's Paseo home. `state.json` is the journal, `holds.json` is the cleanup protection list, and `worker.lock` prevents duplicate monitors. Files use owner-only permissions. Journal writes use sync and atomic rename.

Conversation bodies, raw provider errors, tokens, and credentials are not stored in the journal. The local credential is read in memory to authenticate to the owning daemon's loopback listener or Unix socket. Continuations go through the session's existing provider. No other external service is used.

The startup connection uses a version-pinned adapter because Paseo 0.11.4 has no SDK context at plugin entry startup. Compatibility is capped at 0.11.x.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests simulate restarts, stops, approvals, lost responses, retry limits, concurrent user actions, and storage failures. They do not restart the real daemon or resume user sessions.
