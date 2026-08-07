# Spike S1 — NDJSON stdin turn injection

**Task**: T011 | **Gates**: US2 (corrections) | **Research**: R1, S1 | **Date**: 2026-08-05

## Question

Can a user-turn frame written to a live agent process's stdin **mid-request** reach the in-flight request, so a
correction lands in the same conversation without restarting the process (FR-044, FR-049)? And if it can, what
is the frame shape, what is the delivery latency, and is the turn delivered to the running request or queued
behind it?

## What was run

**No real `claude` invocation with a prompt was made. Nothing here cost inference.** Two evidence sources only:

1. **A runnable harness against a stub agent process** — `spike-stdin.ts` spawns `stub-agent-main.ts` as a
   genuine child process over genuine pipes. The stub speaks the same NDJSON protocol, produces a deliberately
   slow multi-chunk response, and consumes stdin on its own loop while responding. The harness starts a
   response, waits until it is demonstrably running, writes a second user turn, and records what happened.
   Covered by `spike-stdin.test.ts` and `stub-agent.test.ts`; run with `pnpm exec vitest run`.
2. **Static inspection of the shipped CLI** — `claude --help` (free), plus string extraction from the installed
   binary (`claude` 2.1.222). No prompted session, no API call.

## What was observed — against the stub

A representative run (`injectAfterChunks: 3`, `chunkCount: 10`, `chunkDelayMs: 30`), frames in arrival order:

```
 0 @497ms system                                    (session init)
 1 @499ms user                                      (replay of the opening turn)
 2 @532ms assistant  chunk 0 for first task
 3 @564ms assistant  chunk 1 for first task
 4 @597ms assistant  chunk 2 for first task
 5 @597ms user                                      (replay of the injected turn)
 6 @597ms assistant  injected:correction            <- received mid-request
 7 @627ms assistant  guided:correction chunk 3 ...  <- same request, changed output
...
13 @819ms assistant  guided:correction chunk 9 ...
14 @819ms result                                    (num_turns 1)
```

- `deliveredMidRequest: true` — the acknowledgement (frame 6) precedes the only `result` (frame 14).
- `behaviourChangedMidRequest: true`, `guidedChunkCount: 7` — output produced by the **same** request changed
  after the injection. Arriving during a request and steering one are separate claims; both hold here.
- `resultFrameCount: 1`, `exitedBeforeResult: false`, one PID throughout, `exitCode: 0` — no restart, and the
  conversation was never torn down and rebuilt (FR-044).
- `injectionLatencyMs: 0` — sub-millisecond. This measures pipe plus event-loop scheduling and nothing else.

**What this proves**: the transport is sound. A line written to a child's stdin part-way through a streaming
response is visible to that child immediately, and a process that reads its input on a separate loop from its
response generation can act on it before the response finishes. It also gives T057 the harness it needs.

**What this does not prove**: anything about the real CLI's internal scheduling. The stub was written to steer;
that it does is a statement about the stub.

## What was observed — from CLI flags and shipped strings

Facts about the real CLI, established without inference:

| Fact                                                                                                                                                               | Source                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `--input-format stream-json` requires `--print`, and requires `--output-format stream-json`                                                                        | `--help`, plus the binary's own error strings                                                            |
| `--output-format stream-json` requires `--verbose`                                                                                                                 | binary error string (matches R1's known constraint)                                                      |
| stdin is consumed as a stream for the whole session, not read once at start                                                                                        | binary error text: reading stream-json input "requires a readable stdin for the lifetime of the session" |
| `--replay-user-messages` re-emits stdin user messages on stdout "for acknowledgment", valid only with both stream-json formats                                     | `--help`                                                                                                 |
| Output frame types: `system`, `assistant`, `user`, `result`, `stream_event`, `control_request`, `control_response`                                                 | binary strings                                                                                           |
| `result` frames carry `session_id`, `num_turns`, `total_cost_usd`; subtypes include `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution` | binary strings                                                                                           |
| A `control_request` channel exists on the same stream, with an `interrupt` subtype                                                                                 | binary strings                                                                                           |
| `--session-id <uuid>` and `-r/--resume` exist as documented                                                                                                        | `--help`                                                                                                 |

Two of these are load-bearing beyond S1:

- **`--replay-user-messages` is the acknowledgement channel.** It is why `AgentAdapter.sendTurn` returns
  `AgentTurnDelivery { acknowledged, latencyMs }` rather than `Promise<void>`: a correction that cannot be
  confirmed must be reported as unconfirmed, not as delivered (T093, FR-049).
- **`control_request` / `interrupt` is a candidate lever for `quiesce`**, separate from user turns. Worth
  evaluating in T056 before implementing quiesce as "wait for the next `result`".

The stub's frame vocabulary was taken from this list rather than invented, so the adapter written against the
stub is being written against a faithful subset.

## What was NOT observed

Stated plainly, because a spike that reports an unverified conclusion is worse than one that reports a gap:

- **The answer to the actual S1 question.** Whether the real CLI delivers a mid-request stdin user turn to the
  in-flight request or queues it until the current turn ends is **not observed**. It cannot be determined from
  flags or strings, and determining it requires a prompted session, which costs money.
- **The accepted frame shape.** The stub accepts both content shapes (bare string and text-block list). Which
  the real CLI accepts, and whether it requires additional fields, is **not observed**.
- **Real delivery latency.** The sub-millisecond figure is the stub's. The real figure is bounded below by it
  and otherwise unknown.
- Whether an injected turn counts against `--max-turns`; behaviour when a turn is injected during tool use
  rather than during text generation; behaviour of `--replay-user-messages` under load. All **not observed**.

## Decision

**Proceed with NDJSON stdin as the primary implementation (R1's decision stands). Do not adopt the SDK
fallback.** Nothing observed argues against the mechanism, and three things argue for it: stdin is explicitly a
session-lifetime stream, a dedicated acknowledgement flag exists for exactly this input mode, and the transport
works as required under test.

**S1 is closed on mechanism and open on scheduling.** Before T056 relies on _mid-turn_ steering, one real
invocation must answer the in-flight-versus-queued question. That run belongs at the start of T056, not here,
and it is one prompt.

**Why that residual risk is affordable**: FR-044 asks for additional user turns on the input stream without
ending the session. Even in the worse case — the CLI queues the turn until the current turn boundary — that
requirement is still met without a restart, and only correction _latency_ changes, bounded by one turn. The
case that would force the fallback is the CLI rejecting or ignoring stdin turns entirely, which the existence
of `--replay-user-messages` makes unlikely.

**And if it does force the fallback**: `adapter.ts` (T035) is in place, so the Agent SDK is a swap of one
module rather than a rewrite. That was the point of building it first.
