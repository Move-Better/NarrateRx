import { useState, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSmartBack } from '@/lib/useSmartBack'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Sparkles, AlertCircle, Mic, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useStaffMember, useInterview, queryKeys } from '@/lib/queries'
import { updateInterview, populateContentItemProvenance, fetchStaffMember, fetchStaffMemberRecentContent } from '@/lib/api'
import { buildOwnHistoryBlock, pickPriorInterviews } from '@/lib/practiceMemory'
import { streamMessage } from '@/lib/claude'
import { extractProvenanceBlock } from '@/lib/provenance'
import { getBlogPostSystemPrompt } from '@/lib/prompts'
import { useWorkspace } from '@/lib/WorkspaceContext'
import { applyLocationOverlay } from '@/lib/locationOverlay'
import { resolveAudienceSlot, resolveStoryTypeSlot } from '@/lib/interviewOptionsCatalog'
import { toast } from '@/lib/toast'

/**
 * CaptureReview — shown after a voice memo upload completes.
 *
 * Displays the Whisper transcript so the clinician can correct any mishearing
 * before generation, then streams the blog post using the same prompt +
 * pipeline as InterviewSession. On completion it PATCHes status='completed'
 * (which triggers content_items creation server-side) and routes to Stories.
 *
 * Route: /capture/:staffId/:interviewId/review
 */
