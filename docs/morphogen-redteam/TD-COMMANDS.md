# Morphogen v2 — TD → app command channel (v1)

_Architecture + operator note, added 2026-10-27. One page that ties together the
pieces landed 2026-10-21 → 2026-10-26 (parser, TD helper, contract fixture, both
tallies, Sync panel chip). The code comments stay the source of truth; this page
is the map. `tests/tdCommandsDoc.test.mjs` fails if the numbers below drift from
`src/sync/tdCommand.ts` or the contract fixture._

## Who owns what

| Side | File | Role |
| --- | --- | --- |
| Browser | `morphogen-v2/src/sync/tdCommand.ts` | The only parser for inbound TD frames (`parseTdCommand`), the rate gate (`createCommandGate`), the pong shape (`pongFor`), the tally line (`describeCommandStats`) and the TD RTT line (`describeTdRtt`). Pure, no DOM. |
| Browser | `morphogen-v2/src/sync/tdClient.ts` | `handleCommand` routes each authed frame through parse → gate → ping/apply and counts it in `commandStats()`; keeps the latest TD `status` RTT in `tdRtt()` (cleared on every fresh ack). |
| Browser | `morphogen-v2/src/ui/panels.ts` | `mountSyncCommandLine` shows the tally as the `#syncCmds` chip while the session is authed; `mountSyncRttLine` shows TD's latest RTT as the `#syncRtt` chip once a `status` frame arrived this session (amber when `lost` > 0). |
| TD | `morphogen-v2/td/morphogen_sync_commands.py` | Frame builders (`make_preset_command`, `make_ping_command`, `make_status_command` / `RttTracker.status_frame()`), `CommandPacer` (same bucket as the browser), `RttTracker` (RTT samples, 5 s lost-ping expiry, `describe_rtt`), `StatusHeartbeat` (when the next periodic status frame is due), `SendStats` / `describe_send_stats`. |
| TD | `morphogen-v2/td/morphogen_sync_callbacks.py` | `send_preset(dat, id)` / `send_ping(dat)` / `send_status(dat)` broadcast to **authed clients only**; `status_tick(dat)` is the every-frame-safe way to keep status flowing (≤ 1 per second, only while authed, immediate after a fresh ack, idle ticks untallied); pongs and lost / outstanding pings go to `morphogen_rtt` (`rtt_line()` prints one line), send tallies to `morphogen_cmds`, `send_stats_line()` prints one line. |
| Both | `morphogen-v2/tests/fixtures/td-commands.v1.json` | Golden contract: exact frame bytes, refusals, pong shape, gate verdicts and the shared RTT line (`rtt_lines`). Read by the node suite and by pytest. |

## Lifecycle

```mermaid
sequenceDiagram
  participant B as Browser (TdClient)
  participant T as TouchDesigner (callbacks)
  B->>T: hello {auth}
  T-->>B: {ack, ok:true}
  Note over B: tally reset, gate refilled to burst
  T->>B: {v:1, cmd:"preset", id:"coral"}
  Note over B: parse, gate, then createPresetCycler().set
  T->>B: {v:1, cmd:"ping", t:1000}
  B-->>T: {v:1, pong:"morphogen", t:1000}
  Note over T: RttTracker updates morphogen_rtt
  T->>B: {v:1, cmd:"status", rtt:{last_ms, median_ms, samples, outstanding, lost}}
  Note over B: tdRtt() keeps the latest, describeTdRtt prints it
```

Nothing is parsed as a command before the ack. A fresh ack (reconnect, new
session) resets the browser tally and refills the gate; TD resets `SendStats`
and its pacer when a new client authenticates.

## Frames

Accepted (v1):

- `{"v":1,"cmd":"preset","id":"coral"}` switches the Field preset. Ids are
  trimmed and lower-cased; an unknown but well-formed id parses fine and is a
  no-op in `createPresetCycler().set`.
- `{"v":1,"cmd":"ping","t":1000}` is answered by TdClient itself with
  `{"v":1,"pong":"morphogen","t":1000}`. A missing or non-finite `t` echoes as `null`.
