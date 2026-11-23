# Design: model routing by task category

Date: 2026-11-14
Status: implemented in `snapgent-extension/background.js`

## Problem

The A2A facade originally sent every prompt to whichever provider tab was active.
That wastes quota on trivial work (reading one line, renaming a symbol) and
under-powers hard work (debugging, architecture, migration) by leaving the model
choice to chance.

The model must be chosen from the **task**, not from the tab the user happened to
leave in front.

## Principle

Route on two axes:

1. **Task category** - what the work actually needs.
2. **Complexity** - how much of it one prompt has to carry.

Model names are configuration, not code. Providers rename models every few
months, so the policy stores **tiers** and a small table maps each tier to an
ordered list of provider tabs.

## Task categories

| Category | Examples | Tier |
|---|---|---|
| `extract` | read one line, list files, pull a value | `light` |
| `summarize` | condense a file or a diff | `light` |
| `classify` | label, rename, pick an option | `light` |
| `code-edit` | small refactor, add a test, fix a typo | `balanced` |
| `debug` | trace a failure across files | `balanced` |
| `review` | check a diff against requirements | `deep` |
| `architecture` | design a module boundary, plan a migration | `deep` |
| `security` | audit an auth or data path | `deep` + human review |

Three categories pin their own provider list because one site is clearly better
regardless of tier:

| Category | Providers, in order | Why |
|---|---|---|
| `realtime` | grok, chatgpt, gemini | needs a search-first model |
| `chat` | rudder, mistral, gemini | plain conversation should not burn frontier quota |
| `orchestrate` | chatgpt, claude, kimi | ChatGPT is the long-running head manager |

## Tiers and the provider ladder

Order inside a list is fallback preference: the first provider with an **open
tab** wins. The ladder follows the real twelve accounts and their limits, not a
theoretical benchmark ranking.

| Tier | Provider order | Notes |
|---|---|---|
| `deep` | claude -> chatgpt -> kimi | Claude is the frontier worker, 5-hour window; Kimi is a mini server that is often busy and prioritises subscribers |
| `balanced` | deepseek -> gemini -> grok -> qwen -> glm -> kimi | DeepSeek first for cost; Grok for anything current; Gemini has 1M context but is the weakest at multi-step web-app work |
| `light` | deepseek -> gemini -> qwen -> glm -> mistral -> rudder | short, single-shot text |

Providers deliberately **not** in any text list:

| Provider | Why not | Limit |
|---|---|---|
| Ptero | non-text/chat work only | resets 1M per hour, routes to China models |
| Manus | non-text/chat work only | 300 credits, resets 00:00 WIB |
| Arena, Meta | untested; open tabs may still be used as manual fallback | unknown |

The table lives in `TIER_PROVIDERS`, `CATEGORY_PROVIDERS` and `CATEGORY_TIER` in
`snapgent-extension/background.js`. Model names never appear there: each tab
stays on whatever model the user selected in that site.

## Complexity

The harness may also declare `complexity: low | medium | high`. It maps to
`light`, `balanced`, `deep`, because a one-line rename inside a `code-edit` task
does not need a frontier model.

Metadata precedence, highest first:

1. `provider` (pin: one site, no fallback chain)
2. `modelTier` (explicit effort, wins over the guesses below)
3. `taskCategory` (names an actual provider list, e.g. `realtime` -> Grok)
4. `complexity` (effort only: picks the tier when no category list applies)

Category outranks complexity on purpose: a category names the sites that can do
the job, while complexity only says how hard the job is. `realtime` + `high`
still has to land on Grok - a generic `deep` tier would send it to Claude, which
cannot see the live page.

### Capability filters

A caller may declare what a task needs. The four flags are optional and are
applied **after** the precedence above, to the provider chain that precedence
already chose:

```json
{
  "method": "SendMessage",
  "params": {
    "metadata": {
      "taskCategory": "review",
      "needsVision": true,
      "needsWeb": true,
      "largeInput": true,
      "avoidProviders": ["claude"]
    },
    "message": { "parts": [{ "text": "..." }] }
  }
}
```

`PROVIDER_CAPABILITIES` in `background.js` holds the static booleans used by the
filters:

- `vision`: `gemini`, `glm`, `kimi`, `meta`, `arena`.
- `webSearch`: `chatgpt`, `deepseek`, `grok`, `mistral` (composer Search toggle).
- `largeInput`: `arena` (120k), `deepseek` (163,840), `qwen` (131,072).

