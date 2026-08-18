import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '../lib/utils'

/**
 * Reusable iOS "clear glass" panel: translucent fill, heavy frosted blur,
 * hairline border and a soft elevated shadow. Animates in on mount.
 */
export default function GlassCard({
  children,
  className,
  delay = 0,
  interactive = false,
  as: Component = motion.section,
  ...rest
}) {
  const reduceMotion = useReducedMotion()

  return (
    <Component
      initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: 'spring', stiffness: 260, damping: 26, mass: 0.9, delay }
      }
      whileHover={interactive && !reduceMotion ? { y: -2 } : undefined}
      className={cn('glass rounded-4xl p-6 sm:p-7', className)}
      {...rest}
    >
      {children}
    </Component>
  )
}
