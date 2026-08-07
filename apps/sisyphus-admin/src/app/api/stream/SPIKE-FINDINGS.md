# Spike S3 — live-log transport under connection pooling

Task T013. Closes the open question in `research.md` R6: `LISTEN/NOTIFY` needs a pinned session, and
transaction-mode pooling does not provide one. Run 2026-08-06.

**Verdict: `LISTEN/NOTIFY` through a transaction-mode pooler fails, and it fails silently. T065 should
implement R6's first fallback — in-handler short-poll of `log_segments` by `(workflow_id, sequence)` at a
250 ms interval — behind the unchanged SSE contract.** Measured p95 238 ms, 100% of segments visible
inside SC-002's 5-second budget, nothing lost or duplicated across a mid-stream recycle.

## What was actually run

|              |                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database     | PostgreSQL 17.5 (Debian, aarch64), container `sisyphus-pg`, port 55432, all 35 Sisyphus tables migrated                                                                                                                                  |
| Pooler       | **PgBouncer 1.24.0**, `pool_mode = transaction`, `default_pool_size = 5`, `max_client_conn = 100`, `server_reset_query_always = 0` (default), listening on host port 56432                                                               |
| Pooler image | Built locally from `alpine:latest` + `apk add pgbouncer` — the published `edoburu/pgbouncer` and `bitnami/pgbouncer` images would not pull in this environment. Same binary, config written by hand rather than generated from env vars. |
| Driver       | `postgres` v3, `prepare: false`, `max: 2` on every connection in every scenario                                                                                                                                                          |
| Table        | The real `log_segments`, including its `(workflow_id, sequence)` unique index and its FK to `workflows`. Fixture rows seeded and torn down; the database is left empty.                                                                  |
| Load         | 300 segments at 10/s (150 for the recycle scenarios), then a 6-second settle before scoring                                                                                                                                              |
| Clocks       | Producer and consumer share one Node process, so latency is `observedAt − producedAt` on one clock with no skew                                                                                                                          |

The producer is **identical in every scenario** — always a direct connection, always insert-and-`pg_notify`
in one statement — so the only variable is the consumer's transport. `NOTIFY` is transactional, so a
notification can never describe a row a reader cannot yet see.

`fractionWithinBudget` is scored against segments **produced**, not segments received. A transport that
drops the stream and delivers nothing would otherwise score 100%.

## Q1 — does `LISTEN/NOTIFY` break under transaction pooling, and how?

**It breaks, and it breaks silently.** This is the dangerous answer R6 feared.

- The `LISTEN` statement **succeeds**. `listenEstablished = true`. No exception, no error frame, no
  connection close. `transportErrors = 0` for the entire 30-second run.
- **0 of 300 notifications were delivered.** The client sat on a healthy-looking connection receiving
  nothing, indistinguishable from a workflow producing no output.
- The failure is visible in exactly one place — PgBouncer's own log:

  ```
  WARNING S-0x…: sisyphus_test/sisyphus@172.17.0.2:5432 got packet 'A' from server when not linked
  ```

  `'A'` is the wire protocol's `NotificationResponse`. **1635 such warnings** were logged across the run,
  against 1650 notifications emitted. The pooler receives every notification on a server connection that
  is no longer linked to any client, warns, and discards it. Nothing propagates to the application.

**A second, worse finding not anticipated by R6: the `LISTEN` registration leaks into the pool.** Because
`server_reset_query` (`DISCARD ALL`) is not applied in transaction mode by default, the registration
survives the client that created it. Minutes after the listening client disconnected, a fresh unrelated
client through the pooler reports:

```
select pg_listening_channels()  →  sisyphus_log_segment      (through PgBouncer)
select pg_listening_channels()  →  <none>                    (direct)
```

So a panel request that lands on a poisoned server connection inherits a stranger's subscriptions, and the
pooler goes on burning a warning per notification forever. It also means the failure is **not
deterministic**: with a single idle client the same server connection is handed back each time and a
`LISTEN` can appear to work, which is precisely how this reaches production undetected. Session-mode
pooling — R6's third option, listed last — is the only pooled configuration in which any of this is safe.