All three filters run in that order — `needsVision`, then `needsWeb`, then
`largeInput` — then `avoidProviders` drops the named ids. Each filter removes
providers that lack the flag, keeping the remaining order. `tabForRoute` is
unchanged: it picks the first open tab in the filtered chain. If the filters
remove every provider, the route keeps the original chain and sets
`capabilityFallback: true`, so the existing fallbacks below still apply. With no
flags there is no filtering and routing is exactly the old behaviour.

Caveat: capability flags are static. DeepSeek and Qwen decide vision per model
through a getter in the content script, so `background.js` treats both as
`vision: false`. A `needsVision` flag therefore excludes them even when the
model selected in that tab can see images.

## Where the decision is made

The harness (Hermes, Claude Code, or another A2A client) knows the task category.
It sends it as A2A metadata:

```json
{
  "method": "SendMessage",
  "params": {
    "metadata": { "taskCategory": "debug", "complexity": "medium" },
    "message": { "parts": [{ "text": "..." }] }
  }
}
```

The flow is deliberately thin and testable:

```
A2A client
  -> a2a_server.py   validates metadata, passes it to submit()
  -> bridge.py       forwards metadata in the submit_prompt frame
  -> background.js   resolves tier -> provider list -> open tab
  -> content script  unchanged
```

`a2a_server.py` keeps the request shape; it does not choose a model.
`bridge.py` keeps transport; it does not choose a model.
`background.js` owns **one** function, `routeFor(metadata)`, plus
`tabForRoute(tabs, route)`. That is the only place a routing decision is made.

## Provider-specific rules

These are harness rules, not tab selection:

- **Gemini gets small tasks.** It has the cheapest tokens and a 1M window, but it
  is the weakest web-app agent. Split the work into the smallest prompts that
  still stand alone and keep each one single-purpose; never hand it a multi-file
  refactor in one shot.
- **Kimi may be busy.** A busy Kimi is a retry later, not a failure of the task;
  the tier list already falls through to the next open tab.
- **Claude has a 5-hour window.** Reserve it for `deep`; do not burn it on
  extraction.
- **Every reply is verified.** No web AI can declare success. The harness runs its
  own acceptance checks and retries with feedback (see `docs/harness-loop.md`),
  regardless of which provider produced the text.

## Pinning one provider

A caller that needs a specific site sends `metadata.provider`:

```python
a2a_submit("compare these two drafts", {"provider": "grok", "contextOnly": True})
```

A pin beats `modelTier`, `complexity` and `taskCategory`, has no fallback chain,
and is labelled `pinned` in the routing record. If that provider's tab is not
open, the prompt goes to the active provider tab (never to a different provider
that happens to be open) - a caller that asked for Grok must not silently get
ChatGPT. The live provider test below uses this to reach each site in turn
without opening one tab at a time.

## Cancellation and the tab lock

One prompt at a time per bridge, and one generation at a time per tab. When the
caller's deadline expires the bridge now sends `cancel_prompt`, the background
relays `zs-a2a-abort` to that tab, and the tab stops generating and clears
`A.running`. Before this, a timed-out client left the tab busy forever: every
later prompt failed with "The web AI is already working on another task" until
the page was reloaded by hand. A 15-minute hard cap inside the content script is
the safety net for the case where even the cancel message cannot arrive
(extension reloaded, socket gone).

## Fallbacks

1. No explicit tier, no complexity and no known category -> use the active
   provider tab (original behaviour).
2. Preferred provider tab is not open -> use the next provider in the list.
3. No provider in the list is open -> use the active provider tab and record the
   fallback in the ledger so the client can log it.
4. Provider refuses, is rate-limited or returns an empty reply -> failed attempt
   with a clear message; never silently pick a different model without saying so.

## Non-goals

- Do not auto-switch the model inside a provider's own picker. That is DOM work
  per provider and breaks on every redesign. Prefer opening the right tab.
- Do not hardcode model names in the extension.
- Do not route on prompt text alone. The harness declares the category; guessing
  from words is a fallback, not the contract.

## Testing

- `tests/test_a2a_server.py`: metadata is accepted, unknown category is defaulted,
  and the task echoes the resolved tier.
