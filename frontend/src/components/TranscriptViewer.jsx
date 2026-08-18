import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, Copy, FileText, Trash2 } from 'lucide-react'
import { countWords, formatDuration } from '../lib/utils'

/** Copy text using the async clipboard API, with a textarea fallback for
 *  non-secure origins (a plain http:// homelab IP has no navigator.clipboard). */
async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) throw new Error('Clipboard write was blocked by the browser.')
}

export default function TranscriptViewer({ transcript, sourceName, meta, busy, onClear, onNotify }) {
  const reduceMotion = useReducedMotion()
  const [justCopied, setJustCopied] = useState(false)

  const words = useMemo(() => transcript.split(/(\s+)/).filter(Boolean), [transcript])
  const wordCount = useMemo(() => countWords(transcript), [transcript])
  const hasTranscript = transcript.trim().length > 0

  useEffect(() => {
    if (!justCopied) return undefined
    const timeout = setTimeout(() => setJustCopied(false), 2000)
    return () => clearTimeout(timeout)
  }, [justCopied])

  const handleCopy = async () => {
    try {
      await copyText(transcript)
      setJustCopied(true)
      onNotify('Copied to clipboard', 'success')
    } catch (error) {
      onNotify(error.message || 'Could not copy to clipboard.', 'error')
    }
  }

  return (
    <motion.div layout={!reduceMotion} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <FileText className="h-5 w-5 text-ios-blue" aria-hidden="true" />
          <h2 className="text-lg font-semibold tracking-tight">Transcript</h2>
        </div>

        <AnimatePresence initial={false}>
          {hasTranscript && (
            <motion.div
              key="actions"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className="flex items-center gap-2"
            >
              <motion.button
                type="button"
                onClick={handleCopy}
                aria-label="Copy transcript to clipboard"
                whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                whileHover={reduceMotion ? undefined : { y: -2 }}
                transition={{ type: 'spring', stiffness: 400, damping: 24 }}
                className="glass-inset flex min-h-[2.75rem] cursor-pointer items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors duration-200 hover:bg-white/85 dark:hover:bg-white/[0.12]"
              >
                <AnimatePresence mode="wait" initial={false}>
                  {justCopied ? (
                    <motion.span
                      key="copied"
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ duration: 0.15 }}
                      className="flex items-center gap-2 text-ios-green"
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                      Copied
                    </motion.span>
                  ) : (
                    <motion.span
                      key="copy"
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ duration: 0.15 }}
                      className="flex items-center gap-2"
                    >
                      <Copy className="h-4 w-4" aria-hidden="true" />
                      Copy
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.button>

              <motion.button
                type="button"
                onClick={onClear}
                aria-label="Clear transcript"
                whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                whileHover={reduceMotion ? undefined : { y: -2 }}
                transition={{ type: 'spring', stiffness: 400, damping: 24 }}
                className="glass-inset flex min-h-[2.75rem] cursor-pointer items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium text-muted transition-colors duration-200 hover:text-ios-red"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Clear
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Fluid height expansion between empty / loading / filled states. */}
      <motion.div
        layout={!reduceMotion}
        transition={{ type: 'spring', stiffness: 260, damping: 30 }}
        className="glass-inset min-h-[9rem] overflow-hidden rounded-3xl"
      >
        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="space-y-3 p-5"
              aria-live="polite"
            >
              <span className="sr-only">Transcribing audio…</span>
              {[100, 92, 76].map((width, index) => (
                <div
                  key={width}
                  aria-hidden="true"
                  style={{ width: `${width}%`, animationDelay: `${index * 0.15}s` }}
                  className="h-4 rounded-full bg-gradient-to-r from-black/5 via-black/10 to-black/5 bg-[length:200%_100%] animate-shimmer dark:from-white/5 dark:via-white/15 dark:to-white/5"
                />
              ))}
            </motion.div>
          ) : hasTranscript ? (
            <motion.div
              key="transcript"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="max-h-[22rem] overflow-y-auto scrollbar-slim p-5"
            >
              <p className="text-[17px] leading-relaxed">
                {reduceMotion
                  ? transcript
                  : words.map((word, index) => (
                      <motion.span
                        // Word order is stable for a given transcript render.
                        key={`${index}-${word}`}
                        initial={{ opacity: 0, filter: 'blur(3px)' }}
                        animate={{ opacity: 1, filter: 'blur(0px)' }}
                        transition={{
                          duration: 0.28,
                          delay: Math.min(index * 0.014, 1.2),
                          ease: 'easeOut',
                        }}
                      >
                        {word}
                      </motion.span>
                    ))}
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex min-h-[9rem] flex-col items-center justify-center gap-2 p-6 text-center"
            >
              <FileText className="h-7 w-7 text-slate-400 dark:text-white/30" aria-hidden="true" />
              <p className="text-sm text-muted">
                Record something or upload a file — the transcript lands here.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence initial={false}>
        {hasTranscript && !busy && (
          <motion.div
            key="stats"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted"
          >
            <span className="tabular-nums">{wordCount.toLocaleString()} words</span>
            <span className="tabular-nums">{transcript.length.toLocaleString()} characters</span>
            {meta?.duration ? (
              <span className="tabular-nums">{formatDuration(meta.duration)} of audio</span>
            ) : null}
            {meta?.chunks > 1 ? (
              <span className="tabular-nums">joined from {meta.chunks} segments</span>
            ) : null}
            {sourceName && (
              <span className="max-w-full truncate" title={sourceName}>
                from {sourceName}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