export default function CaptureReview() {
  useDocumentTitle('Review transcript')
  const navigate = useNavigate()
  const goBack = useSmartBack('/')
  const { staffId, interviewId } = useParams()
  const qc = useQueryClient()
  const ws = useWorkspace()

  const { data: interview, isLoading: ivLoading, isError: ivError } = useInterview(interviewId)
  const { data: staffMember, isLoading: clLoading } = useStaffMember(staffId)

  // Editable transcript — seeded from the Whisper output on first load.
  const [transcript, setTranscript] = useState(null) // null = not yet seeded
  const [isGenerating, setIsGenerating] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState('')
  const genFiredRef = useRef(false)

  // Seed the editable transcript once (not on every re-render).
  if (transcript === null && interview?.messages?.[0]?.content) {
    setTranscript(interview.messages[0].content)
  }

  const isTextImport = interview?.capture_mode === 'text_import'

  const generate = useCallback(async () => {
    if (genFiredRef.current || isGenerating) return
    genFiredRef.current = true
    setIsGenerating(true)
    setError('')
    setStreamingText('')

    try {
      // URL-import path — the imported text IS the keystone. No LLM call;
      // it makes no sense to "write a blog post" from a blog post. We save
      // the (possibly user-edited) text directly as outputs.blogPost; atoms
      // (social, video, marketing) are generated downstream from this
      // keystone the same way they would be for a clinician-voiced post.
      if (isTextImport) {
        const blogPost = (transcript || '').trim()
        if (!blogPost) throw new Error('Imported text is empty — nothing to save.')

        await updateInterview(interviewId, {
          messages: [{ role: 'user', content: transcript }],
          outputs: { blogPost, generatedAt: new Date().toISOString() },
          status: 'completed',
        })

        qc.invalidateQueries({ queryKey: queryKeys.interviews.all })
        qc.invalidateQueries({ queryKey: queryKeys.staff.all })
        qc.invalidateQueries({ queryKey: queryKeys.contentItems.all })
        qc.invalidateQueries({ queryKey: queryKeys.stories?.all ?? ['stories'] })

        toast.success('Imported — your atoms are ready.')
        navigate(`/stories/${interviewId}`, { replace: true })
        return
      }

      // Voice-memo path — synthesize a blog post from the transcript.
      // Resolve workspace overlay (location-level overrides, if any).
      // applyLocationOverlay needs the location ROW, not the id — looking up
      // the row from ws.locations is what InterviewSession does (line 608).
      const interviewLocation = interview?.location_id
        ? (ws?.locations || []).find(l => l.id === interview.location_id)
        : null
      const overlaidWorkspace = interviewLocation ? applyLocationOverlay(ws, interviewLocation) : ws

      // Voice phrases + practice-memory history for this clinician.
      // Best-effort across the board — a failure on any of these must not
      // block generation. Run in parallel to keep the pre-stream wait short.
      let voicePhrases = []
      let ownHistoryBlock = ''
      try {
        const { apiFetch } = await import('@/lib/api')
        const [vp, staffRow, recentContent] = await Promise.all([
          apiFetch(`/api/staff/voice-phrases?staff_id=${staffId}&limit=8`).catch(() => null),
          fetchStaffMember(staffId).catch(() => null),
          fetchStaffMemberRecentContent(staffId, 3).catch(() => []),
        ])
        voicePhrases = Array.isArray(vp?.phrases) ? vp.phrases : []
        if (staffRow) {
          ownHistoryBlock = buildOwnHistoryBlock({
            staffName: staffRow.name || 'this clinician',
            priorInterviews: pickPriorInterviews(staffRow.interviews || [], interviewId),
            priorContent: Array.isArray(recentContent) ? recentContent : [],
          })
        }
      } catch (e) {
        console.warn('[CaptureReview] context fetch failed:', e?.message)
      }

      const systemPrompt = getBlogPostSystemPrompt(
        overlaidWorkspace,
        staffMember?.name || 'the clinician',
        interview?.topic || 'Voice memo',
        interview?.tone || 'smart',
        interview?.voice_mode || 'personal',
        interview?.prototype_id || null,
        staffMember?.voice_notes || '',
        voicePhrases,
        resolveAudienceSlot(interview?.audience, overlaidWorkspace?.audience_options),
        resolveStoryTypeSlot(interview?.story_type, overlaidWorkspace?.story_type_options),
        null, // lengthPreset
        ownHistoryBlock,
        interview?.kind === 'point',
      )

      // The transcript is the sole user message. We append a generation cue
      // so the model knows to produce the blog post (same pattern as
      // InterviewSession's streamMessages).
      const streamMessages = [
        { role: 'user', content: transcript },
        { role: 'user', content: 'Please write the blog post now based on this voice memo.' },
      ]

      let accumulated = ''
      for await (const delta of streamMessage(streamMessages, systemPrompt, {
        model: 'claude-opus-5',
        maxOutputTokens: 12_000,
      })) {
        accumulated += delta
        setStreamingText(accumulated)
      }

      const { content: blogPost, provenanceJson } = extractProvenanceBlock(accumulated)
      if (!blogPost.trim()) throw new Error('No content returned from generation')

      const outputs = { blogPost, generatedAt: new Date().toISOString() }

      // Update the interview with the (possibly edited) transcript + outputs,
      // then mark completed. The server-side cascade creates content_items rows.
      await updateInterview(interviewId, {
        messages: [{ role: 'user', content: transcript }],
        outputs,
        status: 'completed',
      })

      qc.invalidateQueries({ queryKey: queryKeys.interviews.all })
      qc.invalidateQueries({ queryKey: queryKeys.staff.all })
      qc.invalidateQueries({ queryKey: queryKeys.contentItems.all })
      qc.invalidateQueries({ queryKey: queryKeys.stories?.all ?? ['stories'] })

      // Provenance — best-effort, non-blocking.
      populateContentItemProvenance(interviewId, provenanceJson || '', 'blog').catch((e) => {
        console.warn('[CaptureReview] provenance failed:', e?.message)
      })

      toast.success('Content generated — reviewing your story.')
      navigate(`/stories/${interviewId}`, { replace: true })
    } catch (err) {
      genFiredRef.current = false
      setIsGenerating(false)
      setStreamingText('')
      setError(err?.message || 'Generation failed — please try again.')
    }
  }, [transcript, staffMember, interview, ws, staffId, interviewId, isGenerating, isTextImport, navigate, qc])

  const loading = ivLoading || clLoading

  if (loading) {
    return (
      <div role="status" className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading…</span>
      </div>
    )
  }

  if (ivError || !interview) {
    return (
      <div className="py-16 text-center space-y-3">
        <AlertCircle className="h-8 w-8 text-destructive mx-auto" />
        <p className="text-sm text-muted-foreground">Could not load the interview — it may have been deleted.</p>
        <Button variant="ghost" onClick={goBack}>← Back</Button>
      </div>
    )
  }

  // If this interview already has outputs (e.g. user hit back after generation),
  // skip straight to stories rather than letting them re-generate.
  if (interview.status === 'completed' && interview.outputs?.blogPost) {
    navigate(`/stories/${interviewId}`, { replace: true })
    return null
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={goBack} aria-label="Back">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isTextImport ? 'Review imported text' : 'Review transcript'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isTextImport
              ? 'Clean up anything before saving as your keystone.'
              : 'Fix any mishearing, then generate.'}
          </p>
        </div>
      </div>

      {/* Transcript edit */}
      {!isGenerating && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {isTextImport
                ? <FileText className="h-4 w-4 text-muted-foreground" />
                : <Mic className="h-4 w-4 text-muted-foreground" />}
              <span>
                {isTextImport ? 'Imported text' : 'Transcribed from your recording'}
              </span>
            </div>
            <Textarea
              aria-label="Transcript"
              value={transcript ?? ''}
              onChange={(e) => setTranscript(e.target.value)}
              rows={10}
              className="resize-y text-sm leading-relaxed"
              placeholder={isTextImport ? 'Imported text will appear here…' : 'Transcript will appear here…'}
            />
            <p className="text-xs text-muted-foreground">
              {isTextImport
                ? 'This will be saved as your keystone piece — atoms (social, video, email) will derive from it.'
                : 'Edit anything Whisper got wrong before you generate.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Streaming preview during generation (voice-memo only — text imports
          don't run an LLM call, so they go straight to the saving state). */}
      {isGenerating && streamingText && (
        <Card>
          <CardContent className="p-5">
            <div role="status" className="flex items-center gap-2 text-sm font-medium mb-3">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-primary" />
              <span>Writing your blog post…</span>
            </div>
            <div className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto">
              {streamingText}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Generating / saving with no text yet */}
      {isGenerating && !streamingText && (
        <Card>
          <CardContent role="status" className="p-6 flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
            <p className="text-sm font-medium">
              {isTextImport ? 'Saving your keystone…' : 'Generating content…'}
            </p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              {isTextImport
                ? 'One moment — your story will open next.'
                : "Turning your voice memo into a full blog post. Won't be long."}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
          {error}
        </div>
      )}

      {/* Primary CTA */}
      {!isGenerating && (
        <Button
          className="w-full"
          size="lg"
          onClick={generate}
          disabled={!transcript?.trim()}
        >
          <Sparkles className="h-4 w-4 mr-2" />
          {isTextImport ? 'Save and atomize' : 'Generate content'}
        </Button>
      )}
    </div>
  )
}
