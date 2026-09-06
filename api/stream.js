import { withSentry } from './_lib/sentry.js'
import { streamText } from 'ai'
import { enforceLimit } from './_lib/ratelimit.js'
import { requireRole } from './_lib/auth.js'
import { workspaceContext } from './_lib/workspaceContext.js'

// Pinned to Node runtime (was Edge) so the Edge whole-graph bundler doesn't
// follow the ratelimit.js → @clerk/backend → node:crypto chain into middleware.
// Web-style (Request → Response) handlers silently hang on Vercel's Node
// runtime — Vercel ignores the returned Response and the function times out at
// maxDuration. Stream via res.write() instead. (Caused the prod 504s after
// the runtime flip in #293.)
// 300s (Vercel Node max) — blog-post generation with Opus at 4096 tokens
// routinely exceeds the old 60s cap, producing truncated or empty output.
export const config = { runtime: 'nodejs', maxDuration: 300 }

// Streams a Claude completion via the Vercel AI Gateway.
//
// Wire format is intentionally kept Anthropic-shaped SSE so the existing
// client parser in src/lib/claude.js#streamMessage keeps working without
// changes. We emit one `data: { type: 'content_block_delta', delta: { text } }`
// event per text chunk and finish with `data: [DONE]`.
async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const ws = await workspaceContext(req)
  if (!ws) return res.status(400).json({ error: 'No workspace resolved for this request' })
  const auth = await requireRole(req, null, { orgId: ws.clerk_org_id })
  if (!auth.ok) return res.status(auth.reason === 'forbidden' ? 403 : 401).json({ error: auth.reason })

  if (!(await enforceLimit(req, res, 'ai', ws.id))) return

  const { messages, systemPrompt, model, maxOutputTokens } = req.body || {}

  if (!messages || !systemPrompt) {
    res.status(400).json({ error: 'Missing messages or systemPrompt' })
    return
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    res.status(500).json({ error: 'AI_GATEWAY_API_KEY is not set on this deployment' })
    return
  }

  // Allowlisted models only — prevents a workspace member from invoking a
  // more expensive tier (e.g. Opus) at the billing account's cost.
  const ALLOWED_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-5'])
  const requested = model || 'claude-sonnet-4-6'
  if (requested.includes('/') && !requested.startsWith('anthropic/')) {
    return res.status(400).json({ error: 'model_not_allowed' })
  }
  // Strip provider prefix before checking allowlist.
  const bareModel = requested.includes('/') ? requested.split('/').pop() : requested
  if (!ALLOWED_MODELS.has(bareModel)) {
    return res.status(400).json({ error: 'model_not_allowed' })
  }
  const gatewayModel = requested.includes('/') ? requested : `anthropic/${requested}`

  // Default keeps short interview turns cheap; blog/long-form callers pass
  // a higher cap. Clamp to 16000 so a malicious caller can't burn the
  // budget — bumped from 8192 (2026-09-06) because Opus 5 uses ~1.7-2x the
  // output tokens per character that Opus 4.7 did for the same blog-length
  // content, so a full post now needs more headroom to finish with
  // finishReason 'stop' instead of silently truncating at 'length'. Matches
  // the ceiling bookSynthesis.js already uses for its own long-form calls.
  const cap = Number.isFinite(maxOutputTokens)
    ? Math.min(Math.max(parseInt(maxOutputTokens, 10) || 1024, 256), 16_000)
    : 1024

  let result
  try {
    result = streamText({
      model: gatewayModel,
      instructions: systemPrompt,
      messages,
      maxOutputTokens: cap,
    })
  } catch (_e) {
    res.status(500).json({ error: 'stream_init_failed' })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'private, no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Tell upstream proxies (Vercel edge / nginx-style) not to buffer the stream.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  // Iterate stream rather than textStream so we can see error parts.
  // textStream silently filters them out, which meant an upstream auth /
  // model failure surfaced to the client as an empty assistant turn — see
  // PR #249.
  let errored = false
  const sendError = (message) => {
    errored = true
    // Log server-side so mid-stream failures are visible in Vercel logs.
    // Without this, the request logs as a clean 200 (headers/status were
    // already flushed before streaming began) and the failure is invisible —
    // we were blind to how often the gateway→Anthropic upstream blips mid-turn.
    // Tagged [stream] so it can be grep'd / filtered to error level.
    console.error('[stream] mid-stream error', {
      model: gatewayModel,
      message: message || 'Stream error',
    })
    const payload = JSON.stringify({
      type: 'error',
      error: { message: 'stream_error' },
    })
    res.write(`data: ${payload}\n\n`)
  }

  try {
    for await (const part of result.stream) {
      if (part?.type === 'text-delta') {
        const text = part.text ?? part.delta
        if (!text) continue
        const payload = JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        })
        res.write(`data: ${payload}\n\n`)
      } else if (part?.type === 'error') {
        console.error('[stream] gateway error part', { error: part.error?.message || part.errorText || String(part.error) })
        sendError('stream_error')
        break
      }
    }
    if (!errored) res.write('data: [DONE]\n\n')
  } catch (_e) {
    sendError('stream_error')
  } finally {
    res.end()
  }
}

export default withSentry(handler)