## Q2 — latency distribution (SC-002: ≥95% visible within 5 s)

Sample size is `received / produced`.

| Scenario                                 | n       | p50    | p95    | p99     | max     | <5 s     | SC-002   |
| ---------------------------------------- | ------- | ------ | ------ | ------- | ------- | -------- | -------- |
| (a) `LISTEN/NOTIFY` via pooler           | 0/300   | —      | —      | —       | —       | **0.0%** | **FAIL** |
| (b) `LISTEN/NOTIFY` direct (pinned)      | 300/300 | 0 ms   | 0 ms   | 1 ms    | 1 ms    | 100.0%   | PASS     |
| (c) poll by sequence via pooler, 250 ms  | 300/300 | 119 ms | 238 ms | 251 ms  | 252 ms  | 100.0%   | PASS     |
| (d) poll by sequence via pooler, 1000 ms | 300/300 | 499 ms | 902 ms | 1000 ms | 1000 ms | 100.0%   | PASS     |

Polling latency is entirely the poll interval — p50 ≈ interval/2, p95 ≈ interval, max ≈ interval — with no
measurable query or pooler cost on top at 10 segments/s. That is the useful shape: the interval is a
directly chosen latency budget, and even a 1-second interval clears SC-002 by a factor of five. 250 ms is
proposed as the default because it leaves four doublings of headroom before the budget is at risk under
load this spike did not apply.

## Q3 — runtime recycle mid-stream

The consumer is stopped after 50 segments and reopened 3 seconds later from its own last observed
sequence, **while the producer keeps writing throughout** — an instance going away does not pause the
executor. Reconciliation is by sequence.

| Scenario                                                             | n       | p50    | p95     | max     | lost   | duplicated |
| -------------------------------------------------------------------- | ------- | ------ | ------- | ------- | ------ | ---------- |
| (e) poll 250 ms via pooler, recycled                                 | 150/150 | 156 ms | 2412 ms | 3113 ms | **0**  | **0**      |
| (f) `LISTEN/NOTIFY` direct, recycled, sequence backfill on reconnect | 150/150 | 0 ms   | 2229 ms | 2929 ms | **0**  | **0**      |
| (g) `LISTEN/NOTIFY` direct, recycled, **no** backfill (control)      | 120/150 | 0 ms   | 0 ms    | 0 ms    | **30** | 0          |

**Nothing is lost and nothing is duplicated, provided the reconnect path is a sequence read.** The p95 in
(e) and (f) is the 3-second downtime itself, arriving as a burst on reconnect — still inside SC-002.

(g) is the control that makes the rule non-negotiable: a pure live-tail that re-`LISTEN`s loses exactly the
downtime window — 30 segments at 10/s over 3 seconds, a clean 20% hole with no error anywhere. Notifications
emitted while nobody is listening are gone for good. **The reconnect must be a `sequence > lastRendered`
read of `log_segments`, never a bare re-subscribe**, whichever transport T065 uses.

Duplication is prevented by the reconciler's high-water mark: the client passes its last rendered sequence,
so a replayed tail is dropped rather than double-rendered. This is what makes an at-least-once transport
safe to retry, and it is why `appendLogSegment`'s idempotence on `(workflow_id, sequence)` matters upstream.

## What T065 should implement

1. **Transport: in-handler short-poll of `log_segments` by `(workflow_id, sequence)`**, default interval
   250 ms, configurable. R6's first fallback, unchanged.
2. **Keep the SSE contract exactly as specified.** `formatSseFrame` puts the sequence in the SSE `id:`
   field, so a reconnecting `EventSource` resumes via `Last-Event-ID` on the same key the transport
   reconciles on, rather than inventing a second one.
