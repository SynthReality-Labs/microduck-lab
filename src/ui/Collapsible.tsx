import { useState, type ReactNode } from 'react'

/**
 * A panel section that can fold away.
 *
 * The studio grew more controls than a first glance can absorb, and a wall of
 * open sections reads as "operate all of this yourself" — the opposite of the
 * point, which is that you can just ask the agent. Everything stays one click
 * away; almost nothing starts unfolded.
 */
export function Collapsible({
  title,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string
  defaultOpen?: boolean
  badge?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`fold ${open ? 'open' : ''}`}>
      <h2>
        <button
          className="fold-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="chev" aria-hidden>{open ? '▾' : '▸'}</span>
          {title}
        </button>
        {badge}
      </h2>
      {open && <div className="fold-body">{children}</div>}
    </section>
  )
}