- `tests/test_bridge.py`: `submit_prompt` carries metadata through unchanged.
- `snapgent-extension/tests/test-a2a.js`: category, tier, complexity downgrade, the
  `realtime` category override and an explicit provider pin each pick the
  expected tab, and a missing preferred tab falls back cleanly.
- `tests/test_bridge.py`: a prompt that times out sends exactly one
  `cancel_prompt` for the prompt it gave up on.

## Reusing an existing session (not built yet)

Today a delegation always starts from an empty chat, and a chat with turns in it
is refused ("Use an empty chat"), so the harness never hijacks a thread a human
is typing in. The natural next step is the opposite: let the extension detect a
conversation it started earlier (its own session key), reattach to it and keep
working there - useful for long tasks, and still perfectly readable and
continuable by a human in that same tab. That needs a per-provider conversation
identity (URL/id + a stored marker) and a rule for when a human has taken over,
so it is deliberately out of scope for this change.

## Live verification (2026-11-14)

Each provider was opened fresh, pinned with `metadata.provider`, and asked a
one-word prompt (`contextOnly`, so no tools were touched). Times are wall clock
from request to reply.

| Provider | Result | Time | Note |
| --- | --- | --- | --- |
| deepseek | ok | 27.8s | clean reply |
| gemini | ok | 19.7s | clean reply |
| glm (chat.z.ai) | ok | 35.1s | clean reply |
| mistral | ok | 34.4s | reply carried the site's "Thought for 1s" reasoning block - extraction needs trimming |
| arena | ok | 32.8s | clean reply |
| chatgpt | ok | 49.3s | deep tier; needs a fresh chat, an old conversation refuses the session |
| claude | ok | 20.2s | clean reply after the message-text fix; the "just now" timestamp and icon glyphs no longer leak into the text |
| qwen | blocked | - | the site restores the previous conversation on load, so the chat is never "empty" |
| rudder | blocked | - | same: last conversation restored |
| grok | blocked | - | cookie/sign-in banner occupies the composer area |
| meta | blocked | - | session bootstrap does not find a ready composer on the fresh page |
| kimi | blocked | - | bootstrap times out; the tab reports no ready composer |

Follow-up round (same day, patient runs of 240 s, after the fresh-chat and
composer fixes):

| Provider | Result | Note |
| --- | --- | --- |
| deepseek | ok | stable across runs |
| gemini | ok | stable across runs |
| qwen | ok | fixed: the harness now opens a new chat itself |
| rudder | ok | fixed: same |
| kimi | ok | fixed: text is `PONG` now (reasoning header stripped), composer is `/chat` |
| meta | ok | fixed: text is typed into the visible Lexical editor; the hidden mirror textarea no longer drives send state |
| grok | flaky | composer selector + 15 s wait added; a run right after a page load can still fail the bootstrap ("mode not ready") before it settles |
| claude | flaky | works on a warm tab; right after a fresh navigate the bootstrap sometimes reports "Could not start a Snapgent session" |
| glm | flaky | ok on a warm tab, fails on a cold one |
| arena | flaky | ok on a warm tab, fails on a cold one |
| chatgpt | ok | pass on a warm tab; a cold navigate can refuse the session |
| mistral | ok (text) | reply still carries its reasoning text; extraction needs trimming |

The remaining failures are all the same shape: a cold page has no composer yet
when the bootstrap runs, or the site restored a thread so the chat is not empty.
None of them is a routing, bridge or cancellation problem, and the harness
reports them as failures instead of timing out silently.

## Live verification (2026-11-15)

`e2e/a2a_matrix_live.py --rounds 2` drives every provider through the real A2A
facade: round 1 COLD (the tab is navigated to a fresh chat, so the extension has
to bootstrap a cold page), round 2 WARM (same tab, session already running), then
both rounds again. Times are wall clock from request to reply.

Second round (same day, after the bar/cold-start work below) — every row is a
COLD run: the tab is navigated to the site root first, then one pinned prompt.

