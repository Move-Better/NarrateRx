import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { posthogCapture } from '@/lib/posthog'
import { useUser } from '@clerk/react'
import { useWakeLock } from '../hooks/useWakeLock'
import { useSmartBack } from '@/lib/useSmartBack'
import { ArrowLeft, ArrowRight, Loader2, Sparkles, AlertCircle, AlertTriangle, Mic, MicOff, Volume2, Mic2, PauseCircle, Quote, X, ArrowLeftRight, CheckCircle2, Circle, Check, RefreshCw, Send, Keyboard, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { apiFetch, fetchSimilarInterviews, fetchStaffMember, fetchStaffMemberRecentContent, updateInterview, cleanupTranscript, populateContentItemProvenance, runVoiceAuditForInterview, runPointSafetyAuditForInterview } from '@/lib/api'
import { buildOwnHistoryBlock, pickPriorInterviews } from '@/lib/practiceMemory'
import { extractProvenanceBlock } from '@/lib/provenance'
import { useStaffMember, useInterview, useCampaigns, queryKeys } from '@/lib/queries'
import { useQueryClient } from '@tanstack/react-query'
import PostCallReveal from '@/components/PostCallReveal'
import { streamMessage } from '@/lib/claude'
import { getInterviewSystemPrompt, getPointInterviewSystemPrompt, getBlogPostSystemPrompt, getNewsletterSystemPrompt, buildCampaignGoalBlock, getMinimalEditSystemPrompt, getCoveredSummarySystemPrompt, TONES, getVoiceModes, getPatientPrototypesUi, buildVerbatimBlock } from '@/lib/prompts'
import { resolveAudienceSlot, resolveStoryTypeSlot } from '@/lib/interviewOptionsCatalog'
import { buildStyleMemoryBlock } from '@/lib/interviewTactics'
import { detectEmotionalState, getEmotionPromptInjection } from '@/lib/emotionDetection'
import { getInitials } from '@/lib/utils'
import { workspace } from '@/lib/workspace'
import { useWorkspace } from '@/lib/WorkspaceContext'
import { applyLocationOverlay } from '@/lib/locationOverlay'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import MicCheck from '@/components/MicCheck'
import VideoAttachPrompt from '@/components/VideoAttachPrompt'
import { createTtsPlayer, primeAudioPlayback, onAudioPlaybackFailure } from '@/lib/tts'
import { useRegisterBusy } from '@/lib/appBusy'
import { useInterviewAudioCapture } from '@/hooks/useInterviewAudioCapture'
import { loadLocalMessages, saveLocalMessages, clearLocalMessages, loadDraft, saveDraft, clearDraft } from '@/lib/interviewLocalBackup'
import { stripStoryDatePrefix } from '@/lib/storyTitle'

// Concrete noun list for shallow-answer detection (Feature 2)
const CONCRETE_NOUNS = ['patient', 'person', 'name', 'case', 'example', 'time', 'moment', 'client', 'athlete', 'runner', 'worker']

function isShallowAnswer(text) {
  const words = text.trim().split(/\s+/)
  if (words.length >= 15) return false
  const lower = text.toLowerCase()
  return !CONCRETE_NOUNS.some((noun) => lower.includes(noun))
}

// Token format: [CONTRAST][StafflastName] or legacy [CONTRAST]
// Extract the embedded clinician name if present, e.g. [CONTRAST][Sarah] → "Sarah"
function extractContrastName(text) {
  const m = text.match(/\[CONTRAST\]\[([^\]]+)\]/)
  return m ? m[1] : null
}

function stripContrastToken(text) {
  return text.replace(/\[CONTRAST\](\[[^\]]*\])?/g, '').trim()
}

function hasContrastSignal(text) {
  return text.includes('[CONTRAST]')
}

// Token format: [AGREEMENT][StaffName] or legacy [AGREEMENT]
// Extract the embedded clinician name if present, e.g. [AGREEMENT][Sarah] → "Sarah"
function extractAgreementName(text) {
  const m = text.match(/\[AGREEMENT\]\[([^\]]+)\]/)
  return m ? m[1] : null
}

function stripAgreementToken(text) { return text.replace(/\[AGREEMENT\](\[[^\]]*\])?/g, '').trim() }
function hasAgreementSignal(text)   { return text.includes('[AGREEMENT]') }

function stripGapToken(text) { return text.replace(/\[GAP\]/g, '').trim() }
function hasGapSignal(text)  { return text.includes('[GAP]') }

const COMPLETE_TOKEN = 'INTERVIEW_COMPLETE'

// Session-end phrases — matched at end of utterance to signal interview completion.
// "next question" and "move on" are intentionally excluded here: they're opt-out
// signals handled by emotionDetection (→ 'resistant' state) so the AI transitions
// topics gracefully rather than ending the session.
const STOP_PHRASES = [
  "that's all",
  "that's it",
  "i'm done",
  "i am done",
  "send it",
  "send that",
  "submit",
  "done",
]

function detectAndStripStopPhrase(transcript) {
  const normalized = transcript.trimEnd().toLowerCase()
  for (const phrase of STOP_PHRASES) {
    if (normalized.endsWith(phrase)) {
      const stripped = transcript.trimEnd()
      const cleaned = stripped.slice(0, stripped.length - phrase.length).trimEnd()
      return cleaned.length > 0 ? cleaned : ''
    }
  }
  return null
}

// Is a stream failure worth auto-retrying? Auth (401/403) and rate-limit (429)
// won't recover on retry; everything else (gateway→Anthropic upstream blips
// surfaced as "A network error occurred", 5xx, timeouts, generic fetch aborts)
// is transient and safe to re-run the turn for.
function isTransientStreamError(e) {
  const status = e?.status
  if (status === 401 || status === 403 || status === 429) return false
  if (typeof status === 'number' && status >= 400 && status < 500) return false
  // 529 = AI gateway overloaded (transient); other 5xx may include structural errors
  // (invalid model, quota hard-stop) but we can't distinguish without parsing the body.
  // Retry once is acceptable for structural errors — the 3-retry max is the real cap.
  return true
}

// Derive rough "clinician's voice %" from the raw provenanceJson blocks string.
// verbatim + close_paraphrase blocks = paragraphs that came from the clinician's
// own words. Returns 0–100 or null when data is absent / unparseable.
function deriveVoicePct(provenanceJson) {
  if (!provenanceJson) return null
  try {
    const parsed = JSON.parse(provenanceJson)
    const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : []
    if (blocks.length === 0) return null
    const voiceBlocks = blocks.filter(
      (b) => b.source_type === 'verbatim' || b.source_type === 'close_paraphrase',
    ).length
    return Math.round((voiceBlocks / blocks.length) * 100)
  } catch {
    return null
  }
}

