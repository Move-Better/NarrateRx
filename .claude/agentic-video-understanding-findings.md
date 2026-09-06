# Agentic video understanding — findings + plan

Research only. No code changed. Sources are Google's own current docs (fetched raw,
grepped by hand, not trusted from the WebFetch summarizer alone — see method note at
bottom) plus a live grep of this repo.

## 1. Which models actually support it, right now

**The docs are ambiguous, and I can name exactly where.**

- The **Sept 1, 2026 changelog entry** (dated, point-in-time) says:
  > "Released agentic video understanding for Gemini 3.7 Flash, 3.6 Flash, and 3.5 Flash-Lite across the Interactions and GenerateContent APIs."
  — **3 models**, no 3.8 Flash.

- The **current `/gemini-api/docs/video-understanding` reference page** (live, presumably
  kept up to date) says, in three separate places including a table:
  > "Gemini 3.8 Flash, 3.7 Flash, and 3.5 Flash Lite models also support agentic video
  > understanding" / table row: "Agentic ... Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.5
  > Flash Lite"
  — **4 models**, 3.8 Flash included.

I verified both by curling the raw HTML myself and grepping it directly (not trusting
the WebFetch tool's own summarization model, which is a small model prone to inventing
specifics — I don't take its word for a version number without an independent raw-text
check). Both quotes above are confirmed present in the live HTML, not fabricated by the
fetch tool.

**My read:** the changelog is a frozen announcement from the day of the initial rollout;
the reference page is the current, larger set (3.8 Flash likely gained support after
launch, or the changelog undersold it, e.g. it came out day the same day as separate
3.8 GA news and the writer didn't cross-link). **Trust the reference page for "right
now": Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.5 Flash-Lite.**

**Critical fact for us: none of these are Gemini 2.5.** Bernard's current video call
sites use `google/gemini-2.5-pro` and `google/gemini-3.8-flash` (recently bumped from
3.6, see below) and `google/gemini-2.5-flash` is referenced in a rate card. Agentic mode
is Flash-only and 3.x-only — there is **no Gemini 2.5 Pro agentic path**, and the one
call site already on `gemini-3.8-flash` (`tagAsset.js`) is the only one sitting on a
model that's actually eligible today.

## 2. Can we use it through the Vercel AI SDK / AI Gateway (`ai@^7.0.92`)?

**No — not today, and this changes the whole approach.**

The mechanism Google ships for agentic mode is a **new, separate API**: the
"Interactions API" (`client.interactions.create(...)`), not the classic
`generateContent`. Every code example on Google's own video-understanding page — Python,
JS, curl — uses `interactions.create`. I found **zero** examples of `generateContent`
syntax for agentic mode anywhere on that page, despite the changelog's prose claiming
"across the Interactions and GenerateContent APIs." Secondary sources (not Google's own
docs) claim a `media_processing: "AGENTIC"` field exists for `generateContent`, but I
could not find that documented anywhere on `ai.google.dev` — treat it as **unconfirmed**.

For the Interactions API specifically:
- **AI SDK core** (the `ai` package) landed some support in ~May 2026, per a Vercel
  community forum report — a maintainer response (Dec 2025) had called it premature
  "since it's very new and still in public beta."
- **The AI Gateway does not proxy the Interactions API.** Same community thread, same
  reporter, same month: "it seems it's currently impossible to use with the Vercel AI
  gateway," with no maintainer timeline given. Vercel's own `/docs/ai-gateway` page lists
  what it does support (AI SDK, OpenAI Chat Completions, OpenAI Responses, Anthropic
  Messages) and the Interactions API is not among them.
- We are on `ai@^7.0.92` per `package.json:58`, and we call everything through the
  Gateway with plain `provider/model` strings (`AI_GATEWAY_API_KEY`) — exactly the setup
  the Gateway currently can't carry the Interactions API through.

**Caveat on my confidence here:** the community-forum evidence is secondary, not
Google/Vercel's own reference docs, and it's from May 2026 — four months stale relative
to today. Vercel ships fast; this could have changed. Before committing to a plan, the
one-command check is cheap and decisive: point `ai@latest`'s `google` gateway provider
at `client.interactions.create`-equivalent syntax against `ai-gateway.vercel.sh` and see
if it 404s/400s or works. I have not done this because it would be exploratory code, and
the task asked for no code changes yet — flagging it as the first real "prove it or kill
it" step of the plan below.

**If the Gateway genuinely can't carry it:** our only paths are (a) wait, (b) call
Google's API directly with a second SDK/key bypassing the Gateway (loses Gateway
observability, fallback, unified billing — real cost), or (c) don't pursue it yet. That
is a scope-changing decision, not an implementation detail, which is why it's called out
here rather than buried in the plan.