| Provider | Cold | Result |
| --- | --- | --- |
| deepseek | 21.4s | `PONG` |
| gemini | 19.8s | `PONG` |
| meta | 24.1s | `PONG` |
| kimi | 35.4s | `PONG` |
| rudder | 27.2s | `PONG` |
| chatgpt | 40.9s | `PONG` |
| glm | 39.0s | `PONG` (was refused before the 30s composer wait) |
| claude | 20.2s | `PONG` |
| arena | 26.6s | `PONG` (was refused: restored Battle mode, see below) |
| mistral | 25.2s | `PONG` — exactly, no reasoning header |
| qwen | 8.1s | blocked by the account: "You've reached today's Qwen3.8-Max limit" |
| grok | 101.1s | blocked by the account: the site answers "Free tier limit reached", the harness refuses to declare the session started and surfaces that reason instead of a fake reply |

First round, for history:

| Provider | Cold | Warm | Result |
| --- | --- | --- | --- |
| chatgpt | 42-49s | 11-12s | 4/4 pass early in the round; later the site served a voice-first home shell (no reachable composer, banner "ChatGPT mode not ready") |
| claude | 21-24s | 5s | 4/4 pass |
| gemini | 17-21s | 5-6s | 4/4 pass |
| deepseek | 18-22s | 6s | 4/4 pass |
| kimi | 90-95s | 5.6-25s | 4/4 pass (the cold tab takes ~90s to settle its composer) |
| meta | 20s | 4-5s | 4/4 pass |
| rudder | 5.8-8.9s | 7-11s | pass cold+warm; needed the sticky-write fix below |
| mistral | 18-23s | 3.6s | passes until the account hits the site's message limit |
| arena | 25-80s | - | send works, session start is refused on the restored battle page |
| glm | - | - | blocked: "Your daily usage quota for this feature" |
| qwen | - | - | blocked: "You've reached today's Qwen3.8-Max limit" |
| grok | - | - | blocked: "Free tier limit reached" |

What this round fixed and where it is visible in the diagnostics (`#zs-diag-log`):