3. **Always backfill on connect** from the client's high-water mark, before going live. Not optional.
4. **Do not use `LISTEN/NOTIFY` behind a transaction-mode pooler**, and do not treat a successful `LISTEN`
   as evidence the transport works. If an always-on stream process with a pinned direct connection is ever
   adopted (R6's second fallback, measured here as (b): p95 0 ms), it must still backfill by sequence on
   reconnect — see (g).
5. If any deployment ever does run `LISTEN/NOTIFY` through a pooler, **alarm on the absence of segments**,
   not on errors. There are no errors.

## Not observed

Stated plainly, because an unverified conclusion is worse than an admitted gap.

- **The CDN and Lambda halves of S3's original question were not tested at all.** No cloud resources were
  created. This spike answers the _database transport_ question only. Both are written up as open ends
  below, with what would settle each and what the current design does and does not do about them.
- **No browser was involved.** Latency is measured to the Node consumer, not to an `EventSource` in a page.
  The SSE framing is unit-tested, not end-to-end tested.
- **RDS Proxy was not tested.** PgBouncer 1.24 in transaction mode is a realistic stand-in, and RDS Proxy's
  documented behaviour differs — it pins a connection on some session-state statements — so its handling of
  `LISTEN` specifically is untested here and should not be assumed to match.
- **No 10-minute soak.** S3's exit criteria mention no dropped notifications over a 10-minute stream; the
  longest run here was 30 seconds of production plus a 6-second settle.
- **Single consumer, single workflow, 10 segments/s.** Fan-out was not measured: N concurrent panels each
  polling every 250 ms is a query-rate question this spike says nothing about. That is the main cost of the
  polling fallback and the number T065 should watch.
- **Burst and large-segment behaviour untested.** Fixed 512-byte segments at a steady rate; no bursts, no
  large payloads, no back-pressure.
- **`server_reset_query_always = 1` was not tried.** It would plausibly clear the leaked `LISTEN`
  registration, but it does not make notifications reach a client that is not holding the connection, so it
  would fix the leak and not the transport.

## The two open ends (T145)

R6 asked three things of S3. The database transport question is answered above, on measurement. The other
two cannot be reached from a laptop, and **no cloud resources were created to reach them** — so they are
not answered here either. What follows states each one precisely, says what would settle it, says what
production looks like if the answer is unfavourable, and — the part worth reading — says what in the code
as written already bounds the damage. Nothing below is a measurement. Where a number appears it is a
constant read out of the source, not an observation.

### First, a correction to a claim this document invited

The transport verdict above has been read as "polling was chosen partly because it does not depend on the
CDN or the runtime answers". Checked against the code rather than assumed, **that is half true, and the
half that is false is the more exposed one**:

- The **Lambda duration** question really is defanged by the transport plus the reconnect rule, and by a
  scenario this spike measured. See open end 2.
- The **CloudFront buffering** question is _not_ touched by it at all. Polling changed how the handler
  learns about a new segment; it did not change how the bytes reach the browser. The panel still opens an
  `EventSource` against `GET /api/stream/[workflowId]` and still needs `text/event-stream` to arrive
  incrementally through the distribution. Choosing polling moved the risk from the database side of the
  handler to nowhere — it was always on the response side.

### Open end 1 — does SSE survive CloudFront unbuffered?

**What is unknown, precisely.** Whether a `text/event-stream` response from the panel's function reaches
the browser _frame by frame_ through the CloudFront distribution in front of it, or is held and delivered
in blocks. Also unknown: whether the distribution's cache behaviour for `/api/stream/*` forwards the
`Last-Event-ID` request header, which is the reconnect path's high-water mark (`resume-point.ts` prefers
it over `?fromSequence=`, because after a reconnect the URL is stale by definition). Both are properties
of a deployed distribution. Neither has been observed.

**What would settle it.** A deployed non-production stage, and then:

1. `curl --no-buffer -N -H 'accept: text/event-stream' <cloudfront-url>/api/stream/<id>` against a
   workflow that is actively producing, with each line timestamped on arrival. Frames arriving ~250 ms
   apart is a pass; arriving in a clump is the failure. Run the same command against the function's own
   URL, bypassing the distribution, and compare — that comparison is what isolates CloudFront from
   everything else in the path.
