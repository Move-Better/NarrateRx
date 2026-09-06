// Workspace book synthesis — turns raw substrate into one long-form
// manuscript written as the practice's collective voice.
//
// Source rules (CLAUDE-bound — do not feed atoms or AI-generated content):
//   - interviews where status='completed' AND has message content
//     (both capture_mode='interview' and capture_mode='voice_memo')
//   - staff_corpus_documents where doc_type IN ('original_blog','uploaded_draft')
//   - minus rows listed in book_excluded_sources
//
// Output is structured chapters in JSON:
//   { chapters: [{ slug, title, body_md }] }
//
// Pinned chapters (book_pinned_chapters) are NOT sent to the model — they're
// preserved verbatim and spliced into the final manuscript at the position
// recorded when they were pinned.

import { generateText } from 'ai'


import { supabaseRest } from './supabaseRest.js'
const MODEL = 'anthropic/claude-opus-5'

// Conservative input cap. Opus accepts ~200K tokens; we leave headroom for
// the system prompt + brand voice + structured output instruction overhead.
// One token ≈ 4 chars for English prose, so 600K chars ≈ 150K tokens.
const MAX_SOURCE_CHARS = 600_000

// Output cap. A medium book of 8 chapters × 800 words ≈ 8K tokens; we
// allow up to 16K to absorb tone work and long-quote inclusion. Bumped to
// 24K (2026-09-06, model swap to Opus 5): measured on real prod transcripts
// that Opus 5 uses ~1.7-2x the output tokens per character that Opus 4.7
// did for equivalent blog/series content — so the same 8-chapter book that
// used to fit in ~8K tokens could now need close to 16K, leaving no
// headroom under the old 16K cap. This value is NOT independently
// end-to-end verified against a real book synthesis run (that needs a
// full multi-interview workspace and a multi-minute, non-trivial-cost
// call) — it's extrapolated from the blog/series measurements. If a real
// book synthesis run comes back with finishReason 'length', raise this
// further rather than assuming the manuscript is just short.
const MAX_OUTPUT_TOKENS = 24_000

const sb = (path, init = {}) => supabaseRest(path, init, { contentType: 'application/json' })


// ── Source loading ─────────────────────────────────────────────────────────

