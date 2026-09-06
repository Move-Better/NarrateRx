// POST /api/content-items/blog-regen-prepare  { id, length_preset?, generation_style? }
//
// Phase 1 of the streamed blog-regen flow. Loads everything the blog prompt
// needs (workspace, interview, clinician, voice phrases, own-history block,
// location overlay), builds the system prompt + messages, and returns them to
// the client. The client then streams the actual generation through
// /api/stream (no 300s function cap on the regenerate handler) and finalizes
// via /api/content-items/blog-regen-finalize.
//
// Atom regeneration still uses /api/content-items/regenerate — atoms run on
// Sonnet 4.6 at 1500 tokens and finish well under 60s.

export const config = { runtime: 'nodejs', maxDuration: 60 }

import { workspaceContext } from '../../_lib/workspaceContext.js'
import { requireRole } from '../../_lib/auth.js'
import { enforceLimit } from '../../_lib/ratelimit.js'
import { resolveOwnHistoryBlock, buildRagQuery } from '../../_lib/practiceMemory.js'
import {
  getBlogPostSystemPrompt,
  getMinimalEditSystemPrompt,
  buildVerbatimBlock,
} from '../../../src/lib/prompts.js'
import { applyLocationOverlay } from '../../../src/lib/locationOverlay.js'
import { resolveLengthPreset, LENGTH_PRESETS } from '../../../src/lib/lengthPresets.js'

const VALID_LENGTH_PRESETS = new Set(LENGTH_PRESETS.map((p) => p.id))
const VALID_GENERATION_STYLES = new Set(['blog_post', 'minimal_edits'])

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

function sb(path, init = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:        'return=representation',
      ...init.headers,
    },
  })
}

const err = (res, msg, status = 400) => res.status(status).json({ error: msg })

async function dbErr(res, r, msg = 'Database error', status = 500) {
  const body = await r.text().catch(() => '')
  console.error(`[content-items/blog-regen-prepare] ${msg} — supabase ${r.status}: ${body.slice(0, 500)}`)
  return res.status(status).json({ error: msg })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return err(res, 'Method not allowed', 405)

  const ws = await workspaceContext(req)
  if (!ws) return err(res, 'Workspace not resolved', 400)
  const auth = await requireRole(req, null, { orgId: ws.clerk_org_id })
  if (!auth.ok) return res.status(auth.reason === 'forbidden' ? 403 : 401).json({ error: auth.reason })
  if (!(await enforceLimit(req, res, 'ai', ws.id))) return
  const wsFilter = `workspace_id=eq.${ws.id}`

  const {
    id,
    length_preset: bodyLengthPreset,
    generation_style: bodyGenerationStyle,
  } = req.body || {}
  if (!id) return err(res, 'Missing id')
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(id)) return err(res, 'Invalid id', 400)
  if (bodyLengthPreset != null && !VALID_LENGTH_PRESETS.has(bodyLengthPreset)) {
    return err(res, 'invalid_length_preset')
  }
  if (bodyGenerationStyle != null && !VALID_GENERATION_STYLES.has(bodyGenerationStyle)) {
    return err(res, 'invalid_generation_style')
  }

  const itemRes = await sb(`content_items?id=eq.${id}&${wsFilter}&select=*`)
  if (!itemRes.ok) return dbErr(res, itemRes)
  const itemRows = await itemRes.json()
  if (!itemRows.length) return err(res, 'Content item not found', 404)
  const item = itemRows[0]

  if (item.platform !== 'blog') {
    return err(res, 'platform_not_supported', 422)
  }
  if (!item.interview_id) {
    return err(res, 'Content item has no source interview', 422)
  }

  const ivRes = await sb(
    `interviews?id=eq.${item.interview_id}&${wsFilter}` +
    `&select=id,staff_id,topic,kind,tone,voice_mode,prototype_id,verbatim_flags,location_id,messages,outputs,audience,story_type,generation_style`,
  )
  if (!ivRes.ok) return dbErr(res, ivRes)
  const ivRows = await ivRes.json()
  if (!ivRows.length) return err(res, 'Interview not found', 404)
  const interview = ivRows[0]

  const turns = Array.isArray(interview.messages) ? interview.messages : []
  if (!turns.length) return err(res, 'Interview transcript missing — cannot regenerate', 422)

  let staffName = ''
  let voiceNotes = ''
  let voicePhrases = []
  let staffPreferredLength = null
  if (interview.staff_id) {
    const [clinRes, phrasesRes] = await Promise.all([
      sb(`staff?id=eq.${interview.staff_id}&${wsFilter}&select=name,voice_notes,preferred_length`),
      sb(
        `staff_voice_phrases?staff_id=eq.${interview.staff_id}&${wsFilter}` +
        `&select=phrase&order=weight.desc,last_seen_at.desc&limit=8`
      ),
    ])
    if (clinRes.ok) {
      const rows = await clinRes.json()
      staffName            = rows[0]?.name ?? ''
      voiceNotes               = rows[0]?.voice_notes ?? ''
      staffPreferredLength = rows[0]?.preferred_length ?? null
    }
    if (phrasesRes.ok) voicePhrases = await phrasesRes.json()
  }

  const ownHistoryBlock = interview.staff_id
    ? await resolveOwnHistoryBlock({
        workspaceId:        ws.id,
        staffId:        interview.staff_id,
        excludeInterviewId: interview.id,
        query:              buildRagQuery(interview),
      })
    : ''

  const effectiveLengthPreset = resolveLengthPreset(
    bodyLengthPreset ?? item.length_preset,
    staffPreferredLength,
  )

  let interviewLocation = null
  if (interview.location_id) {
    const locRes = await sb(
      `workspace_locations?id=eq.${interview.location_id}&${wsFilter}&select=*&limit=1`,
    )
    if (locRes.ok) {
      const rows = await locRes.json()
      interviewLocation = rows[0] ?? null
    }
  }
  const overlaidWorkspace = applyLocationOverlay(ws, interviewLocation)

  const effectiveStyle = bodyGenerationStyle || interview.generation_style || 'blog_post'
  const isMinimal = effectiveStyle === 'minimal_edits'

  const systemPrompt = isMinimal
    ? getMinimalEditSystemPrompt(
        staffName,
        interview.voice_mode || 'practice',
        voiceNotes,
        voicePhrases,
      )
    : getBlogPostSystemPrompt(
        overlaidWorkspace,
        staffName,
        interview.topic,
        interview.tone || 'smart',
        interview.voice_mode || 'practice',
        interview.prototype_id,
        voiceNotes,
        voicePhrases,
        null,
        null,
        effectiveLengthPreset,
        ownHistoryBlock,
        interview.kind === 'point',
      ) + buildVerbatimBlock(interview.verbatim_flags)

  const messages = [
    ...turns.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: isMinimal
        ? 'Please clean up the transcript now using minimal edits only.'
        : 'Please write the blog post now based on our interview.',
    },
  ]

  return res.status(200).json({
    systemPrompt,
    messages,
    model: 'claude-opus-5',
    maxOutputTokens: 12_000,
    effectiveLengthPreset,
    effectiveStyle,
  })
}