2. The same against a workflow producing **nothing**, to see whether the 15 s keep-alive comment arrives
   on time or is swallowed. (Noticed while checking this: the 15 s in force is `pollLogSegments`' own
   default, because the route does not pass `keepaliveMs`. `SSE_KEEPALIVE_MS` in `sse.ts` holds the same
   number and is not wired to anything, so editing it would change no behaviour. Unrelated to this
   question, but it would mislead whoever tunes the keep-alive after measuring it.)
3. A second connection carrying `Last-Event-ID: 42`, checking the server resumes after 42 rather than
   replaying from 0 — which is only true if the distribution forwards the header.
4. A real browser, not curl: `EventSource` is the client that ships, and it is the one that has to fire
   `open`.

**What production looks like if the answer is unfavourable.** The live pane stops being live. Segments
would arrive in clumps, or — with full buffering — not at all until the run ends and the connection
closes. `EventSource` would sit in `CONNECTING` without firing `open`, so the pane's status chip would
read `connecting` and never `live` (`log-pane.tsx`). SC-002 fails. Nothing is lost: FR-047 keeps the
durable copies in S3 and Postgres regardless of whether anyone is watching, and the executor's report-back
is ordinary request/response on `/api/machine`, not SSE, so the **run itself is unaffected** — this is a
visibility failure, not a data one.

**What already limits the blast radius.**

- `SSE_HEADERS` sends `cache-control: no-cache, no-transform` and `x-accel-buffering: no`. Stated
  honestly: `X-Accel-Buffering` is an nginx convention, and **whether CloudFront honours it is exactly
  what is untested**. It is the right header to send and it is not evidence.
- The viewer does not depend on the stream for correctness. `useLogStream` merges the archived tRPC read
  (`workflow.logSegments`) with the streamed segments through one sequence-keyed reconciler, and the
  archived rows win where the two disagree. A reader who reloads sees the whole log whatever the stream
  did.
- The failure is loud rather than quiet, which is the opposite of the `LISTEN/NOTIFY` failure this spike
  found: a stream that never opens leaves the chip reading `connecting`, and a stream that opens and
  starves leaves it reading `live` with no lines beneath it. Neither looks like a finished run.
- Blast radius is one component. `log-pane.tsx` is a pure component and `use-log-stream.ts` is one hook;
  no other surface subscribes.

**The gap that is not covered, and should be said out loud.** There is **no client-side fallback**. The
archived query sets `staleTime` but no `refetchInterval`, and nothing else in `apps/sisyphus-admin`
refetches on a timer — verified by searching the app for `refetchInterval`, which appears nowhere. So if
the stream delivers nothing, the pane does not quietly degrade to a slower live view; it stops advancing
until the reader reloads the page. If open end 1 resolves unfavourably, **adding a `refetchInterval` to
the archived read while the run is non-terminal is the mitigation**, and it is a small change confined to
`use-log-stream.ts`. It has deliberately not been added pre-emptively: a poll that is always on doubles
the query cost of every open pane to insure against a risk nobody has yet measured.

### Open end 2 — behaviour at the Lambda response-streaming duration limit

**What is unknown, precisely.** What the effective ceiling on one open stream is, and how it ends when it
is reached. `[workflowId]/route.ts` exports `dynamic = 'force-dynamic'` and **no `maxDuration`** — the
repository does not contain that export anywhere — so the ceiling is whatever the deployed function's
timeout is, a value nobody has chosen for this route. Also unknown: whether the connection is closed
cleanly at the limit (the browser sees an end of stream and reconnects) or torn down in a way that leaves
`EventSource` waiting, and whether a frame can be cut mid-write.

**What would settle it.** On the same deployed non-production stage: hold a stream open against a workflow
that is running but quiet, past the configured timeout, and record what the client observes at the
boundary — a clean close, an error, or a hang — and whether the reconnect that follows resumes without a
gap. Then repeat against a workflow producing continuously and diff the received sequences against the
`log_segments` rows to prove nothing was skipped across the boundary. Neither has been run.

