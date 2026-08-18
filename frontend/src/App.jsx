import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { AudioLines, Moon, Sun } from 'lucide-react'
import GlassCard from './components/GlassCard'
import MicRecorder from './components/MicRecorder'
import FileUploader from './components/FileUploader'
import TranscriptViewer from './components/TranscriptViewer'
import Toast from './components/Toast'

/** Soft ambient blobs behind the glass; purely decorative. */
function AmbientBackground() {
  const reduceMotion = useReducedMotion()
  const drift = reduceMotion ? '' : 'animate-drift'
  const driftSlow = reduceMotion ? '' : 'animate-drift-slow'

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-[#EEF1F8] via-[#E6ECFA] to-[#F3EDF9] dark:from-[#0B0B14] dark:via-[#111129] dark:to-[#0A0A12]" />
      <div
        className={`absolute -left-32 -top-24 h-[28rem] w-[28rem] rounded-full bg-ios-blue/25 blur-[110px] dark:bg-ios-blue/20 ${drift}`}
      />
      <div
        className={`absolute -right-28 top-1/4 h-[26rem] w-[26rem] rounded-full bg-ios-indigo/25 blur-[120px] dark:bg-ios-indigo/25 ${driftSlow}`}
      />
      <div
        className={`absolute bottom-[-8rem] left-1/4 h-[24rem] w-[24rem] rounded-full bg-ios-teal/20 blur-[110px] dark:bg-ios-teal/15 ${drift}`}
        style={{ animationDelay: '-8s' }}
      />
    </div>
  )
}

function ThemeToggle({ theme, onToggle }) {
  const reduceMotion = useReducedMotion()
  const isDark = theme === 'dark'

  return (
    <motion.button
      type="button"
      onClick={onToggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      whileTap={reduceMotion ? undefined : { scale: 0.96 }}
      whileHover={reduceMotion ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 24 }}
      className="glass flex h-11 w-11 cursor-pointer items-center justify-center rounded-2xl transition-colors duration-200"
    >
      <motion.span
        key={theme}
        initial={reduceMotion ? false : { opacity: 0, rotate: -90, scale: 0.6 }}
        animate={{ opacity: 1, rotate: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 22 }}
        className="flex"
      >
        {isDark ? (
          <Sun className="h-5 w-5 text-amber-400" aria-hidden="true" />
        ) : (
          <Moon className="h-5 w-5 text-ios-indigo" aria-hidden="true" />
        )}
      </motion.span>
    </motion.button>
  )
}

export default function App() {
  const [transcript, setTranscript] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [toasts, setToasts] = useState([])
  const [meta, setMeta] = useState(null)
  const [backend, setBackend] = useState({
    state: 'checking',
    model: '',
    location: '',
    maxRecordingSeconds: 0,
    maxUploadBytes: 0,
  })
  const [theme, setTheme] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  )

  const toastTimers = useRef(new Map())

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = toastTimers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      toastTimers.current.delete(id)
    }
  }, [])

  const notify = useCallback(
    (message, tone = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setToasts((current) => [...current.slice(-2), { id, message, tone }])
      const timer = setTimeout(() => dismissToast(id), tone === 'error' ? 7000 : 3500)
      toastTimers.current.set(id, timer)
    },
    [dismissToast],
  )

  // Clear any pending toast timers on unmount.
  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem('s2t-theme', theme)
    } catch {
      /* private browsing — the in-memory theme still applies */
    }
  }, [theme])

  // Probe the backend once so the status pill reflects reality.
  useEffect(() => {
    let cancelled = false
    fetch('/api/config')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('bad status'))))
      .then((data) => {
        if (cancelled) return
        setBackend({
          state: data.project_configured ? 'ready' : 'unconfigured',
          model: data.model ?? '',
          location: data.location ?? '',
          maxRecordingSeconds: data.max_recording_seconds ?? 0,
          maxUploadBytes: data.max_upload_bytes ?? 0,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setBackend({
            state: 'offline',
            model: '',
            location: '',
            maxRecordingSeconds: 0,
            maxUploadBytes: 0,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const transcribe = useCallback(
    async (file) => {
      setBusy(true)
      setSourceName(file.name)

      const body = new FormData()
      body.append('file', file, file.name)

      try {
        const response = await fetch('/api/transcribe', { method: 'POST', body })
        const payload = await response.json().catch(() => ({}))

        if (!response.ok) {
          throw new Error(payload.detail || `Request failed with status ${response.status}`)
        }

        const text = (payload.transcript || '').trim()
        setTranscript(text)
        setMeta({ duration: payload.duration_seconds ?? null, chunks: payload.chunks ?? 1 })

        if (text) {
          notify(
            payload.chunks > 1
              ? `Transcription complete — joined from ${payload.chunks} segments`
              : 'Transcription complete',
            'success',
          )
        } else {
          notify('No speech detected in that audio.', 'info')
        }
      } catch (error) {
        setTranscript('')
        setMeta(null)
        notify(error.message || 'Transcription failed.', 'error')
      } finally {
        setBusy(false)
      }
    },
    [notify],
  )

  const handleRecorded = useCallback(
    (file, meta = {}) => {
      if (meta.error) {
        notify(meta.error, 'error')
        return
      }
      if (meta.notice) notify(meta.notice, 'info')
      if (file) transcribe(file)
    },
    [notify, transcribe],
  )

  const clearTranscript = useCallback(() => {
    setTranscript('')
    setSourceName('')
    setMeta(null)
  }, [])

  const statusLabel = {
    checking: 'Connecting…',
    ready: backend.model ? `${backend.model} · ${backend.location}` : 'Ready',
    unconfigured: 'GCP project not configured',
    offline: 'Backend unreachable',
  }[backend.state]

  const statusDot = {
    checking: 'bg-amber-400',
    ready: 'bg-ios-green',
    unconfigured: 'bg-amber-400',
    offline: 'bg-ios-red',
  }[backend.state]

  return (
    <>
      <AmbientBackground />

      <div className="relative z-base mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="glass flex h-11 w-11 items-center justify-center rounded-2xl">
              <AudioLines className="h-5 w-5 text-ios-blue" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Speech to Text</h1>
              <p className="text-sm text-muted">Homelab transcription</p>
            </div>
          </div>
          <ThemeToggle
            theme={theme}
            onToggle={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          />
        </header>

        <main className="flex flex-col gap-6">
          <GlassCard delay={0.05} className="py-8">
            <MicRecorder
              onRecorded={handleRecorded}
              busy={busy}
              disabled={backend.state === 'offline'}
              maxSeconds={backend.maxRecordingSeconds}
            />
          </GlassCard>

          <GlassCard delay={0.12}>
            <div className="mb-4 flex items-center gap-2.5">
              <h2 className="text-lg font-semibold tracking-tight">Upload audio</h2>
            </div>
            <FileUploader
              onSubmit={transcribe}
              busy={busy}
              disabled={backend.state === 'offline'}
              maxBytes={backend.maxUploadBytes}
            />
          </GlassCard>

          <GlassCard delay={0.19}>
            <TranscriptViewer
              transcript={transcript}
              sourceName={sourceName}
              meta={meta}
              busy={busy}
              onClear={clearTranscript}
              onNotify={notify}
            />
          </GlassCard>
        </main>

        <footer className="mt-auto flex justify-center pt-2">
          <div className="glass flex items-center gap-2.5 rounded-full px-4 py-2 text-xs text-muted">
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} aria-hidden="true" />
            <span>{statusLabel}</span>
          </div>
        </footer>
      </div>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </>
  )
}
