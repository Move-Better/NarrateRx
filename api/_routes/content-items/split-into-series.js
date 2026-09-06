// POST /api/content-items/split-into-series  { id, parts, length_preset? }
//
// Splits a single blog content_item into a multi-part series (parts = 2|3|4).
// Two-pass generation:
//   1. CLUSTER PASS — getSeriesClusterSystemPrompt() reads the full transcript
//      and returns a JSON plan: N coherent threads with titles, briefs, anchor
//      moments, and key quotes.
//   2. WRITE PASS — getSeriesPartSystemPrompt() called N times, once per
//      cluster, to produce each part as a full blog post. The full transcript
//      is in context for every write call so the model can pull supporting
//      quotes from anywhere; the cluster brief tells it which thread to follow.
//
// Result:
//   • Original blog content_item is archived (status='archived', kept for
//     rollback / audit; NOT deleted).
//   • N new content_items inserted (platform='blog', series_id=<uuid>,
//     series_part=1..N, series_total=N). Status='draft' — each needs review.
//   • interview.outputs.blogPost is updated to Part 1's content so downstream
//     atom regeneration uses the strongest standalone post as the editorial
//     summary (see "Atoms" follow-up in CLAUDE.md punchlist).
//
// Honors the product principle: "the app manages what the interview creates,
// not the interview itself." Long interviews stop forcing the writer to drop
// good material under the single-post template constraint.

export const config = { runtime: 'nodejs', maxDuration: 300 }

import { randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { waitUntil } from '@vercel/functions'
import { workspaceContext } from '../../_lib/workspaceContext.js'
import { requireRole } from '../../_lib/auth.js'
import { enforceLimit } from '../../_lib/ratelimit.js'
import { runCitationEnrichmentForContentItem } from '../../_lib/citations/runForContentItem.js'
import {
  getSeriesClusterSystemPrompt,
  getSeriesPartSystemPrompt,
  buildVerbatimBlock,
} from '../../../src/lib/prompts.js'
import { resolveOwnHistoryBlock, buildRagQuery } from '../../_lib/practiceMemory.js'
import { applyLocationOverlay } from '../../../src/lib/locationOverlay.js'
import { extractProvenanceBlock } from '../../../src/lib/provenance.js'
import { resolveLengthPreset, LENGTH_PRESETS } from '../../../src/lib/lengthPresets.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

const VALID_PART_COUNTS = new Set([2, 3, 4])
const VALID_LENGTH_PRESETS = new Set(LENGTH_PRESETS.map((p) => p.id))

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

const ok  = (res, data, status = 200) => res.status(status).json(data)
const err = (res, msg, status = 400)  => res.status(status).json({ error: msg })

async function dbErr(res, r, msg = 'Database error', status = 500) {
  const body = await r.text().catch(() => '')
  console.error(`[content-items/split-into-series] ${msg} — supabase ${r.status}: ${body.slice(0, 500)}`)
  return res.status(status).json({ error: msg })
}

// The cluster pass is asked to return ONLY JSON. Some models still wrap it in
// a code fence or add a "Here's the plan:" preamble, and trailing commas slip
// through under the "return only JSON" instruction. Tolerate all three.
function extractJsonPlan(raw) {
  if (!raw) return null
  let text = raw.trim()
  // Strip ```json ... ``` or ``` ... ``` code fences
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/m)
  if (fenceMatch) text = fenceMatch[1].trim()
  // If there's a preamble, find the first '{' and last '}'
  const first = text.indexOf('{')
  const last  = text.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) return null
  // Strip trailing commas before object/array close — the most common model
  // output mistake under "return only JSON" instructions.
  const slice = text.slice(first, last + 1).replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(slice)
  } catch (e) {
    console.error('[content-items/split-into-series] JSON parse failed:', e?.message, '— raw head:', text.slice(0, 200))
    return null
  }
}

// Statuses a blog must be in to be eligible for split. Published / archived /
// scheduled pieces are NOT splittable — splitting a published piece would
// archive the live record and create unpublished drafts; splitting a scheduled
// piece would orphan an in-flight Buffer job.
const SPLITTABLE_STATUSES = new Set(['draft', 'in_review', 'approved'])