- `{"v":1,"cmd":"status","rtt":{"last_ms":8.0,"median_ms":9.5,"samples":3,"outstanding":0,"lost":1}}`
  (added 2026-10-29) carries TD's own round-trip figures, the same fields as
  the `morphogen_rtt` table, so the browser can see lost pings that only TD
  can detect. Every field is required; ms values are `null` (no pong yet) or
  0 to `MAX_STATUS_MS`, counts are integers 0 to `MAX_STATUS_COUNT`, and one bad
  field refuses the whole frame. The browser keeps the latest one per session
  (`tdRtt()`, and `tdRtt` in the `?debug=1` snapshot) and `describeTdRtt` prints
  the same line TD's `rtt_line()` does. It counts as `applied` and spends a gate
  token, so send it from a slow timer (about once a second). Adding it was not
  wire-breaking: an older browser simply counts it as `refused`.

Refused (parse returns `null`, frame dropped, session untouched):
`setParams` and `freeze` (reserved until they get their own limits review),
any `v` other than `1`, missing `cmd`, arrays, non-JSON, malformed preset ids,
and anything over the size cap.

## Limits

| Limit | Value | Constant (browser / TD) |
| --- | --- | --- |
| Max frame size | 512 B | `MAX_COMMAND_BYTES` |
| Max preset id length | 32 chars | `MAX_PRESET_ID_LEN` |
| Sustained command rate | 10 per second | `COMMAND_RATE_PER_S` |
| Burst | 5 frames | `COMMAND_BURST` |
| Max status RTT value | 3600000 ms | `MAX_STATUS_MS` |
| Max status counter | 1000000000 | `MAX_STATUS_COUNT` |

The gate is a token bucket. A backwards or non-finite clock refills nothing, so
a bad timestamp can only make it stricter. Refused frames are counted **before**
the gate and do not spend a token; pings **do** pass through the gate.

## Reading the two tallies side by side

The browser counts what it **received** (`TD cmds: …`, in the `#syncCmds` chip
and the `?debug=1` snapshot as `tdCommands`). TD counts what it **tried to send**
(`TD sent: …` from `send_stats_line()`, rows in `morphogen_cmds`). Within one
session, `applied + pings + refused + paced === frames` on the browser side.

| What you see | Likely meaning | What to check |
| --- | --- | --- |
| TD `presets` matches browser `applied` | Healthy. | Nothing. |
| TD `with no authed client` grows, browser chip hidden | No authed browser: TD dropped the send locally. | `Syncsecret` on the TD COMP, the browser's Sync URL, the Sync chip state. |
| TD `paced` grows | TD's own pacer held the frame back; it never hit the wire. | Slow the cue stack or spread cues out. |
| Browser `paced` grows (chip turns amber) | Frames reached the browser faster than 10/s burst 5, so TD's pacer was bypassed or the clocks disagree. | Something sending without `send_preset` / `send_ping`; a second TD sender. |
| Browser `refused` grows | TD sent frames this build doesn't accept (reserved command, newer `v`, bad id). | TD script version vs. this contract; the fixture's `browser_refuses` list. |
| Browser `handler errors` > 0 | The preset handler threw; telemetry kept flowing. | Browser console, `main.ts` preset routing. |
| `morphogen_rtt` `lost` grows (or `rtt_line()` ends in `· N lost`) | Pings got no pong within 5 s (`RttTracker.timeout_ms`), or were pushed out by the 32-outstanding cap. Late pongs are ignored. | Network, the browser tab being backgrounded or frozen, reconnect count in the Sync chip. |
| `#syncRtt` chip never appears while `#syncCmds` is live | TD hasn't sent a `status` frame since this session's ack (the chip waits for one, so it never shows the previous session's figures). | Call `status_tick(dat)` every frame (e.g. an Execute DAT's `onFrameStart`) or `send_status(dat)` from a ~1 s timer; `TD sent:` should show `statuses`. |
| Browser `tdRtt` line (or the amber `#syncRtt` chip) ends in `· N lost` but TD's `rtt_line()` looks fine | The browser shows TD's figures as of the last `status` frame, so it lags by up to one status interval. | Whether `status_tick` / `send_status` is still being called; `TD sent:` should show a climbing `statuses` count. A paced-out status waits a full interval before the next try. |
| `outstanding` stays above 0 but `lost` stays 0 | Pings in flight younger than the timeout; expiry is checked on the next ping or pong, not on a timer. | Send another ping, or wait for the next cue. |

## Changing the contract

1. Edit the rule on **both** sides (`tdCommand.ts` and `morphogen_sync_commands.py`).
2. Update `tests/fixtures/td-commands.v1.json` (bump `version` and the file name
   for a wire-breaking change).
3. Update the Limits table above if a number moved.
4. Run `npm test` in `morphogen-v2/` and the TD pytest suite; both must pass.
