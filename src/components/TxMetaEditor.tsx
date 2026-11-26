import { useId, useState } from 'react'
import { cx } from '@/components/ui'
import { CATEGORIES, NOTE_MAX, setTxMeta, type Category, type TxMeta } from '@/lib/txMeta'

const CATEGORY_COLOR: Record<Category, string> = {
  Food: '#f59e0b',
  Bills: '#4f8cff',
  Shopping: '#e879f9',
  Business: '#22d3ee',
  Friends: '#2cf5a6',
  Travel: '#a855f7',
  Other: '#94a3b8',
}

export function CategoryBadge({ category }: { category: Category }) {
  const color = CATEGORY_COLOR[category]
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
      {category}
    </span>
  )
}

/** Choose one category, or tap the chosen one again to clear it. */
export function CategoryChips({ value, onChange, disabled }: { value?: Category; onChange: (next: Category | undefined) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
      {CATEGORIES.map((category) => {
        const selected = value === category
        const color = CATEGORY_COLOR[category]
        return (
          <button
            key={category}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(selected ? undefined : category)}
            className={cx('min-h-9 rounded-full border px-3 text-xs font-semibold transition-all duration-200 active:scale-95 disabled:opacity-50', selected ? 'text-ink' : 'border-line bg-surface-muted text-ink-2 hover:border-line-strong')}
            style={selected ? { borderColor: color, background: `color-mix(in srgb, ${color} 18%, transparent)`, boxShadow: `0 0 14px -4px ${color}` } : undefined}
          >
            {category}
          </button>
        )
      })}
    </div>
  )
}

/** Edits the local note and category of one transaction. Saved in this browser only, against its transaction hash. */
export function TxMetaEditor({ owner, hash, initial, onClose }: { owner: string; hash: string; initial?: TxMeta; onClose: () => void }) {
  const [note, setNote] = useState(initial?.note ?? '')
  const [category, setCategory] = useState<Category | undefined>(initial?.category)
  const id = useId()
  const save = () => {
    setTxMeta(owner, hash, { note, category })
    onClose()
  }
  return (
    <div className="mt-2 space-y-2.5 rounded-2xl border border-line bg-surface-muted p-3">
      <CategoryChips value={category} onChange={setCategory} />
      <div>
        <label htmlFor={id} className="sr-only">
          Note
        </label>
        <input
          id={id}
          value={note}
          maxLength={NOTE_MAX}
          placeholder="Add a short note (optional)"
          autoComplete="off"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && save()}
          className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none placeholder:text-subtle focus:border-accent"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">Saved on this device only. Not sent onchain.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="min-h-9 rounded-xl px-3 text-xs font-semibold text-ink-2 hover:bg-surface">
            Cancel
          </button>
          <button type="button" onClick={save} className="min-h-9 rounded-xl bg-accent px-4 text-xs font-semibold text-accent-ink">
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