**What production looks like if the answer is unfavourable.** Every long run's stream is cut on a fixed
cadence. Each cut costs a reconnect: `SSE_RETRY_MS` = 3 s of wait, then a fresh scope resolution and a
backfill query. The pane's chip reads `reconnecting` for those three seconds and then returns to `live`.
The real cost is not correctness but load — N open panels reconnecting on a short ceiling is a query
storm, and it lands on the same fan-out cost the polling transport already carries and that this spike
did not measure.

**What already limits the blast radius — and here the design genuinely does.**

- **The reconnect is a backfill by sequence, unconditionally.** `pollLogSegments` reads
  `sequence > lastRendered` as the first thing it does on every connection, before any wait; the comment
  in that module calls it "not an optimisation and not conditional", and the code matches — the read is
  outside every branch. So a connection cut at an arbitrary point resumes exactly where it stopped.
- **The high-water mark survives the cut without the client having to do anything.** `formatSseFrame` puts
  the sequence in the SSE `id:` field, `EventSource` replays the last `id:` it saw as `Last-Event-ID`, and
  `resolveResumePoint` prefers that header over the query parameter. There is no second identifier to keep
  in step and no client bookkeeping to get wrong.
- **This exact shape was measured, locally.** Scenario (e) above — the consumer stopped mid-stream for
  3 seconds while the producer kept writing, then resumed from its own last sequence — lost 0 and
  duplicated 0 of 150 segments, and scenario (g) shows what it would have cost without the backfill: a
  clean 20% hole. Stated carefully: **(e) is not a Lambda timeout.** It is a local process being stopped
  and restarted. What it shares with a duration cut is the only thing that matters here — the reconnect
  path — and that path is proven. The cause is not.
- **Duplication is safe by construction if a frame is cut mid-write.** `createSequenceReconciler` drops
  anything at or below the high-water mark, and `parseSegmentEvent` returns `undefined` on anything that
  does not parse rather than throwing inside a listener. A truncated frame costs one dropped frame, and
  the next backfill re-sends the segment.
- **Most streams never reach the limit.** `pollLogSegments` closes itself one drain pass after the run
  reaches a terminal state, so short runs end long before any ceiling.

**What is still unbounded.** The ceiling itself is undeclared. If the deployed timeout turns out to be
short, the reconnect cadence is set by an accident of configuration rather than by a decision. Declaring
an explicit `maxDuration` on this route — deliberately below the platform limit, so the stream ends on a
boundary this repository chose and the client reconnects predictably — is the obvious follow-up, and it
is **not** done here: picking that number without knowing the platform limit would be inventing the
measurement this section exists to say was never taken.

### Summary

| Open end             | Answered? | Data at risk | Visibility at risk          | Bounded by                                                                 |
| -------------------- | --------- | ------------ | --------------------------- | -------------------------------------------------------------------------- |
| CloudFront buffering | **No**    | None         | **Yes — SC-002 would fail** | Headers that ask nicely; durable archived read; a loud, non-silent failure |
| Lambda duration      | **No**    | None         | 3 s per cut                 | Unconditional sequence backfill, proven by scenario (e); `Last-Event-ID`   |

Neither should be closed by argument. Both are one deployed stage and an afternoon away from being closed
by measurement, and until then the honest statement is the one above: not observed, here is what would
settle it.

## Reproducing

The live suite is gated and skips cleanly with no database present.

```sh
cd apps/sisyphus-admin
SPIKE_S3_DIRECT_URL='postgres://sisyphus:sisyphus@127.0.0.1:55432/sisyphus_test' \
SPIKE_S3_POOLED_URL='postgres://sisyphus:sisyphus@127.0.0.1:56432/sisyphus_test' \
SPIKE_S3_SEGMENTS=300 SPIKE_S3_RECYCLE_SEGMENTS=150 \
pnpm exec vitest run src/app/api/stream
```

The pooled scenarios additionally need a PgBouncer in `pool_mode = transaction` on 56432; without
`SPIKE_S3_POOLED_URL` they skip and the direct scenarios still run.