export default async function handler(req, res) {
  if (req.method !== 'POST') return err(res, 'Method not allowed', 405)
  const ws = await workspaceContext(req)
  if (!ws) return err(res, 'Workspace not resolved', 400)
  const auth = await requireRole(req, null, { orgId: ws.clerk_org_id })
  if (!auth.ok) return res.status(auth.reason === 'forbidden' ? 403 : 401).json({ error: auth.reason })
  if (!(await enforceLimit(req, res, 'ai', ws.id))) return
  const wsFilter = `workspace_id=eq.${ws.id}`

  const { id, parts, length_preset: bodyLengthPreset } = req.body || {}
  if (!id) return err(res, 'Missing id')
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(id)) return err(res, 'Invalid id')
  const partCount = Number(parts)
  if (!VALID_PART_COUNTS.has(partCount)) {
    return err(res, 'parts must be 2, 3, or 4')
  }
  if (bodyLengthPreset != null && !VALID_LENGTH_PRESETS.has(bodyLengthPreset)) {
    return err(res, 'invalid_length_preset')
  }

  // Load the source content_item (must be a blog) under workspace scope.
  const itemRes = await sb(`content_items?id=eq.${id}&${wsFilter}&select=*`)
  if (!itemRes.ok) return dbErr(res, itemRes)
  const itemRows = await itemRes.json()
  if (!itemRows.length) return err(res, 'Content item not found', 404)
  const item = itemRows[0]
  if (item.platform !== 'blog') {
    return err(res, 'Split is only supported for blog pieces', 422)
  }
  if (item.series_id) {
    return err(res, 'This piece is already part of a series', 409)
  }
  if (!item.interview_id) {
    return err(res, 'Content item has no source interview — split not supported', 422)
  }
  if (!SPLITTABLE_STATUSES.has(item.status)) {
    return err(
      res,
      `Cannot split a piece in '${item.status}' state — unapprove or unschedule it first`,
      409,
    )
  }

  // ── Atomic claim ──────────────────────────────────────────────────────
  // PostgREST PATCH with extra WHERE clauses on the URL acts as a conditional
  // update — the update only applies to rows still in a splittable status.
  // Concurrent splits race here; only one PATCH returns a row, the other gets
  // zero rows back and bails with 409. This is the application-layer guard;
  // the unique partial index on (interview_id, series_part) in migration 056
  // is the DB-level backstop if both somehow get past this.
  const splittableFilter = Array.from(SPLITTABLE_STATUSES).map((s) => `"${s}"`).join(',')
  const claimRes = await sb(
    `content_items?id=eq.${id}&${wsFilter}&status=in.(${splittableFilter})&series_id=is.null`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status:       'archived',
        archived_at:  new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      }),
    },
  )
  if (!claimRes.ok) return dbErr(res, claimRes, 'Claim failed')
  const claimRows = await claimRes.json()
  if (!claimRows.length) {
    return err(res, 'This piece is no longer eligible to split (another request may already be running)', 409)
  }

  // Load the source interview.
  const ivRes = await sb(
    `interviews?id=eq.${item.interview_id}&${wsFilter}` +
    `&select=id,staff_id,topic,kind,tone,voice_mode,prototype_id,verbatim_flags,location_id,messages,outputs,audience,story_type`,
  )
  if (!ivRes.ok) {
    await unclaimSource('interview-fetch-failed')
    return dbErr(res, ivRes)
  }
  const ivRows = await ivRes.json()
  if (!ivRows.length) {
    await unclaimSource('interview-not-found')
    return err(res, 'Interview not found', 404)
  }
  const interview = ivRows[0]

  const turns = Array.isArray(interview.messages) ? interview.messages : []
  if (turns.length < 2) {
    await unclaimSource('transcript-too-short')
    return err(res, 'Interview transcript too short to split into a series', 422)
  }

  // Clinician name + voice context (mirrors regenerate.js).
  let staffName = ''
  let voiceNotes = ''
  let voicePhrases = []
  let staffPreferredLength = null
  if (interview.staff_id) {
    const [clinRes, phrasesRes] = await Promise.all([
      sb(`staff?id=eq.${interview.staff_id}&${wsFilter}&select=name,voice_notes,preferred_length`),
      sb(
        `staff_voice_phrases?staff_id=eq.${interview.staff_id}&${wsFilter}` +
        `&select=phrase&order=weight.desc,last_seen_at.desc&limit=8`,
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

  // Apply per-post location overlay so workspace.location resolves correctly.
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

  const effectiveLengthPreset = resolveLengthPreset(
    bodyLengthPreset ?? item.length_preset,
    staffPreferredLength,
  )

  // Phase 5 Feature 2 — clinician's prior thinking, fetched once and reused
  // across every series-part call below.
  const ownHistoryBlock = interview.staff_id
    ? await resolveOwnHistoryBlock({
        workspaceId:        ws.id,
        staffId:        interview.staff_id,
        excludeInterviewId: interview.id,
        query:              buildRagQuery(interview),
      })
    : ''

  // Best-effort rollback of the atomic claim. Used when the AI pass or the
  // bulk insert fails after we've already marked the source row archived.
  // Without this, a generation failure leaves the user's original draft
  // stuck archived with no series to show for it.
  async function unclaimSource(reason) {
    try {
      const r = await sb(`content_items?id=eq.${id}&${wsFilter}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status:      item.status,
          archived_at: item.archived_at ?? null,
          updated_at:  new Date().toISOString(),
        }),
        headers: { Prefer: 'return=minimal' },
      })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        console.error(`[content-items/split-into-series] unclaim failed after ${reason}: ${r.status} ${body.slice(0, 300)}`)
      }
    } catch (e) {
      console.error(`[content-items/split-into-series] unclaim threw after ${reason}: ${e?.message}`)
    }
  }

  try {
    // ── PASS 1: cluster the transcript into N threads ─────────────────────
    const clusterSystem = getSeriesClusterSystemPrompt(
      overlaidWorkspace,
      staffName,
      interview.topic,
      partCount,
      interview.voice_mode || 'practice',
    )
    const transcriptMessages = turns.map((m) => ({ role: m.role, content: m.content }))
    const { text: clusterRaw } = await generateText({
      model: 'anthropic/claude-opus-5',
      instructions: clusterSystem,
      messages: [
        ...transcriptMessages,
        { role: 'user', content: `Please return the ${partCount}-part series plan as JSON now.` },
      ],
      // Bumped from 2000 (2026-09-06): Opus 5 uses more output tokens per
      // character than Opus 4.7 for the same plan and was hitting
      // finishReason 'length' at 2000 (a real 3-part plan needed ~2564
      // tokens to finish with 'stop') — silently truncated JSON that then
      // fails to parse. 6000 leaves headroom for the max 4-part case.
      maxOutputTokens: 6000,
    })
    const plan = extractJsonPlan(clusterRaw)
    if (!plan || !Array.isArray(plan.parts) || plan.parts.length === 0) {
      console.error('[content-items/split-into-series] cluster pass returned unusable plan:', clusterRaw?.slice(0, 500))
      await unclaimSource('cluster-plan-unusable')
      return err(res, 'Series planning failed — model did not return a usable plan. Try again.', 502)
    }

    // Trust the model if it returned fewer parts than requested (the cluster
    // prompt explicitly permits that). Cap at the requested count, re-index
    // sequentially, and validate each part has a non-empty title — without
    // titles the sibling-summary block in the write pass degenerates to
    // "Part 2" / "Part 3" which gives the writer no thematic guardrail.
    const planParts = plan.parts.slice(0, partCount).map((p, idx) => ({
      ...p,
      part:  idx + 1,
      title: (typeof p?.title === 'string' && p.title.trim()) ? p.title.trim() : `Part ${idx + 1}`,
    }))
    if (planParts.some((p) => p.title === `Part ${p.part}`)) {
      console.warn('[content-items/split-into-series] cluster pass missed at least one part title — sibling context will be weaker. Plan:', JSON.stringify(planParts.map((p) => ({ part: p.part, title: p.title }))))
    }
    const actualPartCount = planParts.length
    const seriesTitle = typeof plan.series_title === 'string' ? plan.series_title : ''

    // ── PASS 2: write each part ───────────────────────────────────────────
    // Run sequentially rather than in parallel — each part's generation is
    // ~30s per part with Opus, and parallel calls would risk hitting per-workspace
    // AI rate limits and inflate worst-case memory. Total runtime budget is
    // bounded by maxDuration=300s; 4 × 60s = 240s leaves headroom.
    const writtenParts = []
    for (const cluster of planParts) {
      const siblingSummaries = planParts
        .filter((p) => p.part !== cluster.part)
        .map((p) => ({ part: p.part, title: p.title || `Part ${p.part}` }))

      const partSystem = getSeriesPartSystemPrompt(
        overlaidWorkspace,
        staffName,
        interview.topic,
        interview.tone || 'smart',
        interview.voice_mode || 'practice',
        interview.prototype_id,
        voiceNotes,
        voicePhrases,
        effectiveLengthPreset,
        cluster,
        siblingSummaries,
        seriesTitle,
        ownHistoryBlock,
        interview.kind === 'point',
      ) + buildVerbatimBlock(interview.verbatim_flags)

      const { text } = await generateText({
        model: 'anthropic/claude-opus-5',
        instructions: partSystem,
        messages: [
          ...transcriptMessages,
          {
            role: 'user',
            content: `Please write Part ${cluster.part} of the series now, per the angle and anchor moments in the system prompt. Stay in this part's lane — let the sibling parts handle their threads.`,
          },
        ],
        maxOutputTokens: 4096,
      })
      if (!text?.trim()) throw new Error(`AI returned empty content for part ${cluster.part}`)

      const stripped = extractProvenanceBlock(text.trim()).content
      writtenParts.push({ cluster, content: stripped })
    }

    // ── Persist: insert N new pieces (source is already archived from the
    // atomic claim PATCH above) ──────────────────────────────────────────
    // Supabase REST has no transaction primitive across multiple calls. The
    // archive is already in the DB; only the inserts remain. If the bulk
    // insert fails, we un-archive the source so the user isn't left with
    // nothing. If a later step (outputs sync) fails, the series IS valid —
    // we log and continue.
    const seriesId = randomUUID()

    const newRows = writtenParts.map(({ cluster, content }) => ({
      workspace_id:        ws.id,
      interview_id:        interview.id,
      staff_id:        item.staff_id,
      staff_name:      item.staff_name,
      topic:               item.topic,
      platform:            'blog',
      content,
      ai_original_content: content,
      status:              'draft',
      media_urls:          [],
      location_id:         item.location_id ?? null,
      length_preset:       effectiveLengthPreset,
      series_id:           seriesId,
      series_part:         cluster.part,
      series_total:        actualPartCount,
    }))

    const insRes = await sb('content_items', {
      method: 'POST',
      body: JSON.stringify(newRows),
    })
    if (!insRes.ok) {
      await unclaimSource('insert-failed')
      return dbErr(res, insRes, 'Insert failed')
    }
    const inserted = await insRes.json()

    // Research-citation enrichment (.claude/blog-research-citations-spec.md)
    // — every inserted row is platform:'blog' (a series part), so each gets
    // its own enrichment pass. waitUntil() per part so one slow/failing part
    // can't block the others; the route's maxDuration is already 300 for the
    // cluster+write AI passes above, which comfortably covers this too.
    for (const row of inserted) {
      waitUntil(runCitationEnrichmentForContentItem({ workspaceId: ws.id, contentItemId: row.id }).catch((e) => {
        console.error(`[content-items/split-into-series] citation enrichment failed for part ${row.id}:`, e?.message)
      }))
    }

    // Update interview.outputs.blogPost to Part 1's content so downstream
    // atom regeneration uses the strongest standalone post as its editorial
    // summary. (Per-part atoms are a documented follow-up.)
    const part1 = inserted.find((r) => r.series_part === 1)
    if (part1?.content) {
      const nextOutputs = { ...(interview.outputs || {}), blogPost: part1.content }
      await sb(`interviews?id=eq.${interview.id}&${wsFilter}`, {
        method: 'PATCH',
        body: JSON.stringify({ outputs: nextOutputs }),
        headers: { Prefer: 'return=minimal' },
      })
    }

    return ok(res, {
      series_id:    seriesId,
      series_title: seriesTitle,
      parts:        inserted.sort((a, b) => (a.series_part || 0) - (b.series_part || 0)),
    }, 201)
  } catch (e) {
    console.error('[content-items/split-into-series]', e?.message || e)
    // Any thrown error in the AI / persist phase means the user's original
    // is currently archived with no series to show for it — un-claim so
    // they can retry or just keep working with their original draft.
    await unclaimSource('exception')
    return err(res, 'Series generation failed', 500)
  }
}
