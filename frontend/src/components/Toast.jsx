import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '../lib/utils'

const TONE = {
  success: {
    Icon: CheckCircle2,
    accent: 'text-ios-green',
    ring: 'ring-ios-green/30',
  },
  error: {
    Icon: AlertTriangle,
    accent: 'text-ios-red',
    ring: 'ring-ios-red/30',
  },
  info: {
    Icon: Info,
    accent: 'text-ios-blue',
    ring: 'ring-ios-blue/30',
  },
}

/**
 * Stack of glassmorphic notification badges, bottom-centre on mobile and
 * top-right on larger screens. Announced politely to screen readers.
 */
export default function Toast({ toasts, onDismiss }) {
  const reduceMotion = useReducedMotion()

  return (
    <div
      className="pointer-events-none fixed inset-x-4 bottom-6 z-toast flex flex-col items-center gap-2.5 sm:inset-x-auto sm:bottom-auto sm:right-6 sm:top-6 sm:items-end"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const { Icon, accent, ring } = TONE[toast.tone] ?? TONE.info
          return (
            <motion.div
              key={toast.id}
              layout={!reduceMotion}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.94 }}
              transition={
                reduceMotion
                  ? { duration: 0.12 }
                  : { type: 'spring', stiffness: 420, damping: 32 }
              }
              className={cn(
                'glass pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl px-4 py-3 ring-1',
                ring,
              )}
            >
              <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', accent)} aria-hidden="true" />
              <p className="min-w-0 flex-1 text-sm font-medium leading-snug">{toast.message}</p>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                aria-label="Dismiss notification"
                className="-m-1.5 shrink-0 cursor-pointer rounded-full p-1.5 text-muted transition-colors duration-200 hover:bg-black/5 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