export default function InterviewSession() {
  useDocumentTitle('Interview')
  const { staffId, interviewId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  // When the user reaches this page from NewInterview, the audio (mic +
  // speaker) check already ran BEFORE the interview row was created, so we
  // skip the in-session mic-check gate. Resumes and direct links still see it.
  const cameFromMicCheck = !!location.state?.micChecked
  // wrap=1 is set by PhoneCall (Live Interview) when the user clicks End.
  // Treated as a strong signal that the call is complete even if the
  // realtime client's final PATCH to inject COMPLETE_TOKEN failed — without
  // this, a failed PATCH dumps the user into chat-resume mode and the
  // interview "starts again" instead of wrapping into blog generation.
  const wrapHint = searchParams.get('wrap') === '1'
  const { user } = useUser()
  // Track the visual viewport height so the interview wrapper shrinks when
  // the iOS keyboard opens. `100dvh` accounts for the address bar but NOT
  // the soft keyboard — without this, the typed-answer dock (and its
  // textarea) end up hidden behind the keyboard on iPhone. Falls back to
  // null on browsers without visualViewport; the CSS calc handles those.
  const [vvHeight, setVvHeight] = useState(null)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return
    const vv = window.visualViewport
    const update = () => setVvHeight(vv.height)
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  const runtimeWorkspace = useWorkspace()
  const VOICE_MODES = getVoiceModes(runtimeWorkspace)
  const { startCapture, stopAndUpload, recoverOrphanedAudio } = useInterviewAudioCapture()
  const PATIENT_PROTOTYPES_UI = getPatientPrototypesUi(runtimeWorkspace)

  // Initial fetches go through the shared query cache. Cache hits when the
  // user navigates here from the clinician profile (already warm) or
  // returns to a previously-loaded interview within the gcTime window.
  const qc = useQueryClient()
  const { data: staffData, isLoading: staffMemberLoading } = useStaffMember(staffId)
  const { data: interviewData, isLoading: interviewLoading } = useInterview(interviewId)
  // Campaign goals (Settings → Campaigns) — used only by the goal-steered
  // "Write a newsletter" flow to resolve the bound campaign_id into a steering
  // block. Returns [] for everyone else; never blocks the interview.
  const { data: campaignsList = [] } = useCampaigns()
  const staffMember = staffData ?? null
  const [interview, setInterview] = useState(null)
  const loading = interviewLoading || staffMemberLoading || !interview
  const [messages, setMessages] = useState([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [interviewComplete, setInterviewComplete] = useState(false)
  // F2 A.3: true when this load is the post-realtime-call wrap handoff
  // (?from=realtime&wrap=1) — drives the PostCallReveal in place of the normal
  // generating/completion cards.
  const [fromRealtimeWrap, setFromRealtimeWrap] = useState(false)
  // Keep the screen awake while the interview is live so a laptop/phone
  // doesn't dim or sleep mid-conversation.
  useWakeLock(!!interview && !interviewComplete)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationStyle, setGenerationStyle] = useState('blog_post')
  const [error, setError] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  // Typed-answer fallback. SpeechRecognition is unavailable on iOS Safari
  // (and any non-Chromium browser); when absent, the mic UI is replaced by a
  // textarea + Send button. We compute support once at mount so we don't
  // re-detect on every render.
  const hasSpeechRecognition = typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  const [typedAnswer, setTypedAnswer] = useState('')
  const [isSpeaking, setIsSpeaking] = useState(false)
  // Tell app-wide consumers (e.g. the auto-update modal) not to interrupt
  // the user while a recording/streaming/generation is in flight. A
  // window.location.reload() in the middle of any of these wipes the
  // in-memory transcript before it's saved.
  useRegisterBusy(
    'interview-session',
    isListening || isSpeaking || isStreaming || isGenerating,
  )
  // True after an audio playback failure (iOS route change, BT disconnect,
  // audio-session interruption). Surfaces a "Tap to restore audio" button so
  // the user can re-prime audio inside a fresh user gesture.
  const [audioInterrupted, setAudioInterrupted] = useState(false)
  const [showInstructions, setShowInstructions] = useState(true)
  // micCheckPassed gates the mic check screen shown after the pre-interview
  // instructions but before the AI sends its first question. Pre-passed when
  // the audio check already ran in NewInterview (see cameFromMicCheck) so we
  // don't double-prompt and so the interview row only exists once the user
  // has cleared the audio gate.
  const [micCheckPassed, setMicCheckPassed] = useState(cameFromMicCheck)
  const [saveStatus, setSaveStatus] = useState('') // '' | 'saving' | 'saved' | 'error'
  // Resume banner: true for 1.5s when returning to a session with saved state
  const [showResumeBanner, setShowResumeBanner] = useState(false)
  // Verbatim-flag UX state. selectionTip = { text, top, left } when the user has
  // selected a chunk of clinician text inside the conversation log that's a
  // valid substring of the user-message transcript; otherwise null.
  const [selectionTip, setSelectionTip] = useState(null)
  const conversationRef = useRef(null)

  const topRef = useRef(null)
  const hasStarted = useRef(false)
  // Last assistant turn's input, so the inline "Try again" button can re-run it
  // in place after a transient stream failure (no full page reload).
  const lastTurnRef = useRef(null)
  const recognitionRef = useRef(null)
  const messagesRef = useRef([])
  const transcriptRef = useRef('')
  const autoListenRef = useRef(false)
  // Track consecutive auto-listen 'aborted' errors so we can retry once with a
  // longer delay (iOS audio session sometimes hasn't released the mic by the
  // 700ms mark after TTS ends) and then bail to "tap to talk" rather than
  // looping forever.
  const autoListenAbortRetryRef = useRef(0)
  // "User is answering right now" — set true on mic-on, false when the user
  // explicitly ends their turn (taps mic, says a stop phrase, interview ends).
  // Used to auto-resume the SpeechRecognition engine through thinking pauses:
  // browsers throw 'no-speech' after a few seconds of silence and end the
  // session, but if the user is still in their answer turn we silently
  // restart the engine so pauses don't cut them off.
  const userAnswerActiveRef = useRef(false)
  // Cap auto-restarts per turn so a stuck mic can't loop forever. With a
  // typical 3-7s no-speech timeout this is ~3 minutes of pure silence —
  // far more thinking time than any answer needs.
  const restartCountRef = useRef(0)
  const RESTART_CAP = 30
  // Stable timer ref so we can cancel pending restarts on stop/cleanup.
  const restartTimerRef = useRef(null)
  const finalTranscriptRef = useRef('')
  // Waveform visualization refs — parallel getUserMedia stream for mic level.
  // SpeechRecognition doesn't expose audio data, so we open a second stream
  // purely for visualization and release it when not listening.
  const waveformRef = useRef(null)
  const analyserRef = useRef(null)
  const animFrameRef = useRef(null)
  const vizStreamRef = useRef(null)
  const vizCtxRef = useRef(null)
  const interviewRef = useRef(null)
  // Mirror runtimeWorkspace into a ref so the memoized sendToAI (whose dep array
  // intentionally excludes runtimeWorkspace to stay stable) reads the LATEST
  // workspace — including locations used for the per-interview location overlay —
  // instead of closing over a stale value. Matches the interviewRef pattern.
  const runtimeWorkspaceRef = useRef(null)
  const pastInterviewsRef = useRef([])
  // Unmount guard — set false in cleanup so async generators in generateCoveredSummary
  // and handleGenerateContent don't call setState on an unmounted component.
  const mountedRef = useRef(true)
  // Emotional-state ref: 'weighted' | 'resistant' | null.
  // Set after each user message; reset to null after each AI response completes.
  // State is per-exchange — not persistent across the whole session.
  const emotionStateRef = useRef(null)
  // Track which user-message indexes have already triggered a re-probe
  const reprobedIndexesRef = useRef(new Set())
  // Phase 5 Feature 2 — hot-context block (this clinician's prior interviews
  // + recent approved content). Built once when clinician + content fetch
  // resolve; injected into every system prompt for the session.
  const ownHistoryBlockRef = useRef('')
  // Phase 2 (evolving interviewer): anti-repeat + register-ceiling block, built
  // from staff.interview_style_memory when the clinician row resolves.
  const styleMemoryBlockRef = useRef('')
  // Goal-steered "Write a newsletter" flow. When the interview is bound to a
  // campaign_id, goalBlockRef holds the steering block injected into every
  // interview turn, and campaignRef holds the campaign for newsletter
  // generation. Both stay empty for a regular interview.
  const goalBlockRef = useRef('')
  const campaignRef = useRef(null)
  // Neural-TTS player (ElevenLabs) with speechSynthesis fallback. Constructed
  // lazily so SSR / no-window environments don't blow up. See src/lib/tts.js.
  const ttsRef = useRef(null)
  function getTts() {
    if (!ttsRef.current) ttsRef.current = createTtsPlayer()
    return ttsRef.current
  }
  // Learned practice knowledge from concept graph — fetched once at session start
  const conceptBlockRef   = useRef('')
  const agreementBlockRef = useRef('')
  const gapBlockRef       = useRef('')
  // Refs for pause/resume persistence
  const sessionSaveTimerRef = useRef(null)
  const userIdRef = useRef(null)
  const interviewCompleteRef = useRef(false)
  // Seeding guard: messages restoration runs exactly once per interview-id
  // mount. Without this, every React Query background refetch (window focus,
  // network reconnect, post-save invalidation) re-fires the seeding effect
  // with a stale DB row and clobbers in-flight local state — which is how
  // clinicians lost 5–6 saved responses mid-session and got bounced back to
  // question 1.
  const hasSeededRef = useRef(false)
  const seededForIdRef = useRef(null)
  // One-shot guard for orphaned-audio recovery (P3) — declared here with the
  // other per-interview guards so it resets on interview-id change too.
  const recoveredOrphanRef = useRef(false)
  // Reset the guards when the interview id changes so navigating between
  // interviews still re-seeds (and re-checks recovery for) the new one
  // correctly. This runs synchronously during render — that's intentional: by
  // the time the seeding effect below reads hasSeededRef, the flag must already
  // be cleared for the new id.
  if (seededForIdRef.current !== interviewId) {
    seededForIdRef.current = interviewId
    hasSeededRef.current = false
    recoveredOrphanRef.current = false
  }

  function saveMessages(interviewId, patch) {
    // If this save finalizes the interview (clears session_state), cancel any
    // pending debounced session_state autosave first. Otherwise that 3s timer
    // can fire AFTER this null-out lands and re-write session_state to the live
    // messages — Supabase REST is last-writer-wins per column, so the resume
    // banner would resurrect on the next visit of a completed interview.
    if (patch && patch.session_state === null) {
      clearTimeout(sessionSaveTimerRef.current)
      sessionSaveTimerRef.current = null
    }
    // Always mirror to localStorage FIRST so the data survives even if the
    // server PATCH never lands (auth blip, network, iOS WebKit kill).
    if (Array.isArray(patch?.messages)) saveLocalMessages(interviewId, patch.messages)

    setSaveStatus('saving')
    updateInterview(interviewId, patch)
      .then((updated) => {
        // Cross-component invalidation: any view watching this interview
        // (Dashboard's resume list, clinician profile's interview summary)
        // re-fetches on next render rather than staying frozen.
        if (updated?.id) qc.setQueryData(queryKeys.interviews.detail(updated.id), updated)
        qc.invalidateQueries({ queryKey: queryKeys.interviews.all })
        qc.invalidateQueries({ queryKey: queryKeys.staff.all })
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus(''), 2000)
      })
      .catch((err) => {
        console.error('[InterviewSession] save failed', err?.status, err?.message)
        setSaveStatus('error')
      })
  }

  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { transcriptRef.current = transcript }, [transcript])
  useEffect(() => { interviewRef.current = interview }, [interview])
  useEffect(() => { runtimeWorkspaceRef.current = runtimeWorkspace }, [runtimeWorkspace])
  useEffect(() => { userIdRef.current = user?.id }, [user?.id])
  useEffect(() => { interviewCompleteRef.current = interviewComplete }, [interviewComplete])

  // Build the session_state payload from the current messages ref.
  // Called both from the debounced effect and from the unload/visibility handlers.
  function buildSessionState(msgs) {
    return {
      messages: msgs,
      paused_at: new Date().toISOString(),
    }
  }

  // Persist session_state immediately — used by unload/visibility handlers.
  // Uses a keepalive fetch with the Clerk bearer token so the request can
  // continue past navigation. sendBeacon was previously used but cannot set
  // an Authorization header, so it would fail server-side auth (server only
  // accepts verified Clerk tokens since the 2026-05-21 audit P0 #4 fix).
  // Localstorage mirroring (saveLocalMessages) is the real safety net if
  // this best-effort flush is dropped.
  async function flushSessionState(msgs) {
    const uid = userIdRef.current
    if (!uid || interviewCompleteRef.current || !msgs.length) return
    const url = `/api/db/interviews?id=${encodeURIComponent(interviewId)}`
    const payload = JSON.stringify({
      session_state: buildSessionState(msgs),
      paused_at: new Date().toISOString(),
    })
    try {
      const token = await window.Clerk?.session?.getToken?.()
      if (!token) return
      await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        credentials: 'include',
        body: payload,
        keepalive: true,
      })
    } catch {
      // Best-effort; localStorage mirror already happened upstream.
    }
  }

  // Debounced auto-save of session_state whenever messages change.
  // Runs 3s after the last message update. Skipped when interview is done
  // (session_state is cleared on completion instead). Also mirrors to
  // localStorage immediately on every messages change as a last-line backup.
  useEffect(() => {
    if (!interviewId || messages.length === 0) return
    // Local backup runs even before any server save and even if user isn't ready.
    saveLocalMessages(interviewId, messages)
    if (!user?.id || interviewComplete) return
    clearTimeout(sessionSaveTimerRef.current)
    sessionSaveTimerRef.current = setTimeout(() => {
      updateInterview(
        interviewId,
        { session_state: buildSessionState(messages), paused_at: new Date().toISOString() },
      ).catch((err) => {
        console.error('[InterviewSession] session_state autosave failed', err?.status, err?.message)
        setSaveStatus('error')
      })
    }, 3000)
    return () => clearTimeout(sessionSaveTimerRef.current)
  }, [messages, interviewComplete, user?.id, interviewId])

  // Immediate flush on tab hide or page unload.
  // iOS Safari fires `pagehide` instead of `beforeunload` when switching apps
  // or closing a tab, so both listeners share the same handler body.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flushSessionState(messagesRef.current)
    }
    function onUnload() {
      flushSessionState(messagesRef.current)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('pagehide', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [interviewId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Seed local interview state (which we then mutate during conversation)
  // from the cached row. Bounce back to dashboard on a hard 404 — the
  // useInterview hook returns null in that case via the queryFn's contract.
  useEffect(() => {
    if (interviewLoading) return
    if (!interviewData) { navigate('/'); return }
    // Always refresh the interview metadata object (topic, status, outputs,
    // location, owner) — that's safe to track from server. But messages
    // restoration is one-shot per mount, guarded below.
    setInterview(interviewData)
    if (hasSeededRef.current) return
    hasSeededRef.current = true
    setGenerationStyle(interviewData.generation_style || 'blog_post')

    // Resume from session_state if available (paused mid-interview).
    // session_state.messages is the authoritative source when present; it
    // may be ahead of the DB messages column (which only saves on each
    // user turn, not on every AI response). Prefer session_state so the
    // resumed transcript matches exactly what the clinician saw before pausing.
    //
    // The localStorage backup wins over the server when it has MORE messages —
    // that's the signature of saves having failed silently mid-session. When
    // we pick the local copy, push it back up so the server catches up.
    const savedState = interviewData.session_state
    const serverMessages = savedState?.messages ?? interviewData.messages ?? []
    const localBackup = loadLocalMessages(interviewId)
    const localMessages = Array.isArray(localBackup?.messages) ? localBackup.messages : []
    const useLocal = localMessages.length > serverMessages.length
    const restoredMessages = useLocal ? localMessages : serverMessages
    if (useLocal) {
      console.warn(
        '[InterviewSession] Restoring messages from localStorage backup',
        { local: localMessages.length, server: serverMessages.length, interviewId },
      )
      setSaveStatus('recovered')
      // Push the recovered state back to the server so subsequent loads
      // don't need the local backup.
      if (user?.id) {
        saveMessages(
          interviewId,
          {
            messages: restoredMessages,
            session_state: { messages: restoredMessages, paused_at: new Date().toISOString() },
          },
        )
      }
    }
    setMessages(restoredMessages)

    const hasCompleteToken = restoredMessages.some((m) => m.content?.includes(COMPLETE_TOKEN))
    // wrapHint covers the realtime-End path where the final PATCH may have
    // failed before COMPLETE_TOKEN landed. As long as the realtime call
    // produced at least one assistant turn we treat the conversation as
    // complete and let the blog-gen effect take over.
    // Gate on from=realtime so a bookmarked or shared URL containing ?wrap=1
    // can't skip straight to blog generation for non-realtime interviews.
    const fromRealtime = searchParams.get('from') === 'realtime'
    const wrapFromRealtime = wrapHint && fromRealtime && restoredMessages.some((m) => m.role === 'assistant')
    if (hasCompleteToken || wrapFromRealtime) {
      setInterviewComplete(true)
    }
    if (wrapFromRealtime) setFromRealtimeWrap(true)
    if (restoredMessages.length > 0) {
      // Resuming an existing interview — skip instructions and mic check
      setShowInstructions(false)
      setMicCheckPassed(true)
      // Restore an in-flight answer the user was typing but hadn't sent (Gap B),
      // unless the interview already wrapped. Only the typed dock renders it; voice
      // users don't type, so this is empty for them.
      if (!hasCompleteToken && !wrapFromRealtime) {
        const savedDraft = loadDraft(interviewId)
        if (savedDraft) setTypedAnswer(savedDraft)
      }
      // Show a brief "Resuming…" banner if we're restoring saved state
      if (savedState?.messages?.length) {
        setShowResumeBanner(true)
        setTimeout(() => setShowResumeBanner(false), 1500)
      }
    }

    // These three are AI prompt-context enrichments. Each one failing
    // degrades the AI's history awareness but does not block the interview,
    // so they stay non-fatal. We DO log so prod issues are visible in
    // vercel logs — a previously-silent .catch(() => {}) hid the fact
    // that these can fail at all.
    fetchSimilarInterviews(interviewData.topic, interviewId)
      .then((past) => { pastInterviewsRef.current = past || [] })
      .catch((err) => console.warn('[InterviewSession] fetchSimilarInterviews failed', err?.status, err?.message))

    // Fetch learned practice knowledge for this topic — injected into every
    // system prompt for this session. Fails silently (empty block = graceful noop).
    const staffParam = staffId ? `&staff_id=${encodeURIComponent(staffId)}` : ''
    apiFetch(`/api/concepts/context?topic=${encodeURIComponent(interviewData.topic || '')}${staffParam}`)
      .then((data) => {
        const { block, agreementBlock, gapBlock } = /** @type {{ block?: string, agreementBlock?: string, gapBlock?: string }} */ (data || {})
        conceptBlockRef.current   = block          || ''
        agreementBlockRef.current = agreementBlock || ''
        gapBlockRef.current       = gapBlock       || ''
      })
      .catch((err) => console.warn('[InterviewSession] concepts/context failed', err?.status, err?.message))

    // Phase 5 Feature 2 (PR 1) — hot practice-memory context: this clinician's
    // own prior interviews + recently approved/published content. Injected
    // into the system prompt so the model can reference what they've already
    // said and build on it instead of starting cold. The block is bounded
    // (3 interviews × 4 user turns; 3 content pieces × 500 chars) so prompt
    // size stays predictable as the clinician's corpus grows.
    //
    // Falls back silently when there's no signal. A later PR replaces the
    // recency-based pick with embedding-based RAG.
    Promise.all([
      fetchStaffMember(staffId).catch(() => null),
      fetchStaffMemberRecentContent(staffId, 3).catch(() => []),
    ])
      .then(([staffRow, recentContent]) => {
        const priorInterviews = pickPriorInterviews(staffRow?.interviews || [], interviewId)
        ownHistoryBlockRef.current = buildOwnHistoryBlock({
          staffName: staffRow?.name || 'this clinician',
          priorInterviews,
          priorContent: Array.isArray(recentContent) ? recentContent : [],
        })
        styleMemoryBlockRef.current = buildStyleMemoryBlock({
          staffName: staffRow?.name,
          styleMemory: staffRow?.interview_style_memory,
        })
      })
      .catch((err) => console.warn('[InterviewSession] practice-memory fetch failed', err?.status, err?.message))
    // `saveMessages` is a stable scope-level helper; `user.id` doesn't change
    // mid-session (the auth-gated route remounts on user change). Listing
    // them would re-fire this seeding effect and clobber in-progress state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewLoading, interviewData, interviewId, navigate, staffId])

  // Resolve the bound campaign goal (newsletter flow) into the steering block
  // injected into each interview turn. Non-reactive refs so the live turn
  // handler (sendToAI) reads the latest without re-rendering. No-ops to empty
  // when there's no campaign_id — a regular interview is unaffected.
  useEffect(() => {
    if (!interview?.campaign_id || !staffMember) {
      goalBlockRef.current = ''
      campaignRef.current = null
      return
    }
    const campaign = campaignsList.find((c) => c.id === interview.campaign_id)
    if (!campaign) return
    campaignRef.current = campaign
    goalBlockRef.current = buildCampaignGoalBlock(
      campaign,
      staffMember.name,
      runtimeWorkspace?.display_name || workspace?.display_name,
    )
  }, [interview?.campaign_id, campaignsList, staffMember, runtimeWorkspace])

  // Newest content renders at the top; keep the view pinned there so the
  // latest question/answer stays visible and older turns scroll off below.
  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [messages, streamingText])

  useEffect(() => {
    return () => {
      ttsRef.current?.cancel()
      window.speechSynthesis?.cancel()
      userAnswerActiveRef.current = false
      clearTimeout(restartTimerRef.current)
      recognitionRef.current?.abort()
    }
  }, [])

  // Unmount guard — prevents setState calls after navigation during 60-120s generation.
  useEffect(() => () => { mountedRef.current = false }, [])

  // Release the mic the moment the interview ends. Without this, the
  // SpeechRecognition session can linger and the browser tab keeps the
  // recording indicator (red dot) lit even though there's nothing to capture.
  useEffect(() => {
    if (!interviewComplete) return
    userAnswerActiveRef.current = false
    clearTimeout(restartTimerRef.current)
    recognitionRef.current?.abort()
  }, [interviewComplete])

  // Subscribe to global audio-playback failures (iOS route change, BT
  // disconnect, audio session interruption). When one fires we surface a
  // recovery button rather than letting the interview proceed silently.
  useEffect(() => {
    const unsubscribe = onAudioPlaybackFailure(() => setAudioInterrupted(true))
    return unsubscribe
  }, [])

  function speak(text) {
    setIsSpeaking(true)
    // Per-clinician TTS preferences live on clinicians.tts_settings (JSONB).
    // Today only `speed` is exposed in the UI; voiceId is reserved for a
    // future per-clinician voice picker. Falls through to env-var defaults
    // server-side when these are undefined.
    const tts = staffMember?.tts_settings || {}
    getTts().speak(text, {
      voiceId: tts.voice_id || undefined,
      speed: typeof tts.speed === 'number' ? tts.speed : undefined,
      onStart: () => setIsSpeaking(true),
      onEnd: () => {
        setIsSpeaking(false)
        autoListenRef.current = true
      },
      onError: () => setIsSpeaking(false),
    })
  }

  // Called from inside the user-gesture "Restore audio" click handler.
  // Rebuilds a primed <audio> element and re-speaks the most recent
  // assistant message so the user catches up on what they missed.
  function handleRestoreAudio() {
    primeAudioPlayback()
    setAudioInterrupted(false)
    const lastAssistant = [...messagesRef.current].reverse().find((m) => m.role === 'assistant')
    if (lastAssistant && !interviewComplete) {
      speak(stripGapToken(stripAgreementToken(stripContrastToken(lastAssistant.content))))
    }
  }

  useEffect(() => {
    // Skip auto-listen on browsers without SpeechRecognition (iOS Safari etc.) —
    // the typed-answer fallback UI is shown instead.
    if (!hasSpeechRecognition) return
    if (!isSpeaking && autoListenRef.current && !isStreaming && !interviewComplete) {
      autoListenRef.current = false
      // 700ms gives iOS more time to release the audio session from TTS
      // playback before the mic engine tries to claim it — at 400ms iOS
      // Chrome was throwing 'aborted' regularly.
      const timer = setTimeout(() => startListening(), 700)
      return () => clearTimeout(timer)
    }
    // `startListening` is a stable function defined in this component scope.
    // Including it as a dep would re-fire the effect on every render and is
    // unnecessary — the auto-listen trigger only depends on the three flags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpeaking, isStreaming, interviewComplete])

  const sendToAI = useCallback(async (currentMessages) => {
    if (!staffMember || !interviewRef.current) return
    // Remember the turn so the inline "Try again" button can re-run it in place
    // (without a full page reload) after a transient failure.
    lastTurnRef.current = { currentMessages }
    setIsStreaming(true)
    setStreamingText('')
    setError('')

    const liveWorkspace = runtimeWorkspaceRef.current
    const interviewLocation = (liveWorkspace?.locations || []).find(
      l => l.id === interviewRef.current?.location_id
    )
    const overlaidWorkspace = applyLocationOverlay(liveWorkspace, interviewLocation)

    // First message = AI introduces itself; subsequent = skip intro
    const isFirstMessage = currentMessages.length === 0 ||
      (currentMessages.length === 1 && currentMessages[0].role === 'user' && currentMessages[0].content === 'Please begin the interview.')

    // Detect shallow previous answer for re-probe instruction
    const userMessages = currentMessages.filter((m) => m.role === 'user')
    const lastUserIdx = userMessages.length - 1
    const lastUserMsg = userMessages[lastUserIdx]
    const shouldReprobe = lastUserMsg &&
      isShallowAnswer(lastUserMsg.content) &&
      !reprobedIndexesRef.current.has(lastUserIdx)
    if (shouldReprobe) reprobedIndexesRef.current.add(lastUserIdx)

    // "Make a point" interviews (kind='point') run the dynamic podcast-host
    // interviewer, seeded with the user's own point. Everything else — the
    // clinical extraction prompt and its RAG blocks — stays byte-identical.
    const baseSystemPrompt = interviewRef.current?.kind === 'point'
      ? getPointInterviewSystemPrompt(
          overlaidWorkspace,
          staffMember.name,
          interviewRef.current.point,
          pastInterviewsRef.current,
          { isFirstMessage },
        )
      : getInterviewSystemPrompt(
      overlaidWorkspace,
      staffMember.name,
      interviewRef.current.topic,
      pastInterviewsRef.current,
      interviewRef.current?.prototype_id,
      {
        tone: interviewRef.current?.tone || 'smart',
        isFirstMessage,
        shallowReprobe: shouldReprobe,
        ownHistoryBlock: ownHistoryBlockRef.current,
        styleMemoryBlock: styleMemoryBlockRef.current,
        goalBlock: goalBlockRef.current,
        conceptBlock:   conceptBlockRef.current,
        agreementBlock: agreementBlockRef.current,
        gapBlock:       gapBlockRef.current,
        audienceSlot:   resolveAudienceSlot(interviewRef.current?.audience, overlaidWorkspace?.audience_options),
        storyTypeSlot:  resolveStoryTypeSlot(interviewRef.current?.story_type, overlaidWorkspace?.story_type_options),
        // Team-as-talent (Phase 1.5): branch to non-clinical staff prompt when applicable.
        // Default 'clinician' keeps existing behavior byte-identical.
        staffType:      staffMember?.staff_type || 'clinician',
      }
    )

    // Append per-exchange emotional context if detected, then clear the ref
    // so it doesn't bleed into subsequent turns.
    const emotionInjection = getEmotionPromptInjection(emotionStateRef.current)
    emotionStateRef.current = null
    const systemPrompt = emotionInjection ? baseSystemPrompt + emotionInjection : baseSystemPrompt

    // Strip [CONTRAST] tokens from messages before sending to API
    // (the token is for our UI layer, not for the model to see in history)
    let apiMessages = currentMessages.map((m) => ({
      role: m.role,
      content: m.role === 'assistant' ? stripGapToken(stripAgreementToken(stripContrastToken(m.content))) : m.content,
    }))
    // Cap the history window for interview turns. Full history is kept in state
    // for display; only the last 20 messages (≈ 10 exchanges) go to the API to
    // prevent unbounded payload growth on very long sessions. The system prompt
    // already carries the topic and persona context, so the recent window is
    // sufficient for continuity without risking a 413 or cost runaway.
    if (apiMessages.length > 20) {
      apiMessages = apiMessages.slice(-20)
      // Ensure the trimmed window doesn't open with a user message following
      // an implied assistant turn — if the slice starts on an assistant turn it
      // means we cut right after a user answer, which is fine for the model.
    }
    // Claude API requires at least one message — inject a silent starter for new interviews
    if (apiMessages.length === 0) {
      apiMessages = [{ role: 'user', content: 'Please begin the interview.' }]
    }

    // The gateway→Anthropic upstream occasionally blips mid-stream — the AI SDK
    // surfaces it as an error part that our /api/stream handler writes into the
    // (already-200) SSE body, and the client throws "A network error occurred".
    // That is NOT the user's network. A single transient blip should never end
    // the interview turn, so auto-retry the whole turn a couple of times before
    // surfacing the error. Auth/rate-limit errors (4xx) are not retried.
    let fullText = ''
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fullText = ''
      try {
        for await (const chunk of streamMessage(apiMessages, systemPrompt)) {
          fullText += chunk
          setStreamingText(fullText)
        }
        break // success
      } catch (err) {
        const status = err?.status
        const retriable = isTransientStreamError(err)
        if (retriable && attempt < MAX_ATTEMPTS) {
          // Exponential-ish backoff: 600ms, 1500ms. Reset the partial buffer.
          setStreamingText('')
          await new Promise((r) => { setTimeout(r, attempt === 1 ? 600 : 1500) })
          continue
        }
        setIsStreaming(false)
        setStreamingText('')
        setError(
          retriable
            ? 'The interviewer lost connection for a moment. Tap "Try again" to continue — your answers are saved.'
            : `Error: ${err.message}`,
        )
        // 4xx auth errors won't recover on retry; surface a clearer message.
        if (status === 401 || status === 403) setError(err?.message || 'Session expired — reload to continue.')
        return
      }
    }

    const isComplete = fullText.includes(COMPLETE_TOKEN)
    // Strip COMPLETE_TOKEN but preserve [CONTRAST] in stored message for UI detection
    const cleanText = fullText.replace(COMPLETE_TOKEN, '').trim()

    const aiMessage = { role: 'assistant', content: cleanText }
    const updated = [...currentMessages, aiMessage]
    setMessages(updated)

    if (user?.id) {
      const patch = { messages: updated }
      // Clear session_state when the AI signals completion — the interview
      // is done and the resume banner should not appear on next visit.
      // NOTE: do NOT write status here. Status transitions to 'completed' only
      // via the updateInterview call after blog generation (~60-120s later).
      // Writing 'in_progress' here was wrong (same value it already has) and
      // created a race where the fire-and-forget saveMessages could overwrite
      // the 'completed' status set by the generation PATCH.
      if (isComplete) {
        patch.session_state = null
        patch.paused_at = null
        // Cancel the pending debounced autosave BEFORE dispatching the finalizing
        // PATCH so it can't race the session_state null-out (last-writer-wins).
        clearTimeout(sessionSaveTimerRef.current)
        sessionSaveTimerRef.current = null
      }
      saveMessages(interviewId, patch)
      // Once the AI declares the interview complete, the local backup has
      // served its purpose. Drop it so a future load doesn't accidentally
      // re-hydrate stale messages.
      if (isComplete) { clearLocalMessages(interviewId); clearDraft(interviewId) }
    }

    if (isComplete) {
      setInterviewComplete(true)
      posthogCapture('interview_completed', { interviewId })
    }
    setStreamingText('')
    setIsStreaming(false)

    // Speak the clean version (without probe tokens)
    if (!isComplete) speak(stripGapToken(stripAgreementToken(stripContrastToken(cleanText))))
    // `runtimeWorkspace` is read through `runtimeWorkspaceRef` (synced above) so
    // sendToAI always sees the latest workspace/locations without listing it as
    // a dep — listing it would defeat useCallback (a react-query refetch returns
    // a new workspace object identity, re-creating sendToAI constantly and
    // re-triggering every effect that depends on it). `saveMessages` and `speak`
    // are unmemoized helpers re-created each render; same reasoning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffMember, interviewId, user?.id])

  useEffect(() => {
    if (!staffMember || !interview || hasStarted.current || showInstructions || !micCheckPassed) return
    hasStarted.current = true
    // Start recording the clinician's mic for voice clone training.
    // Non-blocking + non-fatal — interview continues even if capture fails.
    // Pass interviewId so a killed take is recoverable + re-uploadable (P3).
    startCapture(interviewId)
    if (messages.length === 0) {
      sendToAI([])
    } else {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
      if (lastAssistant && !interviewComplete) speak(lastAssistant.content)
    }
    // Intentional one-shot kickoff effect. hasStarted.current guards against
    // re-entry — listing `messages`, `interviewComplete`, `sendToAI`, or
    // `speak` here would either re-trigger on every message (after the
    // hasStarted guard, harmless but wasteful) or fight the guard pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffMember, interview, showInstructions, micCheckPassed])

  // Recover a voice-clone take that was persisted to IndexedDB but never finished
  // uploading because the tab was killed/backgrounded mid-interview (P3). The audio
  // is a background training asset (not user-facing content — the transcript is
  // protected separately), so this re-uploads silently with no recovery card.
  // One-shot per interview, owner only (recoveredOrphanRef is declared up top so
  // it resets on interview-id change). recoverOrphanedAudio skips the live session
  // and only touches takes tagged with this interview id.
  useEffect(() => {
    if (recoveredOrphanRef.current) return
    if (!interviewId || !user?.id || !interview) return
    if (user.id !== interview.owner_id) return
    recoveredOrphanRef.current = true
    recoverOrphanedAudio(interviewId).catch(() => {})
    // recoverOrphanedAudio is stable (useCallback []); one-shot via the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewId, user?.id, interview])

  // Waveform visualization via Web Audio.
  // Opens a parallel getUserMedia stream for level visualization. Falls back
  // to a sine-wave idle animation if getUserMedia is unavailable or denied —
  // the waveform always breathes, never looks frozen.
  useEffect(() => {
    if (!hasSpeechRecognition || !isListening) {
      cancelAnimationFrame(animFrameRef.current)
      if (vizStreamRef.current) {
        vizStreamRef.current.getTracks().forEach(t => t.stop())
        vizStreamRef.current = null
      }
      if (vizCtxRef.current) {
        vizCtxRef.current.close().catch(() => {})
        vizCtxRef.current = null
      }
      analyserRef.current = null
      if (waveformRef.current) {
        Array.from(waveformRef.current.children).forEach(bar => {
          bar.style.transform = ''
        })
      }
      return
    }

    // Start RAF immediately — sine fallback runs until getUserMedia resolves.
    let rafId
    function draw() {
      rafId = requestAnimationFrame(draw)
      animFrameRef.current = rafId
      const bars = waveformRef.current ? Array.from(waveformRef.current.children) : []
      if (!bars.length) return
      if (analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.frequencyBinCount)
        analyserRef.current.getByteFrequencyData(data)
        bars.forEach((bar, i) => {
          const idx = Math.floor((i / bars.length) * data.length)
          const val = data[idx] / 255
          bar.style.transform = `scaleY(${Math.max(0.12, val * 0.9 + 0.08)})`
        })
      } else {
        // Idle breathing — visibly alive during silence and getUserMedia setup
        const t = Date.now() / 1000
        bars.forEach((bar, i) => {
          const s = 0.14 + 0.28 * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.48))
          bar.style.transform = `scaleY(${s})`
        })
      }
    }
    draw()

    let active = true
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        if (!active) { stream.getTracks().forEach(t => t.stop()); return }
        vizStreamRef.current = stream
        const ctx = new AudioContext()
        vizCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 64
        source.connect(analyser)
        analyserRef.current = analyser
      } catch {
        // getUserMedia denied or unavailable — sine idle continues
      }
    })()

    return () => {
      active = false
      cancelAnimationFrame(rafId)
    }
  }, [hasSpeechRecognition, isListening])

  function startListening({ preserveTranscript = false } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      // No-op: the typed-answer fallback UI is rendered instead. Don't set an
      // error — that would push iOS users into a dead-end state.
      return
    }
    if (isListening) return

    ttsRef.current?.cancel()
    window.speechSynthesis?.cancel()
    setIsSpeaking(false)

    // Fresh turn: clear the transcript buffer and reset the restart counter.
    // For an auto-resume restart (browser ended the session during a thinking
    // pause), preserve everything the user has already said.
    if (!preserveTranscript) {
      setTranscript('')
      transcriptRef.current = ''
      finalTranscriptRef.current = ''
      restartCountRef.current = 0
      userAnswerActiveRef.current = true
    }

    const recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      let gotFinal = false
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscriptRef.current += event.results[i][0].transcript + ' '
          gotFinal = true
        }
      }
      const interim = event.results[event.results.length - 1].isFinal
        ? ''
        : event.results[event.results.length - 1][0].transcript
      const display = (finalTranscriptRef.current + interim).trim()
      setTranscript(display)
      transcriptRef.current = finalTranscriptRef.current.trim()

      if (gotFinal) {
        const cleaned = detectAndStripStopPhrase(finalTranscriptRef.current)
        if (cleaned !== null) {
          // Stop phrase detected — end the answer turn so onend doesn't
          // auto-resume after we call stop().
          userAnswerActiveRef.current = false
          clearTimeout(restartTimerRef.current)
          finalTranscriptRef.current = cleaned
          transcriptRef.current = cleaned.trim()
          setTranscript(cleaned.trim())
          recognitionRef.current?.stop()
        }
      }
    }

    // Helper: schedule a silent restart of the recognition engine so the
    // user can keep their turn through a thinking pause. Returns true if a
    // restart was scheduled, false if we've hit the cap or the user is no
    // longer in their answer turn.
    function maybeAutoResume(delayMs) {
      if (!userAnswerActiveRef.current) return false
      if (interviewComplete || isStreaming) return false
      if (restartCountRef.current >= RESTART_CAP) {
        userAnswerActiveRef.current = false
        return false
      }
      restartCountRef.current += 1
      clearTimeout(restartTimerRef.current)
      restartTimerRef.current = setTimeout(() => {
        if (userAnswerActiveRef.current && !interviewComplete) {
          startListening({ preserveTranscript: true })
        }
      }, delayMs)
      return true
    }

    recognition.onend = () => {
      // If the user is still in their answer turn (no stop phrase, no manual
      // stop, no submit), silently restart to ride through a thinking pause.
      // Otherwise let isListening flip false so the submit effect can fire.
      if (maybeAutoResume(200)) return
      setIsListening(false)
    }

    recognition.onerror = (e) => {
      // 'no-speech' is the canonical "user paused too long" signal. Treat
      // it as a thinking pause and resume silently.
      if (e.error === 'no-speech') {
        if (maybeAutoResume(200)) return
        setIsListening(false)
        return
      }

      // 'aborted' on iOS Chrome usually means the audio session is still
      // tied up with TTS playback that just ended. Retry once with a longer
      // delay; this is independent of the answer-turn auto-resume.
      if (e.error === 'aborted') {
        setIsListening(false)
        if (autoListenAbortRetryRef.current < 1 &&
            !interviewComplete && !isStreaming && !isSpeaking) {
          autoListenAbortRetryRef.current += 1
          setTimeout(() => {
            if (!interviewComplete && !isListening) startListening()
          }, 1500)
        }
        return
      }

      // Permission errors — flag explicitly, end the answer turn.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        userAnswerActiveRef.current = false
        setIsListening(false)
        setError('Microphone permission was denied. You can type your answer instead.')
        return
      }

      // Other errors — non-blocking message, end the answer turn so the
      // user can retry.
      userAnswerActiveRef.current = false
      setIsListening(false)
      setError(`Microphone trouble (${e.error}). Tap mic to retry or type your answer instead.`)
    }

    recognitionRef.current = recognition
    try {
      recognition.start()
      setIsListening(true)
      // Clear retry counter on a clean start — only consecutive aborts count.
      autoListenAbortRetryRef.current = 0
    } catch {
      // start() throws synchronously if the engine is in a bad state (e.g.
      // already started, or audio session locked). Treat as a soft failure
      // and let the user tap mic to try again.
      setIsListening(false)
    }
  }

  function stopListening() {
    // Explicit stop — end the answer turn so onend doesn't auto-resume.
    userAnswerActiveRef.current = false
    clearTimeout(restartTimerRef.current)
    recognitionRef.current?.stop()
  }

  // Shared submit path for both voice (auto-fires when isListening flips
  // false with text captured) and typed-answer (Send button on iOS/non-SR
  // browsers). Extracted so the typed path runs the same emotion-detect +
  // save + sendToAI sequence as voice.
  function submitUserText(rawText) {
    const text = (rawText || '').trim()
    if (!text) return

    setTranscript('')
    transcriptRef.current = ''
    setTypedAnswer('')
    clearDraft(interviewId) // answer submitted — drop the saved in-flight draft

    const userMessage = { role: 'user', content: text }
    const updated = [...messagesRef.current, userMessage]
    setMessages(updated)

    const recentUserMessages = updated
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content)
    emotionStateRef.current = detectEmotionalState(recentUserMessages)

    if (user?.id) {
      saveMessages(interviewId, { messages: updated })
    }

    sendToAI(updated)
  }

  useEffect(() => {
    if (isListening) return
    if (!transcriptRef.current.trim()) return
    submitUserText(transcriptRef.current)
    // `submitUserText` is a stable scope-level helper. `saveMessages` and
    // `user.id` likewise — listing them would re-create the effect on every
    // render and churn downstream consumers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isListening, interviewId, sendToAI])

  // Pause = leave the interview mid-flight. Conversation auto-saves on every
  // user turn, so leaving doesn't actually lose the captured Q&A — but it
  // does drop the user out of an active mic/utterance/stream cycle. Confirm
  // if any of those are live; otherwise leave immediately so the common case
  // (paused for a moment, then leaving) stays one click.
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false)

  function leaveInterview() {
    ttsRef.current?.cancel()
    window.speechSynthesis?.cancel()
    userAnswerActiveRef.current = false
    clearTimeout(restartTimerRef.current)
    recognitionRef.current?.abort()
    // Flush session_state immediately before leaving so resume works
    // even if the debounced auto-save hasn't fired yet.
    clearTimeout(sessionSaveTimerRef.current)
    if (user?.id && !interviewComplete && messagesRef.current.length > 0) {
      // Mirror locally before navigating away so a failed pause save can be
      // recovered on next load.
      saveLocalMessages(interviewId, messagesRef.current)
      updateInterview(
        interviewId,
        { session_state: buildSessionState(messagesRef.current), paused_at: new Date().toISOString() },
      ).catch((err) => {
        console.error('[InterviewSession] pause save failed', err?.status, err?.message)
      })
    }
    navigate('/')
  }

  // Back returns to wherever the user came from (Home → New → Interview, or
  // the staff profile) via the shared useSmartBack hook; falls back to Home
  // for direct-link entries with no in-app history.
  const handleBack = useSmartBack('/')

  // Verbatim flag helpers. The transcript-substring check guarantees flagged
  // text is something the clinician actually said — selecting an assistant
  // question or a sentence that spans multiple bubbles fails validation and
  // the tip never appears. We intentionally only consider user-role
  // messages so the verbatim guarantee in the prompt is honest.
  function getUserTranscript() {
    return (messagesRef.current || [])
      .filter((m) => m.role === 'user')
      .map((m) => m.content || '')
      .join('\n\n')
  }

  function handleSelectionUp() {
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed) { setSelectionTip(null); return }
    const text = sel.toString().trim()
    if (text.length < 10) { setSelectionTip(null); return }
    if (!conversationRef.current) return
    // Selection must be entirely inside the conversation log.
    const range = sel.getRangeAt(0)
    if (!conversationRef.current.contains(range.commonAncestorContainer)) {
      setSelectionTip(null); return
    }
    if (!getUserTranscript().includes(text)) { setSelectionTip(null); return }
    const rect = range.getBoundingClientRect()
    const containerRect = conversationRef.current.getBoundingClientRect()
    setSelectionTip({
      text,
      top: rect.top - containerRect.top - 36,
      left: rect.left - containerRect.left + rect.width / 2,
    })
  }

  async function addVerbatimFlag() {
    if (!selectionTip?.text || !interview) return
    const text = selectionTip.text
    const transcript = getUserTranscript()
    const idx = transcript.indexOf(text)
    if (idx === -1) { setSelectionTip(null); return }
    const existing = Array.isArray(interview.verbatim_flags) ? interview.verbatim_flags : []
    if (existing.some((f) => f.text === text)) { setSelectionTip(null); return }
    const next = [
      ...existing,
      {
        id: crypto.randomUUID(),
        text,
        start_offset: idx,
        end_offset: idx + text.length,
        created_at: new Date().toISOString(),
      },
    ]
    setInterview((prev) => prev ? { ...prev, verbatim_flags: next } : prev)
    setSelectionTip(null)
    window.getSelection?.()?.removeAllRanges()
    try {
      await updateInterview(interviewId, { verbatimFlags: next })
    } catch {
      setError('Could not save verbatim flag — try again.')
    }
  }

  async function removeVerbatimFlag(id) {
    if (!interview) return
    const existing = Array.isArray(interview.verbatim_flags) ? interview.verbatim_flags : []
    const next = existing.filter((f) => f.id !== id)
    setInterview((prev) => prev ? { ...prev, verbatim_flags: next } : prev)
    try {
      await updateInterview(interviewId, { verbatimFlags: next })
    } catch {
      setError('Could not remove verbatim flag — try again.')
    }
  }

  function handlePause() {
    const inFlight = isListening || isSpeaking || isStreaming || transcriptRef.current?.trim()
    if (inFlight) {
      setPauseConfirmOpen(true)
      return
    }
    leaveInterview()
  }

  // Progress % for the "Writing blog post…" card. Animates 0→95% over ~90s
  // (exponential ease) and resets to 0 when generation ends. The user never
  // sees 100% because navigation fires on completion.
  const blogStreamingTextRef = useRef('')
  const [genProgress, setGenProgress] = useState(0)

  // Completion card — the finish screen. Rests on a primary "See your story →"
  // handoff; the user controls when to leave (no auto-nav).
  const [completionData, setCompletionData] = useState(null)
  // True when handleGenerateContent's catch fires — shows a dedicated recovery
  // card instead of leaving the user in a silent dead-end.
  const [generationError, setGenerationError] = useState(false)
  // Optional video-attach prompt, opened from the completion card's optional
  // link. No longer an auto-advancing gate on the finish screen.
  const [showVideoPrompt, setShowVideoPrompt] = useState(false)

  useEffect(() => {
    if (!isGenerating) {
      setGenProgress(0)
      return
    }
    const startTime = Date.now()
    const id = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000
      setGenProgress(Math.min(95, Math.round(95 * (1 - Math.exp(-elapsed / 30)))))
    }, 500)
    return () => clearInterval(id)
  }, [isGenerating])

  // "What you covered" recap — a fast 3-line summary generated in parallel
  // with the blog draft. It finishes in a few seconds (the blog takes 60-120s),
  // so it fills the wait on the generation card with an immediate "the AI heard
  // me" moment, and is persisted into outputs.coveredSummary so it also shows on
  // Story Detail. Runs Haiku for speed; failure is non-fatal (blog is the
  // primary deliverable). Returns the recap string (or '' on failure).
  const [coveredSummary, setCoveredSummary] = useState('')
  async function generateCoveredSummary() {
    try {
      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }))
      const sys = getCoveredSummarySystemPrompt(staffMember.name, interview.topic)
      const seed = [...apiMessages, { role: 'user', content: 'Summarize what I covered, in 3 lines.' }]
      let acc = ''
      for await (const delta of streamMessage(seed, sys, { model: 'claude-haiku-4-5', maxOutputTokens: 300 })) {
        if (!mountedRef.current) return ''
        acc += delta
        setCoveredSummary(acc)
      }
      if (!mountedRef.current) return ''
      const finalSummary = acc.trim()
      setCoveredSummary(finalSummary)
      return finalSummary
    } catch (e) {
      console.warn('[interview] covered-summary generation failed (non-fatal):', e?.message)
      return ''
    }
  }

  async function handleGenerateContent() {
    setIsGenerating(true)
    setError('')
    setGenerationError(false)
    blogStreamingTextRef.current = ''
    setCoveredSummary('')
    ttsRef.current?.cancel()
    window.speechSynthesis?.cancel()
    // Kick off the "what you covered" recap in parallel — it lands in a few
    // seconds and fills the generation wait. We await its promise just before
    // the outputs PATCH (by then it's long done) so it persists with the blog.
    const summaryPromise = generateCoveredSummary()
    // Kick off the transcript cleanup pass in parallel with the blog draft.
    // It writes cleaned_messages on the interview row independently, so
    // failure is non-fatal — the editor falls back to the raw transcript on
    // the Output page. We don't await: the blog generator uses the raw
    // messages by design (cleanup is a verification tool, not a rewrite).
    cleanupTranscript(interviewId).catch((e) => {
      console.warn('[interview] transcript cleanup failed:', e?.message)
    })
    try {
      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }))
      const tone = interview.tone || 'smart'
      const voiceMode = interview.voice_mode || 'practice'
      const interviewLocation = (runtimeWorkspace?.locations || []).find(l => l.id === interview.location_id)
      const overlaidWorkspace = applyLocationOverlay(runtimeWorkspace, interviewLocation)

      // Stream the blog generation into blogStreamingTextRef. The
      // server-side /api/stream endpoint SSEs Anthropic-shaped deltas
      // (see src/lib/claude.js#streamMessage); progress is shown via the
      // time-seeded genProgress bar, not a token count.
      // Persist style change if the user changed it since the interview loaded.
      // If the save fails, log + flip the visible save indicator. The
      // user's selection still drives this generation; the persistence
      // just won't survive a reload, so a recoverable warning is the right
      // posture rather than blocking generation.
      if (generationStyle !== (interview.generation_style || 'blog_post')) {
        updateInterview(interviewId, { generationStyle }).catch((err) => {
          console.error('[InterviewSession] generationStyle save failed', err?.status, err?.message)
          setSaveStatus('error')
        })
      }

      // Top voice phrase anchors (Phase C.2). One light fetch right before
      // generation; falls back to [] on any failure so a flaky endpoint can't
      // block the blog draft.
      let voicePhrases = []
      try {
        const vp = await apiFetch(
          `/api/staff/voice-phrases?staff_id=${staffMember.id}&limit=8`
        )
        voicePhrases = Array.isArray(vp?.phrases) ? vp.phrases : []
      } catch (e) {
        console.warn('[interview] voice phrase fetch failed:', e?.message)
      }

      // Goal-steered newsletter interviews (selected_outputs=['email']) generate
      // an email draft via getNewsletterSystemPrompt instead of a blog. The
      // blog/minimal-edits ladder is unchanged for every other interview.
      const isNewsletter = Array.isArray(interview.selected_outputs) && interview.selected_outputs.includes('email')
      const isMinimal = !isNewsletter && generationStyle === 'minimal_edits'
      const isPoint = interview.kind === 'point'
      const systemPrompt = isNewsletter
        ? getNewsletterSystemPrompt(
            overlaidWorkspace, staffMember.name, interview.topic, voiceMode,
            staffMember.voice_notes || '',
            voicePhrases,
            campaignRef.current,
            ownHistoryBlockRef.current,
            isPoint,
          )
        : isMinimal
        ? getMinimalEditSystemPrompt(staffMember.name, voiceMode, staffMember.voice_notes || '', voicePhrases)
        : getBlogPostSystemPrompt(
            overlaidWorkspace, staffMember.name, interview.topic, tone, voiceMode, interview.prototype_id,
            staffMember.voice_notes || '',
            voicePhrases,
            resolveAudienceSlot(interview.audience, overlaidWorkspace?.audience_options),
            resolveStoryTypeSlot(interview.story_type, overlaidWorkspace?.story_type_options),
            null, // lengthPreset — not currently surfaced in the in-session generate flow
            ownHistoryBlockRef.current,
            isPoint,
          ) + buildVerbatimBlock(interview.verbatim_flags)

      const streamMessages = [
        ...apiMessages,
        {
          role: 'user',
          content: isNewsletter
            ? 'Please write the newsletter now based on our interview, using the exact section format.'
            : isMinimal
            ? 'Please clean up the transcript now using minimal edits only.'
            : 'Please write the blog post now based on our interview.',
        },
      ]

      for await (const delta of streamMessage(streamMessages, systemPrompt, { model: 'claude-opus-5', maxOutputTokens: 12_000 })) {
        blogStreamingTextRef.current += delta
      }

      // Separate the voice-fidelity provenance trailer from the visible
      // content body. The trailer (if present) is the model's per-paragraph
      // source attribution; the server validates it against the content +
      // transcript and falls back to algorithmic matching if validation fails.
      const { content: generated, provenanceJson } = extractProvenanceBlock(blogStreamingTextRef.current)
      if (!generated.trim()) throw new Error('No content returned from generation')

      // The recap started in parallel at the top; by now (after a 60-120s
      // stream) it's long resolved. Await defensively so it persists with the
      // draft. Non-fatal: '' if it failed.
      const recap = await summaryPromise.catch(() => '')
      // Newsletter interviews write outputs.emailNewsletter (→ platform='email'
      // content_item via the PATCH cascade); everything else writes blogPost.
      const outputs = isNewsletter
        ? { emailNewsletter: generated, generatedAt: new Date().toISOString() }
        : { blogPost: generated, generatedAt: new Date().toISOString() }
      if (recap) outputs.coveredSummary = recap
      // Clear session_state: completed interviews don't need resume capability.
      await updateInterview(interviewId, { outputs, status: 'completed', session_state: null, paused_at: null })
      posthogCapture('story_generated', { interviewId, type: isNewsletter ? 'email' : 'blog' })
      // The PATCH above triggers a server-side cascade in api/db/interviews.js
      // that creates the content_items rows. Flush caches so ContentHub /
      // Calendar pick those up on next read.
      qc.invalidateQueries({ queryKey: queryKeys.interviews.all })
      qc.invalidateQueries({ queryKey: queryKeys.staff.all })
      qc.invalidateQueries({ queryKey: queryKeys.contentItems.all })

      // Fire-and-forget: populate provenance on the new blog content_item.
      // Server validates trailer (if any) against content + transcript and
      // stores either `model_emit_validated` or `algorithmic_fallback`. The
      // UI does not wait for this — it lands within a second or two and
      // shows up on next Story Detail fetch.
      populateContentItemProvenance(interviewId, provenanceJson || '', isNewsletter ? 'email' : 'blog').catch((err) => {
        console.warn('[interview] provenance population failed:', err?.message)
      })
      // Fire-and-forget: run the two-pass voice-fidelity audit (PR 3) on the
      // new blog content_item. The server scores the draft against the
      // transcript + voice profile (+ practice memory for We-lane) and stores
      // voice_fidelity_score + voice_audit. The UI doesn't wait — Story Detail
      // shows the score/flags on next fetch once it lands.
      runVoiceAuditForInterview(interviewId, isNewsletter ? 'email' : 'blog').catch((err) => {
        // 401 here means Clerk session expired mid-interview. The auto-publish
        // gate treats voice_fidelity_score=null as "unscored — hold" so the
        // package won't ship without a score. User can re-trigger from Story Detail.
        const status = err?.status ?? err?.statusCode
        if (status === 401) {
          console.warn('[interview] voice audit skipped — session expired (401); package will hold until rescored')
        } else {
          console.warn('[interview] voice audit failed (non-fatal):', err?.message)
        }
      })
      // Phase 2b — same fire-and-forget shape, independent of the voice audit
      // above (a failure in one must never affect the other). Long-form point
      // content only; short-form atoms never get this check (see
      // pointSafetyAudit.js for why).
      if (isPoint) {
        runPointSafetyAuditForInterview(interviewId, isNewsletter ? 'email' : 'blog').catch((err) => {
          console.warn('[interview] point safety audit failed (non-fatal):', err?.message)
        })
      }
      // Stop mic recording + upload audio for voice clone training.
      // Fire-and-forget — resolve() fires before the upload completes so
      // we don't block the navigation. Any upload failure is silent.
      stopAndUpload(interviewId).catch((e) => {
        console.warn('[interview] audio upload failed (non-fatal):', e?.message)
      })

      // Generation done — show a brief completion card, then navigate.
      // voicePct is derived client-side from the provenance block (raw count of
      // verbatim + paraphrase paragraphs / total paragraphs). Server computes the
      // authoritative pct later; this is just a first impression for the card.
      const voicePct = deriveVoicePct(provenanceJson || '')
      if (!mountedRef.current) return
      setIsGenerating(false)
      setCompletionData({ voicePct, staffName: staffMember.name, topic: stripStoryDatePrefix(interview.topic), isNewsletter })
      // The completion card now rests here as the primary "See your story →"
      // handoff. Video attach is an optional link on that card, never an
      // auto-advancing gate — so no timer pushes the user into it.
    } catch (err) {
      if (!mountedRef.current) return
      setGenerationError(true)
      setError(`Failed to generate content: ${err.message}`)
      setIsGenerating(false)
    }
  }

  // Auto-fire generation the moment the interview wraps. The post-interview
  // radio ("Full blog post" vs "Minimal edits") was confusing — both labels
  // weren't parallel and forcing a decision at this moment broke the flow.
  // The user clicks Finish → "Writing your blog post…" card shows → on
  // completion we navigate to /stories/:id. Default style is 'blog_post'; the
  // draft view will host the optional Cleaned-transcript switcher.
  //
  // Guards: only fire when (a) the interview just completed in this session,
  // (b) no outputs exist yet (don't re-generate on revisits), (c) we're not
  // already generating, (d) the viewer owns the interview. autoGenFiredRef
  // pins it to one fire per mount so React's strict-mode double-effect doesn't
  // double-bill us.
  const autoGenFiredRef = useRef(false)
  useEffect(() => {
    if (!interviewComplete) return
    if (autoGenFiredRef.current) return
    if (isGenerating) return
    if (!interview || !staffMember || !user?.id) return
    if (interview.outputs?.blogPost || interview.outputs?.emailNewsletter) return
    if (user.id !== interview.owner_id) return
    autoGenFiredRef.current = true
    handleGenerateContent()
    // handleGenerateContent is a stable scope-level helper; including it would
    // re-fire the effect every render and double-bill the generation. The
    // guard ref above already pins this to a single invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewComplete, isGenerating, interview, staffMember, user?.id])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20" role="status">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" aria-hidden="true" />
        <span className="sr-only">Loading…</span>
      </div>
    )
  }

  if (interviewLoading || staffMemberLoading) return (
    <div className="flex items-center justify-center py-20" role="status">
      <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </div>
  )
  if (!staffMember || !interview) return null

  const isOwner = user?.id === interview.owner_id
  // Goal-steered newsletter interview — changes the generating/completion copy
  // and the post-generate chips/handoff to speak about the newsletter draft.
  const isNewsletterInterview = Array.isArray(interview.selected_outputs) && interview.selected_outputs.includes('email')

  if (showInstructions) {
    return (
      <div className="py-4">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="icon" onClick={handleBack} aria-label="Back">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <div>
            <p className="font-medium text-sm">{staffMember.name}</p>
            <p className="text-xs text-muted-foreground">{stripStoryDatePrefix(interview.topic)}</p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Before we begin</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Two things to know before the interview starts.
            </p>
          </div>

          <div className="space-y-3">
            <InstructionCard
              icon={<Mic2 className="h-5 w-5 text-primary" />}
              title="Speak naturally — the mic works like a conversation"
              body="The interviewer asks one question at a time, read aloud. Tap the microphone button when you're ready to answer, then speak at your normal pace. You can pause and think — it won't cut you off. When you're done with an answer, say 'done' or 'that's all', or tap the mic button again to send it."
            />
            <InstructionCard
              icon={<AlertCircle className="h-5 w-5 text-primary" />}
              title="You control when it ends"
              body="The interviewer will keep asking follow-up questions until you've covered the topic thoroughly — there's no fixed number of questions. When you feel you've said everything useful, just say so ('I think that covers it', 'that's everything', 'let's generate') or click the Finish button at the top. The AI does the rest."
            />
          </div>

          <Button
            className="w-full"
            size="lg"
            onClick={() => {
              // When the mic check ran in NewInterview, this "I'm ready" tap is
              // the last user gesture before the first TTS plays — prime audio
              // here so iOS audio-unlock (which decays out of gesture) is fresh.
              if (cameFromMicCheck) primeAudioPlayback()
              setShowInstructions(false)
            }}
          >
            <Mic className="h-4 w-4 mr-2" />
            I&apos;m ready &mdash; start the interview
          </Button>
        </div>
      </div>
    )
  }

  // Mic check gate: shown after instructions are dismissed but before the AI
  // sends its first question. onContinue flips micCheckPassed → true.
  if (!micCheckPassed) {
    return <MicCheck onContinue={() => setMicCheckPassed(true)} ttsSettings={staffMember?.tts_settings} />
  }

  const displayMessages = messages.filter((m) => !m.content?.includes(COMPLETE_TOKEN))
  const firstNameOnly = staffMember.name.split(' ')[0]
  // Require at least one back-and-forth before Finish: an opening prompt plus
  // one captured user answer isn't enough material for the AI to write from.
  const userMessageCount = messages.filter((m) => m.role === 'user').length
  const canFinish = userMessageCount >= 2
  const finishHelper = 'Answer at least one question before finishing.'

  const toneObj = TONES.find((t) => t.id === interview.tone) ?? TONES[0]
  const voiceObj = VOICE_MODES.find((v) => v.id === interview.voice_mode) ?? VOICE_MODES[0]
  const prototypeObj = interview.prototype_id
    ? PATIENT_PROTOTYPES_UI.find((p) => p.id === interview.prototype_id)
    : null

  return (
    <div
      className="flex flex-col h-[calc(100dvh-7.5rem)]"
      style={vvHeight ? { height: `calc(${vvHeight}px - 7.5rem)` } : undefined}
    >
      <div className="flex flex-col min-w-0 flex-1">
      <div className="flex items-center gap-3 pb-4 shrink-0">
        <Button variant="ghost" size="icon" onClick={handleBack} aria-label="Go back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
            {getInitials(staffMember.name)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm leading-none">{staffMember.name}</p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate" title={stripStoryDatePrefix(interview.topic)}>{stripStoryDatePrefix(interview.topic)}</p>
        </div>
        {saveStatus && (
          saveStatus === 'error'
            ? <span className="text-xs shrink-0 inline-flex items-center gap-1 text-destructive font-medium">
                <AlertTriangle className="h-3 w-3" />Save failed — your progress may not be saved
              </span>
            : <span
                role="status"
                className="text-xs shrink-0 inline-flex items-center gap-1 text-muted-foreground"
              >
                {saveStatus === 'saving'
                  ? <><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />Saving…</>
                  : saveStatus === 'saved'
                  ? <><Check aria-hidden="true" className="h-3 w-3" />Saved</>
                  : <><RefreshCw aria-hidden="true" className="h-3 w-3" />Saved to this device</>
                }
              </span>
        )}
        {interviewComplete
          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary"><CheckCircle2 className="h-4 w-4" />Interview complete</span>
          : isOwner && (
            // Desktop header keeps the action buttons. On mobile they live
            // in the bottom dock so they're within thumb reach next to the
            // mic — see InterviewDock below.
            <div className="hidden md:flex items-start gap-1 shrink-0">
              <div className="flex flex-col items-center">
                <Button
                  size="sm"
                  onClick={() => setInterviewComplete(true)}
                  disabled={!canFinish}
                  title={canFinish ? undefined : finishHelper}
                  aria-label={canFinish ? 'Finish interview' : finishHelper}
                  className="gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  Finish
                </Button>
                {!canFinish && (
                  <p className="text-xs text-muted-foreground mt-1 max-w-[10rem] text-center leading-tight">
                    {finishHelper}
                  </p>
                )}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handlePause}
                    aria-label="Save and pause interview — you can resume later"
                    className="gap-1 text-muted-foreground hover:text-foreground px-2"
                  >
                    <PauseCircle className="h-4 w-4" />
                    <span className="text-xs">Pause</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Save and pause — you can resume later</TooltipContent>
              </Tooltip>
            </div>
          )
        }
      </div>

      <div className="flex items-center gap-1.5 pb-3 -mt-1 shrink-0 flex-wrap">
        <Badge variant="outline" className="hidden sm:inline-flex text-xs gap-1 text-foreground/70">
          {toneObj.emoji} {toneObj.label}
        </Badge>
        <Badge variant="outline" className="hidden sm:inline-flex text-xs gap-1 text-foreground/70">
          {voiceObj.emoji} {voiceObj.label}
        </Badge>
        {prototypeObj && (
          <Badge variant="outline" className="hidden sm:inline-flex text-xs gap-1 text-foreground/70">
            {prototypeObj.emoji} {prototypeObj.label}
          </Badge>
        )}
        {/* Mobile: compact emoji-only summary so the row doesn't eat ~40px of viewport */}
        <span className="sm:hidden text-xs text-muted-foreground" aria-label={`Tone ${toneObj.label}, voice ${voiceObj.label}`}>
          {toneObj.emoji} {voiceObj.emoji}{prototypeObj ? ` ${prototypeObj.emoji}` : ''}
        </span>
        {!interviewComplete && userMessageCount > 0 && (
          <InterviewProgress count={userMessageCount} />
        )}
      </div>

      {showResumeBanner && (
        <div className="mb-2 rounded-lg bg-warning/10 border border-warning/30 px-4 py-2 text-xs text-warning flex items-center gap-2 shrink-0" role="status">
          <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse shrink-0" aria-hidden="true" />
          Resuming your session…
        </div>
      )}

      {saveStatus === 'error' && (
        <div className="mb-2 rounded-lg bg-warning/10 border border-warning/30 px-4 py-2.5 text-xs text-warning flex items-center gap-2 shrink-0" role="alert">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Server save failed — your answers are kept locally.</span>
          <button
            type="button"
            className="font-medium underline underline-offset-2 shrink-0"
            onClick={() => {
              if (user?.id) saveMessages(
                interviewId,
                { messages: messagesRef.current, session_state: buildSessionState(messagesRef.current) },
              )
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div
        ref={conversationRef}
        onMouseUp={handleSelectionUp}
        onTouchEnd={handleSelectionUp}
        className={`flex-1 relative pr-4 -mr-4 overflow-hidden ${isGenerating || completionData || generationError || fromRealtimeWrap ? 'hidden' : ''}`}
      >
        {selectionTip && (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); addVerbatimFlag() }}
            style={{
              top: Math.min(Math.max(0, selectionTip.top), (conversationRef.current?.clientHeight ?? 9999) - 40),
              left: selectionTip.left,
              transform: 'translateX(-50%)',
            }}
            className="absolute z-10 bg-foreground text-background text-xs rounded-md shadow-lg px-2.5 py-1.5 flex items-center gap-1.5 hover:bg-foreground/90"
          >
            <Quote className="h-3 w-3" />
            Use verbatim
          </button>
        )}
        <ScrollArea className="h-full pr-4 -mr-4">
          {/* Newest-first: latest turn renders at the top, older turns flow down. */}
          <div className="space-y-4 pb-4">
          <div ref={topRef} />

          {error && (
            <div className="flex items-center gap-3 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="flex-1 min-w-0">{error}</span>
              {lastTurnRef.current && !isStreaming && (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    const t = lastTurnRef.current
                    if (t) sendToAI(t.currentMessages)
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Try again
                </Button>
              )}
            </div>
          )}

          {isStreaming && streamingText && (
            <MessageBubble
              message={{ role: 'assistant', content: streamingText }}
              staffName={firstNameOnly}
              isStreaming
            />
          )}

          {isStreaming && !streamingText && (
            <div role="status" className="flex items-start gap-3">
              <span className="sr-only">Bernard is thinking…</span>
              <div className="h-8 w-8 rounded-full bg-card border border-border flex items-center justify-center shrink-0 p-1">
                <Loader2 aria-hidden="true" className="h-4 w-4 text-primary animate-spin" />
              </div>
              <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex gap-1 items-center h-5">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}

          {displayMessages.slice().reverse().map((msg, ri) => {
            const i = displayMessages.length - 1 - ri
            return <MessageBubble key={i} message={msg} staffName={firstNameOnly} />
          })}
        </div>
        </ScrollArea>
      </div>

      {Array.isArray(interview.verbatim_flags) && interview.verbatim_flags.length > 0 && (
        <div className="py-2 shrink-0 border-t">
          <p className="text-2xs text-muted-foreground mb-1.5 flex items-center gap-1">
            <Quote className="h-3 w-3" />
            Verbatim — these phrases will appear word-for-word in every draft
          </p>
          <div className="flex flex-wrap gap-1.5">
            {interview.verbatim_flags.map((f) => (
              <span key={f.id} className="inline-flex items-center gap-1 text-xs bg-warning/10 text-warning border border-warning/30 rounded-full pl-2.5 pr-1 py-0.5 max-w-md">
                <span className="truncate italic">{'“'}{f.text}{'”'}</span>
                <button
                  type="button"
                  onClick={() => removeVerbatimFlag(f.id)}
                  aria-label="Remove verbatim flag"
                  className="shrink-0 rounded-full hover:bg-warning/20 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Realtime (voice) wrap. The attach-video affordance below is the ONLY
          way this path can reach VideoAttachPrompt: the chat completion card
          that normally hosts it is gated on !fromRealtimeWrap, so a clinician
          who ran the interview on an iPad while a phone filmed them — the exact
          workflow migration 114 was written for — had no route to attaching the
          recording. video_media_asset_id was set on zero rows in prod.

          Gated on !showVideoPrompt so the reveal steps aside while attaching,
          mirroring how the chat card hides itself. Deliberately NOT gated on
          completionData: on this path blog generation is still running when the
          reveal first mounts, and the recording is ready to attach right then. */}
      {fromRealtimeWrap && !showVideoPrompt && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 py-6">
          <PostCallReveal />
          <button
            type="button"
            onClick={() => setShowVideoPrompt(true)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Video className="h-3.5 w-3.5" aria-hidden="true" />
            Recorded a video too? Attach it
            <span className="text-muted-foreground/70">(optional)</span>
          </button>
        </div>
      )}

      {fromRealtimeWrap && showVideoPrompt && (
        <div className="flex-1 flex items-center justify-center py-6">
          <div className="rounded-xl border bg-card max-w-md w-full">
            <VideoAttachPrompt
              interviewId={interviewId}
              staffName={staffMember?.name || completionData?.staffName || ''}
              // Return to the reveal rather than navigating: the realtime flow's
              // own handoff is its "Review this week's N" button, and attaching
              // a recording shouldn't quietly redirect somewhere else.
              onDone={() => setShowVideoPrompt(false)}
            />
          </div>
        </div>
      )}

      {isGenerating && !fromRealtimeWrap && (
        <div className="flex-1 flex items-center justify-center py-6">
          <div
            className="rounded-xl border bg-muted p-6 max-w-md w-full flex items-start gap-4"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-5 w-5 text-primary animate-spin shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1">
              <p className="text-base font-semibold">
                {isNewsletterInterview ? 'Writing your newsletter…' : generationStyle === 'minimal_edits' ? 'Cleaning transcript…' : 'Writing your blog post…'}
              </p>
              <div className="mt-2 h-1.5 w-full rounded-full bg-muted-foreground/20 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                  style={{ width: `${genProgress}%` }}
                />
              </div>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                {isNewsletterInterview
                  ? 'Writing your newsletter from this conversation. We\'ll open the draft when it\'s ready — in your TrustDrivenCare email template, ready to review and send.'
                  : generationStyle === 'minimal_edits'
                  ? 'Removing filler words while preserving your exact phrasing. We\'ll open the story view when it\'s ready.'
                  : 'Turning your interview into a full blog post. We\'ll open the story view when it\'s ready — social, video, and marketing content will generate on demand from there.'}
              </p>
              {coveredSummary && (
                <div className="mt-4 rounded-lg border border-primary/20 bg-primary/10 px-3.5 py-3">
                  <p className="text-2xs font-bold uppercase tracking-widest text-primary mb-1.5">
                    What you covered
                  </p>
                  <div className="text-sm text-primary/90 leading-relaxed whitespace-pre-line">
                    {coveredSummary}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {completionData && !isGenerating && !showVideoPrompt && !fromRealtimeWrap && (
        <div className="flex-1 flex items-center justify-center py-6">
          <div className="rounded-xl border bg-card p-6 max-w-md w-full text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="h-7 w-7 text-primary" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">
                Great conversation, {completionData.staffName?.split(' ')[0] || 'there'}.
              </h2>
              {completionData.topic && (
                <p className="text-sm text-muted-foreground line-clamp-1">{completionData.topic}</p>
              )}
            </div>
            <p className="text-base font-medium text-foreground">
              {completionData.voicePct != null
                ? `Your words made up ${completionData.voicePct}% of this draft.`
                : 'Voice-faithful draft complete.'}
            </p>
            {/* Platform chips — show what got drafted. A newsletter interview
                produces just the email draft, so don't advertise the full
                channel set. */}
            {completionData.isNewsletter ? (
              <div className="space-y-1.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">We drafted your</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5 text-2xs font-medium text-muted-foreground">
                    Newsletter
                  </span>
                </div>
              </div>
            ) : Array.isArray(runtimeWorkspace?.enabled_outputs) && runtimeWorkspace.enabled_outputs.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">We drafted pieces for</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {runtimeWorkspace.enabled_outputs.slice(0, 6).map((ch) => (
                    <span key={ch} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5 text-2xs font-medium text-muted-foreground capitalize">
                      {ch.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* Primary handoff — leads with the reason they did the interview.
                Video attach is the small optional link below, never a gate. */}
            <Button
              className="w-full"
              size="lg"
              onClick={() => navigate(`/stories/${interviewId}`, { replace: true })}
            >
              {completionData.isNewsletter ? 'See your newsletter' : 'See your story'}
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
            <button
              type="button"
              onClick={() => setShowVideoPrompt(true)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Video className="h-3.5 w-3.5" />
              Recorded a video too? Attach it
              <span className="text-muted-foreground/70">(optional)</span>
            </button>
          </div>
        </div>
      )}

      {completionData && !isGenerating && showVideoPrompt && (
        <div className="flex-1 flex items-center justify-center py-6">
          <div className="rounded-xl border bg-card max-w-md w-full">
            <VideoAttachPrompt
              interviewId={interviewId}
              staffName={completionData.staffName}
              onDone={() => navigate(`/stories/${interviewId}`, { replace: true })}
            />
          </div>
        </div>
      )}

      {interviewComplete && !isGenerating && !completionData && generationError && !fromRealtimeWrap && (
        <div className="flex-1 flex items-center justify-center py-6">
          <div className="rounded-xl border bg-card p-6 max-w-md w-full text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertCircle className="h-7 w-7 text-destructive" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Generation didn&apos;t finish</h2>
              <p className="text-sm text-muted-foreground">
                {error || 'Something went wrong during content generation.'}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Your interview is saved — you can try again or view what&apos;s in your story.
            </p>
            <Button
              className="w-full"
              onClick={handleGenerateContent}
            >
              <RefreshCw className="h-4 w-4 mr-1.5" />
              Try again
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => navigate(`/stories/${interviewId}`, { replace: true })}
            >
              View story anyway
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          </div>
        </div>
      )}

      {!interviewComplete && isOwner && audioInterrupted && (
        <div className="pt-3 pb-1 shrink-0">
          <button
            type="button"
            onClick={handleRestoreAudio}
            className="w-full rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-left hover:bg-warning/15 active:bg-warning/15 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-warning/50"
            aria-label="Audio interrupted. Tap to restore audio and replay the last question."
          >
            <div className="flex items-center gap-3">
              <Volume2 className="h-5 w-5 text-warning shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-warning">Audio interrupted</p>
                <p className="text-xs text-warning">
                  Tap to restore audio and replay the last question. Often happens when headphones or CarPlay change connection.
                </p>
              </div>
              <RefreshCw className="h-4 w-4 text-warning shrink-0" aria-hidden="true" />
            </div>
          </button>
        </div>
      )}

      {!interviewComplete && isOwner && hasSpeechRecognition && (
        <InterviewVoiceDock
          isStreaming={isStreaming}
          isGenerating={isGenerating}
          isSpeaking={isSpeaking}
          isListening={isListening}
          transcript={transcript}
          canFinish={canFinish}
          finishHelper={finishHelper}
          waveformRef={waveformRef}
          onMicClick={isListening ? stopListening : startListening}
          onFinish={() => setInterviewComplete(true)}
          onPause={handlePause}
        />
      )}

      {!interviewComplete && isOwner && !hasSpeechRecognition && (
        <InterviewTypedDock
          typedAnswer={typedAnswer}
          isStreaming={isStreaming}
          isGenerating={isGenerating}
          isSpeaking={isSpeaking}
          canFinish={canFinish}
          finishHelper={finishHelper}
          onChange={(v) => {
            setTypedAnswer(v)
            saveDraft(interviewId, v)
          }}
          onSubmit={() => submitUserText(typedAnswer)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (!isStreaming && !isGenerating && !isSpeaking && typedAnswer.trim()) {
                submitUserText(typedAnswer)
              }
            }
          }}
          onFinish={() => setInterviewComplete(true)}
          onPause={handlePause}
        />
      )}

      {!interviewComplete && !isOwner && (
        <div className="py-3 shrink-0">
          <div className="rounded-xl border bg-muted/50 p-4 text-center">
            <p className="text-sm text-muted-foreground">This interview is in progress. Only the interviewer can continue it.</p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pauseConfirmOpen}
        onOpenChange={setPauseConfirmOpen}
        title="Pause this interview?"
        description={
          isListening
            ? "We're still capturing your answer. Pausing now will drop the in-progress utterance. Your session will be saved — resume from the Home page."
            : isSpeaking || isStreaming
              ? "The AI is mid-response. Pausing now will cut it off. Your session will be saved — resume from the Home page."
              : "Pausing now will drop your in-progress utterance. Your session will be saved — resume from the Home page."
        }
        confirmLabel="Pause anyway"
        destructive={false}
        onConfirm={leaveInterview}
      />
      </div>
    </div>
  )
}

// ── InterviewVoiceDock ────────────────────────────────────────────────────────
// Permanent mic dock for SpeechRecognition browsers. Status line always shows
// current state. Waveform reacts to mic level (or falls back to sine idle
// breathing). State rings change color by mode: red=listening,
// blue=speaking, spinning arc=thinking.
function InterviewVoiceDock({
  isStreaming, isGenerating, isSpeaking, isListening, transcript,
  canFinish, finishHelper,
  waveformRef, onMicClick, onFinish, onPause,
}) {
  const disabled = isStreaming || isGenerating || isSpeaking
  return (
    <div
      className="rounded-2xl border border-border bg-card shadow-lg px-4 py-4 shrink-0 -mx-6 md:mx-0"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      {/* Status line — always visible, never empty */}
      <div className="flex items-center justify-center gap-2 mb-3 min-h-[20px]" role="status" aria-live="polite">
        {isStreaming ? (
          <>
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse shrink-0" aria-hidden="true" />
            <span className="text-sm font-medium text-primary">Thinking…</span>
          </>
        ) : isSpeaking ? (
          <>
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse shrink-0" aria-hidden="true" />
            <span className="text-sm font-medium text-primary">Speaking — your turn is next</span>
          </>
        ) : isListening ? (
          <>
            <span className="h-2 w-2 rounded-full bg-destructive animate-pulse shrink-0" aria-hidden="true" />
            <span className="text-sm font-medium text-destructive">
              {transcript
                ? 'Listening — say “done” or tap mic to send'
                : 'Still listening — take your time, no rush'}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Tap to speak your answer</span>
        )}
      </div>

      {/* Main row: Pause (mobile) | Waveform+Mic | Finish (mobile) */}
      <div className="flex items-center justify-between md:justify-center gap-3">
        {/* Pause — mobile only; desktop has it in the header */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onPause}
              aria-label="Save and pause interview — you can resume later"
              className="md:hidden flex flex-col items-center gap-0.5 text-muted-foreground w-14 shrink-0"
            >
              <span className="h-10 w-10 rounded-full border border-border flex items-center justify-center">
                <PauseCircle className="h-4 w-4" />
              </span>
              <span className="text-3xs">Pause</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Save and pause — you can resume later</TooltipContent>
        </Tooltip>

        {/* Center: waveform bars + mic button */}
        <div className="relative flex items-center justify-center" style={{ width: 160, height: 88 }}>
          {/* Waveform bars — opacity driven by isListening, heights driven by RAF */}
          <div
            ref={waveformRef}
            className={`absolute inset-0 flex items-center justify-center gap-[3px] transition-opacity duration-300 pointer-events-none ${
              isListening ? 'opacity-100' : 'opacity-0'
            }`}
            aria-hidden="true"
            style={{ color: 'hsl(var(--destructive))' }}
          >
            {Array.from({ length: 13 }, (_, i) => (
              <span
                key={i}
                className="bg-current rounded-full"
                style={{
                  width: '3px',
                  height: `${14 + Math.round(Math.abs(Math.sin(i * 1.3)) * 28)}px`,
                  transformOrigin: 'center',
                  transform: 'scaleY(0.25)',
                  willChange: 'transform',
                }}
              />
            ))}
          </div>

          {/* Mic ring + button */}
          <div className="relative flex items-center justify-center h-[72px] w-[72px]">
            {/* Listening: red pulsing ring */}
            {isListening && (
              <span
                className="absolute inset-0 rounded-full animate-ping"
                style={{ background: 'hsl(var(--destructive) / 0.22)', animationDuration: '1.6s' }}
                aria-hidden="true"
              />
            )}
            {/* Speaking: blue pulsing ring */}
            {isSpeaking && (
              <span
                className="absolute inset-0 rounded-full animate-ping"
                style={{ background: 'hsl(var(--info) / 0.22)', animationDuration: '1.8s' }}
                aria-hidden="true"
              />
            )}
            {/* Thinking: spinning conic-gradient arc */}
            {isStreaming && (
              <div
                className="absolute rounded-full animate-spin pointer-events-none"
                style={{
                  inset: -4,
                  background: 'conic-gradient(from 0deg, hsl(var(--primary)) 0%, transparent 55%)',
                  WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px))',
                  mask: 'radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px))',
                }}
                aria-hidden="true"
              />
            )}
            <button
              onClick={onMicClick}
              disabled={disabled}
              aria-label={isListening ? 'Stop recording' : 'Start recording'}
              aria-pressed={isListening}
              className="relative h-[72px] w-[72px] rounded-full flex items-center justify-center text-white shadow-lg transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
              style={{
                background: isListening
                  ? 'hsl(var(--destructive))'
                  : isSpeaking
                  ? 'hsl(var(--info))'
                  : isStreaming
                  ? 'hsl(var(--muted))'
                  : 'hsl(var(--primary))',
              }}
            >
              {isListening ? (
                <MicOff className="h-7 w-7" aria-hidden="true" />
              ) : isSpeaking ? (
                <Volume2 className="h-7 w-7" aria-hidden="true" />
              ) : isStreaming ? (
                <Sparkles className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
              ) : (
                <Mic className="h-7 w-7" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {/* Finish — mobile only; desktop has it in the header */}
        <div className="md:hidden flex flex-col items-center gap-0.5 w-14 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onFinish}
                disabled={!canFinish}
                aria-label={canFinish ? 'Finish interview' : finishHelper || 'Finish interview'}
                className="h-10 w-10 rounded-full border border-border flex items-center justify-center text-muted-foreground disabled:opacity-30 hover:bg-muted transition-colors"
              >
                <Sparkles className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{canFinish ? 'Finish interview' : finishHelper || 'Finish interview'}</TooltipContent>
          </Tooltip>
          <span className="text-3xs text-muted-foreground">Finish</span>
          {!canFinish && finishHelper && (
            <span className="text-3xs text-muted-foreground text-center leading-tight px-1 max-w-[3.5rem]">
              {finishHelper}
            </span>
          )}
        </div>
      </div>

      {/* Live transcript — shown below mic row */}
      {transcript && (
        <div
          aria-live="polite"
          aria-label="Transcript"
          className="mt-3 rounded-xl bg-muted px-4 py-3 text-sm text-foreground/80 italic min-h-[44px]"
        >
          &quot;{transcript}&quot;
        </div>
      )}
    </div>
  )
}

// ── InterviewTypedDock ────────────────────────────────────────────────────────
// Fallback dock for browsers without SpeechRecognition (iOS Safari).
// Matches the card style of InterviewVoiceDock.
function InterviewTypedDock({
  typedAnswer, isStreaming, isGenerating, isSpeaking,
  canFinish, finishHelper, onChange, onSubmit, onKeyDown, onFinish, onPause,
}) {
  const disabled = isStreaming || isGenerating || isSpeaking
  return (
    <div
      className="rounded-2xl border border-border bg-card shadow-lg px-4 py-4 shrink-0 -mx-6 md:mx-0"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      {/* Status line */}
      <div className="flex items-center justify-center gap-2 mb-3 min-h-[20px]" role="status" aria-live="polite">
        {isStreaming ? (
          <>
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse shrink-0" aria-hidden="true" />
            <span className="text-sm font-medium text-primary">Thinking…</span>
          </>
        ) : isSpeaking ? (
          <>
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse shrink-0" aria-hidden="true" />
            <span className="text-sm font-medium text-primary">Speaking — your turn is next</span>
          </>
        ) : (
          <>
            <Keyboard className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span className="text-sm text-muted-foreground">Type your answer — voice input isn&rsquo;t available in this browser</span>
          </>
        )}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={typedAnswer}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type your answer here…"
          rows={3}
          disabled={disabled}
          className="flex-1 rounded-xl border bg-background px-3 py-2 text-base md:text-sm resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          aria-label="Type your answer"
        />
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button
            onClick={onSubmit}
            disabled={disabled || !typedAnswer.trim()}
            size="lg"
            aria-label="Send answer"
            className="h-11 px-4"
          >
            {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Send className="h-4 w-4 mr-1.5" aria-hidden="true" />Send</>}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={onFinish}
                disabled={!canFinish || isStreaming}
                aria-label={canFinish ? 'Finish interview' : finishHelper || 'Finish interview'}
                className="h-11 w-11"
              >
                <Sparkles className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{canFinish ? 'Finish interview' : finishHelper || 'Finish interview'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Mobile-only Pause + Finish row */}
      <div className="md:hidden flex items-center justify-between gap-2 mt-2 pt-2 border-t border-border/50">
        <Button
          variant="ghost"
          size="sm"
          onClick={onPause}
          aria-label="Pause interview"
          className="gap-1 text-muted-foreground min-h-[44px]"
        >
          <PauseCircle className="h-4 w-4" />
          <span className="text-xs">Pause</span>
        </Button>
        <div className="flex flex-col items-end gap-1">
          <Button
            size="sm"
            onClick={onFinish}
            disabled={!canFinish}
            aria-label={canFinish ? 'Finish interview' : finishHelper}
            className="gap-1.5 min-h-[44px]"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Finish
          </Button>
          {!canFinish && (
            <span className="text-2xs text-muted-foreground text-right leading-tight max-w-[10rem]">
              {finishHelper}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// Thin progress chip shown in the meta-badge row. Gives the clinician a
// sense of how far through the interview they are without a hard question
// count (Bernard adapts depth to the answers, so ~6 is an estimate, not a
// gate). Hidden before the first answer and after the interview completes.
const TYPICAL_QUESTION_COUNT = 6
function InterviewProgress({ count }) {
  const pct = Math.min(100, Math.round((count / TYPICAL_QUESTION_COUNT) * 100))
  const label =
    count >= TYPICAL_QUESTION_COUNT
      ? 'Wrapping up'
      : `~${Math.max(1, TYPICAL_QUESTION_COUNT - count)} more`

  return (
    <span className="inline-flex items-center gap-1.5 ml-auto text-3xs text-muted-foreground shrink-0">
      <span className="relative h-1 w-14 rounded-full bg-muted overflow-hidden">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </span>
      {label}
    </span>
  )
}

function InstructionCard({ icon, title, body }) {
  return (
    <div className="flex gap-4 rounded-xl border bg-card p-4">
      <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        {icon}
      </div>
      <div>
        <p className="font-semibold text-sm mb-1">{title}</p>
        <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
      </div>
    </div>
  )
}

function MessageBubble({ message, staffName, isStreaming }) {
  const runtimeWs = useWorkspace()
  // Prefer the Brand Kit's favicon / mark-only role (canonical), then any
  // legacy workspace.logo.icon, then the static per-deploy fallback.
  const iconUrl = runtimeWs?.brand_kit_roles?.favicon
    ?? runtimeWs?.brand_kit_roles?.mark_only
    ?? runtimeWs?.logo?.icon
    ?? workspace.logo.icon
  const isAI = message.role === 'assistant'
  const isContrast  = isAI && hasContrastSignal(message.content)
  const isAgreement = isAI && hasAgreementSignal(message.content)
  const isGap       = isAI && hasGapSignal(message.content)
  const contrastName  = isContrast  ? extractContrastName(message.content)  : null
  const agreementName = isAgreement ? extractAgreementName(message.content) : null
  const displayContent = isAI
    ? stripGapToken(stripAgreementToken(stripContrastToken(message.content)))
    : message.content
  return (
    <div className={`flex items-start gap-3 ${!isAI ? 'flex-row-reverse' : ''}`}>
      {isAI ? (
        <div className="h-8 w-8 rounded-full bg-card border border-border flex items-center justify-center shrink-0 p-1">
          <img src={iconUrl} alt={runtimeWs?.display_name || workspace.name} className="h-full w-full" />
        </div>
      ) : (
        <div className="h-8 w-8 rounded-full bg-secondary flex items-center justify-center shrink-0 text-xs font-medium">
          {staffName[0]}
        </div>
      )}
      <div className="flex flex-col gap-1 max-w-[90%] sm:max-w-[80%]">
        {isContrast && (
          <span className="self-start inline-flex items-center gap-1.5 text-xs font-medium text-contrast-signal bg-contrast-signal/10 border border-contrast-signal/30 rounded-full px-2.5 py-0.5">
            <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            {contrastName ? `Different angle than ${contrastName}'s interview` : 'Different angle from this practice'}
          </span>
        )}
        {isAgreement && (
          <span className="self-start inline-flex items-center gap-1.5 text-xs font-medium text-agreement-signal bg-agreement-signal/10 border border-agreement-signal/30 rounded-full px-2.5 py-0.5">
            <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            {agreementName ? `Aligns with ${agreementName}'s recent interview` : 'Aligns with prior interviews here'}
          </span>
        )}
        {isGap && (
          <span className="self-start inline-flex items-center gap-1.5 text-xs font-medium text-verbatim-accent bg-verbatim-accent/10 border border-verbatim-accent/30 rounded-full px-2.5 py-0.5">
            <Circle className="h-3 w-3 shrink-0" aria-hidden="true" />
            New ground
          </span>
        )}
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
            isAI
              ? 'bg-muted rounded-tl-sm'
              : 'bg-primary text-primary-foreground rounded-tr-sm'
          } ${isStreaming ? 'animate-pulse' : ''}`}
        >
          {displayContent}
        </div>
      </div>
    </div>
  )
}
