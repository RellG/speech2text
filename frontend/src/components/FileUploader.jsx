import { useCallback, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { FileAudio, Loader2, Sparkles, UploadCloud, X } from 'lucide-react'
import { cn, formatBytes } from '../lib/utils'

const ACCEPTED_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm']
const ACCEPT_ATTRIBUTE = `${ACCEPTED_EXTENSIONS.join(',')},audio/*`
/** Fallback only; the real limit comes from /api/config. */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024

function hasAllowedExtension(name) {
  const lower = name.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export default function FileUploader({ onSubmit, busy, disabled, maxBytes }) {
  const reduceMotion = useReducedMotion()
  const MAX_BYTES = maxBytes || DEFAULT_MAX_BYTES
  const maxLabel = `${Math.round(MAX_BYTES / 1024 / 1024)} MB`
  const inputRef = useRef(null)
  const dragDepth = useRef(0)

  const [isDragging, setIsDragging] = useState(false)
  const [selected, setSelected] = useState(null)
  const [validationError, setValidationError] = useState('')

  const controlsDisabled = busy || disabled

  const acceptFile = useCallback((file) => {
    if (!file) return
    if (!hasAllowedExtension(file.name)) {
      setSelected(null)
      setValidationError(`Unsupported format. Use ${ACCEPTED_EXTENSIONS.join(', ')}.`)
      return
    }
    if (file.size > MAX_BYTES) {
      setSelected(null)
      setValidationError(`${formatBytes(file.size)} is too large. The limit is ${maxLabel}.`)
      return
    }
    setValidationError('')
    setSelected(file)
  }, [MAX_BYTES, maxLabel])

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault()
      dragDepth.current = 0
      setIsDragging(false)
      if (controlsDisabled) return
      acceptFile(event.dataTransfer.files?.[0])
    },
    [acceptFile, controlsDisabled],
  )

  const handleDragEnter = useCallback(
    (event) => {
      event.preventDefault()
      if (controlsDisabled) return
      dragDepth.current += 1
      setIsDragging(true)
    },
    [controlsDisabled],
  )

  const handleDragLeave = useCallback((event) => {
    event.preventDefault()
    // Depth counter keeps the highlight steady while crossing child elements.
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  }, [])

  const openPicker = () => {
    if (!controlsDisabled) inputRef.current?.click()
  }

  const clearSelection = () => {
    setSelected(null)
    setValidationError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const submit = () => {
    if (selected && !controlsDisabled) onSubmit(selected)
  }

  return (
    <div className="flex flex-col gap-4">
      <motion.div
        role="button"
        tabIndex={controlsDisabled ? -1 : 0}
        aria-label="Choose an audio file, or drop one here"
        aria-disabled={controlsDisabled}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openPicker()
          }
        }}
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        animate={
          reduceMotion ? undefined : { scale: isDragging ? 1.015 : 1 }
        }
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
        className={cn(
          'glass-inset flex cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl',
          'border-dashed px-6 py-9 text-center transition-colors duration-200',
          isDragging
            ? 'border-ios-blue bg-ios-blue/10 dark:bg-ios-blue/15'
            : 'hover:border-ios-blue/50 hover:bg-white/80 dark:hover:bg-white/[0.1]',
          controlsDisabled && 'pointer-events-none opacity-50',
        )}
      >
        <motion.div
          animate={reduceMotion ? undefined : { y: isDragging ? -3 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-b from-ios-blue/20 to-ios-indigo/20 text-ios-blue"
        >
          <UploadCloud className="h-7 w-7" aria-hidden="true" />
        </motion.div>

        <div className="space-y-1">
          <p className="text-base font-medium">
            {isDragging ? 'Drop it to load' : 'Drag an audio file here'}
          </p>
          <p className="text-sm text-muted">
            or <span className="font-medium text-ios-blue">browse your device</span>
          </p>
        </div>

        <p className="text-xs text-muted">
          {ACCEPTED_EXTENSIONS.join(' · ')} — up to {maxLabel}, any length
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          onChange={(event) => acceptFile(event.target.files?.[0])}
        />
      </motion.div>

      <AnimatePresence mode="popLayout" initial={false}>
        {validationError && (
          <motion.p
            key="validation"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="flex items-start gap-2 text-sm text-ios-red"
          >
            <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {validationError}
          </motion.p>
        )}

        {selected && (
          <motion.div
            key="selected"
            layout={!reduceMotion}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 340, damping: 28 }}
            className="glass-inset flex items-center gap-3 rounded-2xl px-4 py-3"
          >
            <FileAudio className="h-5 w-5 shrink-0 text-ios-blue" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={selected.name}>
                {selected.name}
              </p>
              <p className="text-xs text-muted">{formatBytes(selected.size)}</p>
            </div>
            <button
              type="button"
              onClick={clearSelection}
              disabled={controlsDisabled}
              aria-label="Remove selected file"
              className="-m-2 shrink-0 cursor-pointer rounded-full p-2 text-muted transition-colors duration-200 hover:bg-black/5 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={submit}
        disabled={!selected || controlsDisabled}
        whileTap={reduceMotion || !selected || controlsDisabled ? undefined : { scale: 0.96 }}
        whileHover={reduceMotion || !selected || controlsDisabled ? undefined : { y: -2 }}
        transition={{ type: 'spring', stiffness: 400, damping: 24 }}
        className={cn(
          'flex min-h-[3rem] cursor-pointer items-center justify-center gap-2 rounded-2xl px-5 py-3',
          'bg-gradient-to-b from-ios-blue to-ios-indigo text-base font-semibold text-white',
          'shadow-lg shadow-ios-blue/25 transition-opacity duration-200',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
        )}
      >
        {busy ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            Transcribing…
          </>
        ) : (
          <>
            <Sparkles className="h-5 w-5" aria-hidden="true" />
            Transcribe file
          </>
        )}
      </motion.button>
    </div>
  )
}