- **Cold bootstrap** (one place, `runA2APrompt`): wait up to 30 s for the
  provider's composer and poll 10 s for the new-chat control, instead of a
  one-shot check that failed on every cold page. `background.js` also retries a
  swallowed `handleSubmitPrompt` up to three times ("Receiving end does not
  exist" while the worker wakes).
- **Rudder's send control** only mounts once the site's own state holds the text.
  A cold page hydrates over a programmatic write, so the text was gone
  (`send.wrote len 0`) and the button never appeared (~1 cold run in 3). Now the
  write is repeated until the text sticks (`send.rewrote`), which also covers the
  hydration window.
- **Arena** never times out silently any more: when its send button stays
  disabled on a text-only turn the task fails in 20 s with the reason, instead of
  burning the 540 s task budget and then the bridge timeout.
- **Arena's restored Battle mode** used to make Start refuse forever: the tab
  reloads into Battle, `restoreDirectOnce()` loses the race with the dropdown's
  first render (`arena.restore_direct {ok:false}`), and every later start answered
  "Could not start a Snapgent session" in ~2 s. At STARTUP only, `ensureComposerReady`
  now retries the restore and waits up to 4 s for it to land (never mid-conversation,
  so a mode the user picked is still respected).
- **Mistral** strips the site's reasoning disclosure from the reply text
  (`collapsible-trigger`/`collapsible-content` + timestamp footer), so a reply is
  `PONG`, not `Thought for 1s ... PONG`.
- **Grok** cannot host an in-composer bar: the composer is bottom-docked (no
  ancestor padding moves it) and inserting a node into its React parent sent the
  page into a re-render loop (2-25 s stalls, editor unmounted for good). The
  harness therefore uses the float panel, and `textarea` was added last to the
  editor list because the home page composer is a bare textarea. On a CENTERED
  composer (empty landing) the panel now docks BELOW it instead of above: above
  the composer is the site's own headline, which the panel used to cover.
- **scanError** no longer reports "input box not available" while the composer is
  being rebuilt mid-generation (grok, claude, mistral): that surfaced as a false
  `context_limit` and killed the bootstrap.

The quota blocks are the provider refusing the account, not the harness: the
same tabs answer again once the limit resets.

## Live verification (2026-11-15, second run)

Same script, `--rounds 1` (one COLD + one WARM pass per provider) after the
bar-seating fix and the token refactor landed. Providers were run in batches of
four and their tabs closed between batches, to keep a 7.6 GB machine from
swapping; the numbers are still one pinned prompt per provider through the real
A2A facade.

| Provider | Cold | Warm | Result |
| --- | --- | --- | --- |
| claude | 73.9s | 7.2s | `PONG` |
| gemini | 19.2s | 14.4s | `PONG` |
| deepseek | 20.8s | 6.4s | `PONG` |
| chatgpt | 46.8s | 12.8s | `PONG` (first attempt refused: the tab was an old conversation; closed it, then pass) |
| glm | 33.1s | 9.7s | `PONG` |
| kimi | 31.2s | 11.9s | `PONG` |
| mistral | 103.4s | 35.2s | `PONG` |
| meta | 31.1s | 4.8s | `PONG` |
| qwen | 41.4s | 6.8s | `PONG` — the earlier daily-limit block has reset |
| arena | 30.0s | 7.4s | `PONG` (Battle-mode restore fix holds) |
| rudder | 27.3s | 9.2s | `PONG` |
| grok | 10.5s | - | **BLOCKED**: "Free tier limit reached" (was a real FAIL earlier in the day, see below) — re-run once the limit reset, see below |

Grok, in detail. Three separate problems, all found on the live site and all
fixed; the account's own limit is what stops a PASS right now.

1. **Prompt never reached the editor** (the real regression).

   `Grok send button did not become available` on the first pair of rounds, then
   `Could not start a Snapgent session in this chat` on the retry.
   Diagnostics ended at `start.noToolCall {"kind":"empty","textLen":0}`. The
   composer is a `div.tiptap.ProseMirror` **plus** a hidden 0px mirror
   `textarea`, and `querySelectorAll` returns document order (not selector
   order), so the provider picked the mirror and typed the prompt into a ghost.
   `getEditor()` now requires a real box. Writing to the tiptap div verifies
   directly (`execCommand=true`, `<p>PONG</p>`, Send enables).
2. **Cold start sent into a restoring thread.** A cold tab lands on `/c/<id>`
   while the restored turns mount a beat later, so `chatIsEmpty()` was true and
   the opening prompt went into that thread as it re-rendered (`base: 0`, then 4
   restored user turns appeared). `chatIsEmpty()` now treats `/c/<id>` as a chat
   with messages, and the warmup window is 150s (a cold reply measured ~100-120s,
   the old 60s declared it empty ~20s before the text existed).
3. **Its quota banner was invisible to the harness**, which waited out the whole
   window instead of reporting the block. The site's
   `[data-testid="usage-limit-notice"]` is now part of the error scan, and
   startSession's reason is carried into the A2A error, so the matrix reports
   BLOCKED in ~10s with the site's own words.

The write fix was proven by the warm round that ran before the limit hit
(`PASS grok 33.2s`).

Re-run on 2026-11-16, after the account's limit had reset, on a fresh tab
(`--only grok --rounds 1`):

| Provider | Cold | Warm | Result |
| --- | --- | --- | --- |
| grok | 93.4s | 4.4s | `PONG` — first cold PASS; `STABLE` |

Grok's cold row is green. The first attempt that day did not fail on the site:
the tab was still holding a **parked A2A session from an earlier live run**, and
its `#zs-diag-log` showed `park.resumed {"parkedMs":294493}` followed by the old
loop sending its `list_commands` output as the next turn, so the probe was never
sent and the request timed out at the bridge. Closing that tab and opening a
fresh `https://grok.com/` (composer `div.tiptap`, hidden 0px mirror ignored) was
all the cold PASS needed.

Every other provider passes cold and warm, including the two that were blocked
earlier today (qwen, and grok's own quota message). The quota-aware skip did not
fire this time because no site answered with a limit message.

## In-page bar placement (2026-11-15)

Measured live on each site with the bar's own geometry (`#zs-bar` rect against the
composer's), not by eye alone:

- **Claude, Gemini** mount the bar above the composer card. It used to be drawn as
  a translucent card with its own radius and an 8 px gap, so it read as a second
  widget stacked on the input (and on Gemini the `⚠ unstable` pill floated in
  empty space on the left). The bar is now flat and flush — no surface, no radius,
  no gap — so it reads as the composer's own top row.
- **GLM, Kimi, Meta** hug the composer card's top edge (anchored mode).
- **Grok** floats (see above) and now flips below a centered composer.
- The `⚠ unstable` pill is right-aligned: left-aligned it covered GLM's own
  "Choose project" chip, which sits above the composer's left corner.