## 3. Current video code — every call site, what we send, rough token cost

Grepped `api/_lib` and `api/_routes` directly. There are exactly **4** places Bernard
sends video content to Gemini. All 4 use AI SDK's `generateObject`/`generateText` with a
zod schema — none use the raw Google SDK or the Interactions API.

| Call site | Model (current) | What's actually sent | Est. tokens/job |
|---|---|---|---|
| `api/_lib/tagAsset.js` (`callModel`) | `google/gemini-3.8-flash` (bumped from 3.6, 2026-09-03) | **Real video bytes** — the asset's `blob_url` directly for videos <15MB, or an ffmpeg-transcoded 720p/CRF30 proxy (capped ~18MB) for larger ones — as `{type:'file', mediaType:'video/mp4'}`. One call per uploaded/re-tagged asset. | Static-mode video tokenizes at **263 tokens/sec** (Google's own number). A typical 30–120s interview/broll clip → **~8,000–32,000 input tokens** per call, plus the text instructions (~300–500 tokens) and a small JSON schema output. |
| `api/_lib/analyzeVideoWindow.js` (shared primitive) | default `google/gemini-2.5-pro` | **No video sent at all** — ffmpeg fast-seeks 6 JPEG stills (512px long edge) from a time window via HTTP range reads, sends them as `{type:'file', mediaType:'image/jpeg'}` array. | 6 frames × ~258 tokens (Google's flat per-image rate for small/near-tile-boundary images) ≈ **~1,550 tokens** input per call, plus prompt text. |
| `api/_lib/scoreMomentsVisual.js` (`visualScoreSegments`) | inherits `DEFAULT_VIDEO_MODEL` = `gemini-2.5-pro` | Calls `analyzeVideoWindow` **once per proposed transcript-detected moment window**, concurrency-bounded (3 at a time), within a shared 300s detection budget. A typical interview yields somewhere around 5–15 candidate windows. | ~1,550 tokens × N windows → **~8,000–23,000 tokens** per interview processed, spread across N separate model calls (not one big call). |
| `api/_lib/visualNominate.js` (`nominateVisualWindows`) | `DEFAULT_VIDEO_MODEL` for the scan, separately `anthropic/claude-sonnet-4-6` (`HOOK_MODEL`) for hook-writing on the winners | Samples up to `MAX_SCAN_FRAMES = 24` JPEG stills across the **whole source duration** (`min(24, max(6, duration/8))`), one `generateObject` call with all frames in one message. | 24 frames × ~258 tokens ≈ **~6,200 tokens** input for the nominate call, once per source video, regardless of length. (The hook-writing follow-up call is Claude, text-only, not part of this comparison.) |

**What this means for the "prove it saved money" ask:** three of the four call sites
(`analyzeVideoWindow`, `scoreMomentsVisual`, `visualNominate`) **never send Gemini a
video at all** — they hand-roll frame sampling specifically because a prior attempt at
transcoding a real video proxy was too slow (`analyzeVideoWindow.js`'s own comment: "4K
to encode even a 20s 720p proxy runs ~8x SLOWER than realtime on CPU"). Agentic video
understanding is a feature of Gemini's own *video ingestion* — it has nothing to do with
a call that only ever sends discrete JPEGs. **Comparing "88% fewer tokens" against these
three call sites isn't meaningful; there's no video-token baseline to reduce.** The one
call site that *does* send real video — `tagAsset.js` — is the only legitimate
apples-to-apples comparison, and it's also the only one already on an agentic-eligible
model family (Flash; `gemini-2.5-pro` used elsewhere is not eligible at all).

## 4. Smallest change that gets a measurable comparison

Assuming the Gateway question in §2 resolves favorably (or we accept calling Google
directly for the experiment only):

1. **Pick one representative video already in `media_assets`** — an interview clip in
   the 3–8 minute range (long enough that agentic's claimed advantage should show; short
   clips are explicitly called out by Google as not benefiting and even risking higher
   time-to-first-token).
2. **Run it through the existing `tagAsset.js` prompt/schema twice**, in an isolated
   throwaway node harness (no DB writes, no prod call) — once exactly as today
   (`google/gemini-3.8-flash`, static default), once with agentic mode requested on the
   same model, same schema, same prompt.
3. **Capture from each run:** `usage.inputTokens`/`usage.outputTokens` (already exposed
   by the AI SDK — `analyzeVideoWindow.js` already reads this shape), wall-clock latency,
   and the actual structured output (tags, transcription, visual_narrative, display_title).
4. **Compare token counts and cost directly** — this is the number Google's 88% claim is
   about, and it's the cheapest, most direct proof or disproof available. No new
   infrastructure, no schema changes, reuses the exact prompt already in prod.
5. Do **not** attempt this on `analyzeVideoWindow`/`scoreMomentsVisual`/`visualNominate`
   first — per §3, they'd need an architecture change (send the model a video instead of
   frames) before agentic mode is even applicable, which is a much bigger and riskier
   change than swapping a processing flag on an already-video-eating call site.

This is a one-file, no-prod-impact experiment. The real gating question is still §2 —
whether the harness can even reach agentic mode through our existing Gateway plumbing
without a second SDK/key.

## 5. What could regress — and what won't show up in token counts

Token savings are the easy, measurable half. The risk is entirely on **observation
completeness and reliability of structured output**, which a token count says nothing
about:

- **Agentic mode is model-driven exploration, not our deterministic frame grid.** Today
  `tagAsset.js` guarantees the model sees the *whole* video (either directly or via a
  full-source proxy). Agentic mode explicitly "loads only the content it needs based on
  the prompt" — for a schema that always asks for tags + transcription + visual_narrative
  regardless of what's "needed," the model may decide less of the video is relevant than
  we actually want captured. **Eyeball:** run the same 5–10 real clips both ways and diff
  the `transcription` and `visual_narrative` fields line-by-line, not just token counts —
  look specifically for the agentic run dropping a whole scene/topic segment that the
  static run captured, especially in clips with more than one distinct topic or setup.
- **Structured output contract is unproven on this path.** Every one of our 4 call sites
  depends on `generateObject`'s schema-enforced JSON. Google's own agentic-mode docs
  describe output arriving as a `steps` array with `model_output` — I found no
  confirmation that the Interactions API supports the same zod-schema-constrained JSON
  guarantee AI SDK's `generateObject` gives us today. **Eyeball:** does the response
  still validate against `videoSchema`/`photoSchema` cleanly, or does it need a
  translation layer, and does *that* introduce a new failure mode (malformed JSON,
  missing fields) independent of video understanding quality?
- **Higher TTFT on short clips is explicitly documented by Google**, and a meaningful
  share of Bernard's media is B-roll and short interview cuts under 5 minutes. If we
  ever extend this beyond `tagAsset.js`, blanket-switching everything to agentic could
  make short-clip tagging *slower*, not just differently-tokenized — worth timing, not
  just costing.
- **The `processing_call`/`processing_result` steps are new response shape** — if
  anything downstream ever parses raw model output instead of the validated schema
  object (it doesn't today, as far as this grep found, but check before wiring), those
  steps would need explicit handling or would silently be ignored/dropped.
- **Provider surface risk if we bypass the Gateway.** If §2's Gateway gap doesn't close
  in time and we call Google directly for this one path, we lose the Gateway's fallback,
  observability, and billing rollup for exactly the call site that's currently the
  cleanest one to compare. That's an operational regression independent of anything
  agentic mode itself does.

## Method note (why this doc trusts raw HTML over tool summaries)

Both the initial `WebFetch` calls returned model lists that *disagreed with each other*
across two calls to the same page in the same minute (one included 3.8 Flash, the other
didn't). Rather than pick one, I `curl`'d both pages myself and grepped the raw HTML by
hand for every literal mention of a version number or field name. Every quote in this
doc is verifiable that way; anything I couldn't confirm in raw docs (the
`media_processing`/`AGENTIC` GenerateContent field, the current Gateway/Interactions
status) is explicitly labeled unconfirmed/secondary above rather than stated as fact.
