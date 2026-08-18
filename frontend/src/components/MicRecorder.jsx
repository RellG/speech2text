import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'framer-motion'
import { Loader2, Mic, MicOff, Square } from 'lucide-react'
import { cn, formatDuration } from '../lib/utils'

/** Fallback only; the real cap comes from /api/config (MAX_RECORDING_SECONDS).
 *  The backend splits anything over the API's 60s ceiling automatically. */
const DEFAULT_MAX_SECONDS = 600

/** Pick the best container/codec this browser can actually produce. */
function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  if (typeof MediaRecorder === 'undefined') return ''
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function extensionFor(mimeType) {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4')) return 'm4a'
  return 'webm'
}

/** "10 min" / "90s" — keeps the idle hint readable at any cap. */
function describeLimit(seconds) {
  if (seconds >= 120) {
    const minutes = Math.round(seconds / 60)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  return `${seconds} seconds`
}

export default function MicRecorder({ onRecorded, busy, disabled, maxSeconds }) {
  const reduceMotion = useReducedMotion()
  const MAX_SECONDS = maxSeconds || DEFAULT_MAX_SECONDS

  const [isRecording, setIsRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [supported, setSupported] = useState(true)

  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(null)
  const autoStoppedRef = useRef(false)

  // Live input level (0..1), smoothed with a spring so the aura breathes.
  const rawLevel = useMotionValue(0)
  const level = useSpring(rawLevel, { stiffness: 220, damping: 22, mass: 0.6 })
  const auraScale = useTransform(level, [0, 1], [1, 1.55])
  const auraOpacity = useTransform(level, [0, 1], [0.35, 0.85])
  const haloScale = useTransform(level, [0, 1], [1, 1.28])

  useEffect(() => {
    setSupported(
      typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== 'undefined',
    )
  }, [])

  /** Tear down every audio resource; safe to call more than once. */
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (audioContextRef.current) {
      const context = audioContextRef.current
      audioContextRef.current = null
      analyserRef.current = null
      context.close().catch(() => {})
    }
    mediaRecorderRef.current = null
    rawLevel.set(0)
  }, [rawLevel])

  useEffect(() => cleanup, [cleanup])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
  }, [])

  const startMetering = useCallback(
    (stream) => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) return

      const context = new AudioContextClass()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.75
      source.connect(analyser)

      audioContextRef.current = context
      analyserRef.current = analyser

      const buffer = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        const node = analyserRef.current
        if (!node) return
        node.getByteTimeDomainData(buffer)

        // RMS around the 128 midpoint gives a stable perceived loudness.
        let sumSquares = 0
        for (let i = 0; i < buffer.length; i += 1) {
          const deviation = (buffer[i] - 128) / 128
          sumSquares += deviation * deviation
        }
        const rms = Math.sqrt(sumSquares / buffer.length)
        rawLevel.set(Math.min(1, rms * 4))

        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [rawLevel],
  )

  const startRecording = useCallback(async () => {
    if (isRecording || busy || disabled) return

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (error) {
      onRecorded(null, {
        error:
          error?.name === 'NotAllowedError'
            ? 'Microphone permission denied. Allow access in your browser settings.'
            : `Could not open the microphone: ${error?.message ?? 'unknown error'}`,
      })
      return
    }

    streamRef.current = stream
    chunksRef.current = []
    autoStoppedRef.current = false

    const mimeType = pickMimeType()
    let recorder
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch {
      recorder = new MediaRecorder(stream)
    }
    mediaRecorderRef.current = recorder

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
    }

    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      chunksRef.current = []
      const hitLimit = autoStoppedRef.current

      cleanup()
      setIsRecording(false)
      setElapsed(0)

      if (blob.size === 0) {
        onRecorded(null, { error: 'Nothing was recorded. Check your microphone and try again.' })
        return
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = new File([blob], `recording-${stamp}.${extensionFor(type)}`, { type })
      onRecorded(
        file,
        hitLimit ? { notice: `Stopped automatically at the ${describeLimit(MAX_SECONDS)} limit.` } : {},
      )
    }

    recorder.onerror = () => {
      cleanup()
      setIsRecording(false)
      setElapsed(0)
      onRecorded(null, { error: 'Recording failed unexpectedly.' })
    }

    recorder.start()
    startMetering(stream)
    setIsRecording(true)
    setElapsed(0)

    const startedAt = Date.now()
    timerRef.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000)
      setElapsed(seconds)
      if (seconds >= MAX_SECONDS) {
        autoStoppedRef.current = true
        stopRecording()
      }
    }, 200)
  }, [MAX_SECONDS, busy, cleanup, disabled, isRecording, onRecorded, startMetering, stopRecording])

  const toggle = () => (isRecording ? stopRecording() : startRecording())

  const controlsDisabled = busy || disabled || !supported
  const progress = Math.min(1, elapsed / MAX_SECONDS)

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative flex h-44 w-44 items-center justify-center">
        {/* Reactive aura: scales with live input level while recording. */}
        <AnimatePresence>
          {isRecording && (
            <>
              <motion.span
                key="aura-outer"
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={reduceMotion ? undefined : { scale: auraScale, opacity: auraOpacity }}
                className="absolute h-32 w-32 rounded-full bg-ios-red/25 blur-2xl"
              />
              <motion.span
                key="aura-inner"
                aria-hidden="true"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={reduceMotion ? undefined : { scale: haloScale }}
                className="absolute h-28 w-28 rounded-full border border-ios-red/40 bg-ios-red/10"
              />
              {!reduceMotion && (
                <motion.span
                  key="ripple"
                  aria-hidden="true"
                  initial={{ scale: 1, opacity: 0.5 }}
                  animate={{ scale: 1.7, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                  className="absolute h-28 w-28 rounded-full border border-ios-red/50"
                />
              )}
            </>
          )}
        </AnimatePresence>

        {/* Elapsed-time ring. */}
        <svg className="absolute h-36 w-36 -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            strokeWidth="2"
            className="stroke-black/10 dark:stroke-white/10"
          />
          <motion.circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-ios-red"
            style={{ pathLength: isRecording ? progress : 0 }}
            initial={false}
            animate={{ opacity: isRecording ? 1 : 0 }}
            transition={{ duration: 0.2 }}
          />
        </svg>

        <motion.button
          type="button"
          onClick={toggle}
          disabled={controlsDisabled}
          aria-label={isRecording ? 'Stop recording' : 'Start recording'}
          aria-pressed={isRecording}
          whileTap={reduceMotion || controlsDisabled ? undefined : { scale: 0.96 }}
          whileHover={reduceMotion || controlsDisabled ? undefined : { y: -2 }}
          transition={{ type: 'spring', stiffness: 400, damping: 24 }}
          className={cn(
            'relative z-panel flex h-24 w-24 cursor-pointer items-center justify-center rounded-full',
            'border shadow-lg transition-colors duration-200',
            'disabled:cursor-not-allowed disabled:opacity-50',
            isRecording
              ? 'border-ios-red/50 bg-ios-red text-white shadow-ios-red/40'
              : 'border-white/40 bg-gradient-to-b from-ios-blue to-ios-indigo text-white shadow-ios-blue/30 dark:border-white/20',
          )}
        >
          {busy ? (
            <Loader2 className="h-9 w-9 animate-spin" aria-hidden="true" />
          ) : !supported ? (
            <MicOff className="h-9 w-9" aria-hidden="true" />
          ) : isRecording ? (
            <Square className="h-8 w-8 fill-current" aria-hidden="true" />
          ) : (
            <Mic className="h-9 w-9" aria-hidden="true" />
          )}
        </motion.button>
      </div>

      <div className="flex min-h-[3.25rem] flex-col items-center gap-1 text-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={isRecording ? 'recording' : busy ? 'busy' : 'idle'}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="flex flex-col items-center gap-1"
          >
            {isRecording ? (
              <>
                <p className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
                  {formatDuration(elapsed)}
                </p>
                <p className="flex items-center gap-2 text-sm text-muted">
                  <span className="inline-block h-2 w-2 rounded-full bg-ios-red" aria-hidden="true" />
                  Listening — tap to stop
                </p>
              </>
            ) : busy ? (
              <p className="text-sm text-muted">Transcribing your recording…</p>
            ) : !supported ? (
              <p className="max-w-xs text-sm text-ios-red">
                This browser cannot record audio. Use the file upload below, or open the app over
                HTTPS or localhost.
              </p>
            ) : (
              <>
                <p className="text-base font-medium">Tap to record</p>
                <p className="text-sm text-muted">Up to {describeLimit(MAX_SECONDS)} per take</p>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