function transcriptToProse(interview) {
  const messages =
    Array.isArray(interview.cleaned_messages) && interview.cleaned_messages.length
      ? interview.cleaned_messages
      : (Array.isArray(interview.messages) ? interview.messages : [])
  return messages
    .filter((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .map((m) => m.content.trim())
    .join('\n\n')
}

export async function loadSources({ workspaceId }) {
  // Pull excluded source ids first.
  const exRes = await sb(
    `book_excluded_sources?workspace_id=eq.${workspaceId}&select=source_table,source_id`
  )
  if (!exRes.ok) throw new Error(`book_excluded_sources ${exRes.status}`)
  const excluded = await exRes.json()
  const excludedInterviews = new Set(
    excluded.filter((e) => e.source_table === 'interviews').map((e) => e.source_id)
  )
  const excludedDocs = new Set(
    excluded.filter((e) => e.source_table === 'staff_corpus_documents').map((e) => e.source_id)
  )

  // Interviews (and voice memos, which are interviews with capture_mode='voice_memo').
  const ivRes = await sb(
    `interviews?workspace_id=eq.${workspaceId}&status=eq.completed` +
    `&select=id,topic,capture_mode,messages,cleaned_messages,created_at` +
    `&order=created_at.asc`
  )
  if (!ivRes.ok) throw new Error(`interviews ${ivRes.status}`)
  const interviewRows = await ivRes.json()

  const interviews = []
  const voiceMemos = []
  for (const iv of interviewRows) {
    if (excludedInterviews.has(iv.id)) continue
    const body = transcriptToProse(iv)
    if (!body) continue
    const entry = {
      kind:       iv.capture_mode === 'voice_memo' ? 'voice_memo' : 'interview',
      id:         iv.id,
      title:      iv.topic || 'Untitled',
      body,
      created_at: iv.created_at,
    }
    if (entry.kind === 'voice_memo') voiceMemos.push(entry)
    else interviews.push(entry)
  }

  // Original blogs and uploaded drafts.
  const docRes = await sb(
    `staff_corpus_documents?workspace_id=eq.${workspaceId}` +
    `&doc_type=in.(original_blog,uploaded_draft)` +
    `&archived_at=is.null` +
    `&select=id,doc_type,title,body,created_at` +
    `&order=created_at.asc`
  )
  if (!docRes.ok) throw new Error(`staff_corpus_documents ${docRes.status}`)
  const docRows = await docRes.json()

  const originalBlogs = []
  const uploadedDrafts = []
  for (const d of docRows) {
    if (excludedDocs.has(d.id)) continue
    if (!d.body || !String(d.body).trim()) continue
    const entry = {
      kind:       d.doc_type === 'original_blog' ? 'original_blog' : 'uploaded_draft',
      id:         d.id,
      title:      d.title || 'Untitled',
      body:       d.body,
      created_at: d.created_at,
    }
    if (entry.kind === 'original_blog') originalBlogs.push(entry)
    else uploadedDrafts.push(entry)
  }

  return { interviews, voiceMemos, originalBlogs, uploadedDrafts }
}

export async function loadPinnedChapters({ workspaceId }) {
  const r = await sb(
    `book_pinned_chapters?workspace_id=eq.${workspaceId}` +
    `&select=chapter_slug,chapter_title,chapter_md,position_hint&order=position_hint.asc`
  )
  if (!r.ok) throw new Error(`book_pinned_chapters ${r.status}`)
  return r.json()
}

// ── Source bundle assembly ────────────────────────────────────────────────

function labelForKind(kind) {
  return {
    interview:      'INTERVIEW TRANSCRIPT',
    voice_memo:     'VOICE MEMO',
    original_blog:  'ORIGINAL BLOG POST',
    uploaded_draft: 'TYPED DRAFT',
  }[kind] || 'SOURCE'
}

// Concatenate sources up to MAX_SOURCE_CHARS, preferring the most recent.
// Each entry is wrapped in a delimited block so the model can attribute
// quotes back to their source if useful — but the prompt forbids
// per-clinician attribution in the output.
export function assembleSourceBundle(sources) {
  const all = [
    ...sources.interviews,
    ...sources.voiceMemos,
    ...sources.originalBlogs,
    ...sources.uploadedDrafts,
  ].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

  let total = 0
  const blocks = []
  let included = 0
  let dropped = 0
  for (const s of all) {
    const block =
      `--- BEGIN ${labelForKind(s.kind)} — "${s.title.replace(/"/g, '\\"')}" ---\n` +
      `${s.body}\n` +
      `--- END ${labelForKind(s.kind)} ---\n`
    if (total + block.length > MAX_SOURCE_CHARS) { dropped++; continue }
    blocks.push(block)
    total += block.length
    included++
  }
  return { bundle: blocks.join('\n'), included, dropped }
}

// ── Prompt construction ───────────────────────────────────────────────────

function buildSystemPrompt({ workspace, pinnedChapters }) {
  const practiceName = workspace.display_name || workspace.app_name || 'the practice'
  const brandVoice = workspace.brand_voice
    ? `\nBrand voice for this practice (match its tone, vocabulary, sentence rhythm precisely):\n${workspace.brand_voice}\n`
    : ''

  const pinnedNote = pinnedChapters.length > 0
    ? `\nThe following chapter slugs are PINNED and will be inserted into the final manuscript verbatim. Do not produce chapters that duplicate or contradict them; route around them thematically: ${pinnedChapters.map((c) => `"${c.chapter_slug}" (${c.chapter_title})`).join(', ')}.\n`
    : ''

  return `You are the ghost writer for an evolving book authored by ${practiceName} as one collective voice.

Your job is to synthesize the practice's raw source material — interview transcripts, voice memos, original blog posts, typed drafts — into a structured book manuscript.

ABSOLUTE RULES — violating these makes the output unusable:

1. ONE COLLECTIVE VOICE. Write as if the entire practice authored every word together. NEVER name an individual clinician. NEVER use attribution phrases like "Sara said", "according to Hugh", or "one practitioner". The reader should feel they are hearing from a single unified author.

2. ORIGINAL VOICE ONLY. Every claim, story, and clinical perspective in the manuscript must come from the source material. Do not invent treatments, anecdotes, statistics, or examples. If the sources do not support a point, do not make it.

3. DIRECT QUOTES BECOME OUR WORDS. When source material contains a vivid or precise phrasing worth keeping, weave it into the prose as the book's own voice. Do not frame quotes as dialogue. No "X said" markers.

4. NO TRANSCRIPT TEXTURE. Source material is raw — filler words, half-finished thoughts, conversational repetition. The manuscript reads as clean published prose. Repair grammar and remove disfluencies; preserve substance and idiom.

5. THEME, NOT CHRONOLOGY. Group source material by theme into 3–10 chapters. Each chapter focuses on one coherent clinical or philosophical thread. Do not organize by interview, by date, or by speaker.

6. CHAPTER LENGTH. 400–1200 words of body per chapter. Tight where the source is thin; expansive where the source is rich.

7. PUNCTUATION RESTRAINT — EM-DASHES. The em-dash (—) is overused in default AI prose and reads as a tell. Use it at most once per chapter, and only when no other punctuation fits: a true mid-sentence interruption, an aside that a comma or parenthesis would mishandle, or a strong appositional pivot. Prefer a period, a semicolon, a colon, a comma, or simply restructuring the sentence. Never use em-dashes as a generic "pause" or to chain two clauses that a period would join cleanly. Same restraint applies to en-dashes (–) outside numeric ranges.

8. PARAGRAPH COHESION. Paragraphs are continuous units of thought, not a stack of single sentences. Each paragraph should run roughly 4–8 sentences and develop one idea before breaking. Connect sentences inside a paragraph with conjunctions, transitions, and pronoun reference so the prose flows; do not emit a paragraph break after every sentence. Break paragraphs only on a genuine shift in subject, scene, or argumentative move. A chapter of 600 words should typically be 3–6 paragraphs, not 15.${brandVoice}${pinnedNote}

OUTPUT FORMAT — strict JSON, nothing else, no code fences, no commentary:

{
  "chapters": [
    {
      "slug":    "lowercase-kebab-stable-id-derived-from-the-theme",
      "title":   "Chapter Title in Title Case",
      "body_md": "Markdown body of the chapter. Use paragraph breaks freely. Use blockquote (> ) sparingly and only for source phrasings that are too good to fold into prose."
    }
  ]
}

The slug must be lowercase-kebab-case, ASCII, derived from the theme so re-runs on similar material produce a similar slug (helps preserve pin alignment).`
}

function buildUserPrompt({ bundle, included }) {
  return `Below are ${included} source documents from this practice. Synthesize them into a manuscript per the rules in your system prompt. Output JSON only.

${bundle}

Remember: ONE collective voice, no clinician names, theme-organized chapters, clean published prose. Output JSON only.`
}

// ── Output parsing ────────────────────────────────────────────────────────

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled'
}

function parseChapters(text) {
  // The model is instructed to emit pure JSON. Be defensive about code fences
  // or leading prose just in case.
  let raw = String(text || '').trim()
  // Strip ```json fences if present.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  // Find the outermost { ... } if any leading text snuck in.
  const start = raw.indexOf('{')
  const end   = raw.lastIndexOf('}')
  if (start > 0) raw = raw.slice(start, end + 1)

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Book synthesis: model output was not valid JSON — ${e.message}`)
  }
  if (!parsed || !Array.isArray(parsed.chapters)) {
    throw new Error('Model output missing chapters array')
  }
  return parsed.chapters
    .filter((c) => c && typeof c.body_md === 'string' && c.body_md.trim())
    .map((c, i) => ({
      slug:    slugify(c.slug || c.title || `chapter-${i + 1}`),
      title:   String(c.title || 'Untitled').trim(),
      body_md: String(c.body_md).trim(),
      position: i,
    }))
}

// ── Pinned-chapter splice ─────────────────────────────────────────────────

function splicePinnedChapters(chapters, pinned) {
  if (!pinned.length) return chapters

  // Drop any model-emitted chapter whose slug duplicates a pinned slug.
  const pinnedSlugs = new Set(pinned.map((p) => p.chapter_slug))
  const fresh = chapters.filter((c) => !pinnedSlugs.has(c.slug))

  // Insert each pinned chapter at its recorded position_hint (best-effort).
  // Pinned chapters not aligned to any position fall at the end.
  const combined = [...fresh]
  const aligned = pinned
    .filter((p) => Number.isInteger(p.position_hint))
    .sort((a, b) => a.position_hint - b.position_hint)
  for (const p of aligned) {
    const idx = Math.min(p.position_hint, combined.length)
    combined.splice(idx, 0, {
      slug:     p.chapter_slug,
      title:    p.chapter_title,
      body_md:  p.chapter_md,
      position: idx,
      pinned:   true,
    })
  }
  const unaligned = pinned.filter((p) => !Number.isInteger(p.position_hint))
  for (const p of unaligned) {
    combined.push({
      slug:     p.chapter_slug,
      title:    p.chapter_title,
      body_md:  p.chapter_md,
      position: combined.length,
      pinned:   true,
    })
  }
  // Renumber positions.
  combined.forEach((c, i) => { c.position = i })
  return combined
}

// ── Manuscript assembly ───────────────────────────────────────────────────

function chaptersToManuscript(chapters) {
  return chapters
    .map((c) => `## ${c.title}\n\n${c.body_md.trim()}\n`)
    .join('\n')
    .trim()
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export async function synthesizeBook({ workspaceId, workspace }) {
  if (!workspaceId) throw new Error('synthesizeBook: workspaceId required')

  const [sources, pinned] = await Promise.all([
    loadSources({ workspaceId }),
    loadPinnedChapters({ workspaceId }),
  ])

  const totalSourceCount =
    sources.interviews.length +
    sources.voiceMemos.length +
    sources.originalBlogs.length +
    sources.uploadedDrafts.length

  if (totalSourceCount === 0 && pinned.length === 0) {
    throw new Error('No source material available — add at least one interview, voice memo, original blog, or draft before regenerating.')
  }

  const { bundle, included, dropped } = assembleSourceBundle(sources)

  let chapters = []
  if (included > 0) {
    const system = buildSystemPrompt({ workspace, pinnedChapters: pinned })
    const user   = buildUserPrompt({ bundle, included })

    const { text } = await generateText({
      model: MODEL,
      system,
      messages: [{ role: 'user', content: user }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    })
    chapters = parseChapters(text)
  }

  const finalChapters = splicePinnedChapters(chapters, pinned)
  const manuscriptMd  = chaptersToManuscript(finalChapters)

  const sourceCounts = {
    interviews:      sources.interviews.length,
    voice_memos:     sources.voiceMemos.length,
    original_blogs:  sources.originalBlogs.length,
    uploaded_drafts: sources.uploadedDrafts.length,
    sources_dropped: dropped,
  }

  return { manuscriptMd, chapters: finalChapters, sourceCounts }
}
