# Agent observability

Task and planning pages share a compact communication network. **Open full
observability** opens `#/tasks/<id>/observability` or `#/planning/<id>/observability`, with individual agent sessions, model
connections, grouped tools, controller operations, an event timeline and event inspection.
Completed participants remain in grey. The compact network groups sessions by provider and
role so repair attempts do not continually add columns. Scroll to pan; the full view also has
zoom controls. Keyboard users can focus participants and select them with Enter or Space.
Moving dots follow the direction of active connectors, and active nodes have a pulsing outline,
a **Live** label and a visible description of the unfinished operation. Concurrent tool calls
keep the connector and label active until the last correlated call settles. Compact groups
retain the active session's label when other sessions have completed. Replay and stale reads
show static indicators; reduced-motion preferences keep the same status and labels without animation.

## What the network means

Participants and connections come from recorded activity, not the approved workflow's stage
list. An agent has separate connections to its backend model, its tools and the Grampus
controller. Independent review returns to the controller. A repair decision is a controller
event; a later implementation dispatch is a separate communication. No direct reviewer-to-
implementer conversation is invented.

Provider item activity, permission decisions, tool requests, progress and results are different
observations. In particular, authorisation does not establish execution or completion, and
finishing generation of a tool request does not mean that tool has finished running.
An unfinished tool becomes unknown when its provider turn ends without a retained result.
Observability never passes an evidence gate or establishes a settled process exit.

Select a participant to filter its events, then select an event to inspect its status, direction,
reported duration, bounded redacted preview, original journal identity and available correlation
identities. Related events use explicit session, run, item or result ids. Missing fields say
**Unavailable**. Unknown measurements never become zero. Hover over participants and connections
for their recorded status and activity details.

## Capture and resource measurements

- Codex app-server item starts and completions retain item and turn ids, tool names, reported
  status and duration. File-change items describe provider activity, including proposed changes;
  Grampus's existing permission events remain separate. Thread usage and coalesced streamed
  output keep their existing journal paths.
- Claude Agent SDK response boundaries retain the response identity and reported model. Tool
  requests retain tool-use, assistant message, request and parent-tool identities when supplied.
  Progress and tool results remain separate events. Final timing metadata retains reported turn,
  API and first-token timings when available. Existing usage snapshots remain authoritative for
  the task's spending calculations.
- The controller supplies checks, acceptance, reviews, repair policy decisions, stops and verified
  delivery from its existing journal. Repair explanations reuse the task timeline's presentation.

The observability page's token cards show the latest cumulative usage snapshot per session in the
loaded replay prefix. They are observations, not a replacement for the task's usage report or
spending gate. A window can omit sessions or measurements. Cache reads can overlap reported input
tokens; the cards are not added into a billing total. Per-tool token costs, every provider-internal
inference request, actual billed cost and backend network latency are not established locally.

## Live updates and historical replay

The authenticated `GET /api/v1/tasks/:id/observability` and
`GET /api/v1/kickoffs/:id/observability` read routes share a bounded chronological
projection, participant metadata and coverage notes. Responses identify their task or planning
subject explicitly. Planning reads only that conversation's session journal, before or after
conversion; its events have no task correlation until viewed through the linked task. Task reads
include linked planning and execution sessions once each, even when multiple versions link the
same planner. Both views retain the original event identities. Deleted conversations and sessions
that are not planning conversations are unavailable through the planning route.
The projection is cached by subject, cursor and journal revision. The default
refresh interval is one second (`observabilityIntervalMs`). Polls do not overlap and stop while
the page is hidden or replay is selected. Streamed text still has its existing buffering interval,
so its visibility also depends on when that buffer is flushed.

The scrubber, Previous event, Next event and Play replay controls fold only server-decided
display updates through the selected event. Current participant states never seed historical
replay. **Load earlier events** reads the preceding window and pauses live polling. **Return to
live** resumes journal observations. Playback does not dispatch any operation.

Events are displayed by recorded time with stable journal-kind and sequence tie-breakers.
Sequences belong to their original journals; clock ordering across journals is not causal proof.
Explicit correlation identities, rather than adjacency, establish relationships. Before the
loaded window, state is unknown. Previously unrecorded provider detail cannot be recovered.

## Storage, privacy and boundaries

There is no second state store and no journal migration. New provider observations use
`session_events`, fenced by the existing session/run ownership checks. The SQLite journal and
controller continue to own workflow truth. Capturing observations makes no additional model
calls and adds no prompt tokens. No permissions, dispatch retries or recovery rules change.

Pages contain at most 400 events by default, with a fixed maximum of 1000. Provider capture
retains selected metadata rather than raw frames or tool payloads. The API previews only selected
text through the existing secret-redaction helper, which also bounds its output. Prompts, tool
arguments, full tool results, raw check output and file contents are not exposed by this endpoint.
Redaction is best-effort; the authenticated local dashboard remains the access boundary.

The Vue client uses existing Nuxt UI controls, Tailwind and local SVG/CSS. ELK (`elkjs`, pinned
in the dashboard dependencies) calculates participant positions and orthogonal edge routes in a
local worker. Requests and responses have separate ports. Layout runs only when topology changes;
streaming, token counts and status updates keep existing positions. The default view fits its
container, with zoom and scrolling available for detail. No external graph service, CDN, provider
credentials or additional network permissions are required. The installed
application and its journal remain separate from development.

**Planned:** deeper provider-specific inference tracing where the pinned protocols can establish
it, richer whole-history aggregate metrics and comparison of attempts side by side.
