import type { Block, Blocks, BlockType, InlineContent } from '@presslabz/blocks'
import { inlineToPlainText } from '@presslabz/blocks'
import type { MessageKey } from '@presslabz/i18n'
import { useState } from 'react'
import { useLocale } from '../lib/i18n.tsx'
import { useMediaLibrary } from '../lib/media.ts'
import { MediaPicker } from './media-picker.tsx'

/**
 * The galley: the reader's own writing, on the only lit surface in the
 * product, set in the only serif. Everything arranged around it — the palette,
 * the inspector, the toolbar — is machine face on the recessed step, so which
 * of the two you are looking at never has to be worked out.
 *
 * Text is plain for now. The block vocabulary already carries inline marks and
 * the renderer already whitelists them, but nothing can produce one yet: that
 * arrives with Tiptap, and installing a document editor to serve a textarea
 * would be the wrong order. The consequence to know about is that editing a
 * block whose text came from elsewhere and carried marks would drop them.
 */

export const BLOCK_LABELS: Record<BlockType, MessageKey> = {
  paragraph: 'block.paragraph',
  heading: 'block.heading',
  quote: 'block.quote',
  list: 'block.list',
  code: 'block.code',
  image: 'block.image',
  divider: 'block.divider',
}

/**
 * What the palette offers. Image is here but handled apart from the rest: a
 * block that must name a media id cannot be created empty, so the palette
 * opens the picker and the block arrives already pointing at something.
 */
export const CREATABLE_BLOCKS = [
  'paragraph',
  'heading',
  'quote',
  'list',
  'code',
  'divider',
] as const satisfies readonly BlockType[]

export function imageBlock(mediaId: string): Block {
  return { id: crypto.randomUUID(), type: 'image', mediaId }
}

const text = (value: string): InlineContent => (value === '' ? [] : [{ type: 'text', text: value }])

export function emptyBlock(type: (typeof CREATABLE_BLOCKS)[number]): Block {
  const id = crypto.randomUUID()

  switch (type) {
    case 'paragraph':
      return { id, type, content: [] }
    case 'heading':
      return { id, type, level: 2, content: [] }
    case 'quote':
      return { id, type, content: [] }
    case 'list':
      return { id, type, ordered: false, items: [[]] }
    case 'code':
      return { id, type, code: '' }
    case 'divider':
      return { id, type }
  }
}

interface BlockEditorProps {
  blocks: Blocks
  selected: string | null
  onSelect: (id: string) => void
  onChange: (blocks: Blocks) => void
}

export function BlockEditor({ blocks, selected, onSelect, onChange }: BlockEditorProps) {
  const { t } = useLocale()

  const replace = (id: string, next: Block) =>
    onChange(blocks.map((block) => (block.id === id ? next : block)))

  const remove = (id: string) => onChange(blocks.filter((block) => block.id !== id))

  const move = (index: number, by: number) => {
    const target = index + by
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(target, 0, moved)
    onChange(next)
  }

  if (blocks.length === 0) {
    return <p className="galley-empty muted">{t('editor.empty')}</p>
  }

  return (
    <>
      {blocks.map((block, index) => (
        <div
          key={block.id}
          className={block.id === selected ? 'blk selected' : 'blk'}
          data-label={t(BLOCK_LABELS[block.type])}
        >
          {/*
            Controls live in the gutter rather than floating over the text. A
            toolbar that covers what you are writing is a toolbar you have to
            work around.
          */}
          <div className="blk-controls">
            <button
              type="button"
              className="quiet tiny"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={t('editor.moveUp')}
            >
              ↑
            </button>
            <button
              type="button"
              className="quiet tiny"
              onClick={() => move(index, 1)}
              disabled={index === blocks.length - 1}
              aria-label={t('editor.moveDown')}
            >
              ↓
            </button>
            <button
              type="button"
              className="quiet tiny"
              onClick={() => remove(block.id)}
              aria-label={t('editor.remove')}
            >
              ✕
            </button>
          </div>

          <BlockBody
            block={block}
            onChange={(next) => replace(block.id, next)}
            onFocus={() => onSelect(block.id)}
          />
        </div>
      ))}
    </>
  )
}

function BlockBody({
  block,
  onChange,
  onFocus,
}: {
  block: Block
  onChange: (block: Block) => void
  onFocus: () => void
}) {
  const { t } = useLocale()

  switch (block.type) {
    case 'paragraph':
      return (
        <Growing
          className="authored blk-paragraph"
          value={inlineToPlainText(block.content)}
          placeholder={t('block.paragraph')}
          onFocus={onFocus}
          onChange={(value) => onChange({ ...block, content: text(value) })}
        />
      )

    case 'heading':
      return (
        <div className="blk-heading">
          <select
            className="data blk-level"
            value={block.level}
            onFocus={onFocus}
            aria-label={t('block.heading')}
            onChange={(event) =>
              onChange({ ...block, level: Number(event.target.value) as 2 | 3 | 4 })
            }
          >
            {[2, 3, 4].map((level) => (
              <option key={level} value={level}>
                H{level}
              </option>
            ))}
          </select>
          <Growing
            className={`authored blk-h${block.level}`}
            value={inlineToPlainText(block.content)}
            placeholder={t('block.heading')}
            onFocus={onFocus}
            onChange={(value) => onChange({ ...block, content: text(value) })}
          />
        </div>
      )

    case 'quote':
      return (
        <div className="blk-quote">
          <Growing
            className="authored"
            value={inlineToPlainText(block.content)}
            placeholder={t('block.quote')}
            onFocus={onFocus}
            onChange={(value) => onChange({ ...block, content: text(value) })}
          />
          <input
            className="data blk-attribution"
            value={block.attribution ?? ''}
            placeholder={t('editor.attribution')}
            onFocus={onFocus}
            onChange={(event) =>
              onChange({
                ...block,
                ...(event.target.value === '' ? {} : { attribution: event.target.value }),
              })
            }
          />
        </div>
      )

    case 'list':
      return (
        <div className="blk-list">
          <label className="blk-ordered">
            <input
              type="checkbox"
              checked={block.ordered}
              onFocus={onFocus}
              onChange={(event) => onChange({ ...block, ordered: event.target.checked })}
            />
            <span>{t('editor.ordered')}</span>
          </label>
          {block.items.map((item, index) => (
            <Growing
              // Items have no identity of their own in the schema, so the
              // index is the only key available. Reordering is not offered
              // here for exactly that reason.
              key={`${block.id}-${index}`}
              className="authored"
              value={inlineToPlainText(item)}
              placeholder={t('editor.itemPlaceholder')}
              onFocus={onFocus}
              onChange={(value) => {
                const items = [...block.items]
                items[index] = text(value)
                onChange({ ...block, items })
              }}
            />
          ))}
          <button
            type="button"
            className="quiet tiny"
            onClick={() => onChange({ ...block, items: [...block.items, []] })}
          >
            +
          </button>
        </div>
      )

    case 'code':
      return (
        <div className="blk-code">
          <input
            className="data blk-lang"
            value={block.language ?? ''}
            placeholder={t('editor.language.hint')}
            onFocus={onFocus}
            onChange={(event) =>
              onChange({
                ...block,
                ...(event.target.value === '' ? {} : { language: event.target.value }),
              })
            }
          />
          <Growing
            className="data"
            value={block.code}
            placeholder={t('block.code')}
            onFocus={onFocus}
            onChange={(value) => onChange({ ...block, code: value })}
          />
        </div>
      )

    case 'image':
      return <ImageBlockBody block={block} onChange={onChange} onFocus={onFocus} />

    case 'divider':
      return <hr />
  }
}

/**
 * A textarea that grows with its content, so a paragraph never gets its own
 * little scrollbar in the middle of the page. Sized on every render rather
 * than on input, because the value also changes when a block moves.
 */
function Growing({
  value,
  onChange,
  onFocus,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  onFocus: () => void
  placeholder: string
  className: string
}) {
  return (
    <textarea
      className={`growing ${className}`}
      value={value}
      rows={1}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(event) => onChange(event.target.value)}
      ref={(node) => {
        if (!node) return
        node.style.height = 'auto'
        node.style.height = `${node.scrollHeight}px`
      }}
    />
  )
}

/**
 * The block stores a reference, never a URL, so the caption belongs to this
 * use of the image while the file and its alt text stay with the media row.
 * Moving a file or fixing its alt does not mean rewriting every document.
 */
function ImageBlockBody({
  block,
  onChange,
  onFocus,
}: {
  block: Extract<Block, { type: 'image' }>
  onChange: (block: Block) => void
  onFocus: () => void
}) {
  const { t, locale } = useLocale()
  const library = useMediaLibrary()
  const [picking, setPicking] = useState(false)

  const media = library.data?.media.find((item) => item.id === block.mediaId)

  return (
    <>
      <figure className="blk-image">
        {media ? (
          <img src={media.url} alt={media.alt[locale] ?? ''} loading="lazy" decoding="async" />
        ) : (
          <p className="muted data">{library.isPending ? '' : t('media.missing')}</p>
        )}

        <Growing
          className="authored blk-caption"
          value={inlineToPlainText(block.caption ?? [])}
          placeholder={t('editor.attribution')}
          onFocus={onFocus}
          onChange={(value) =>
            onChange({ ...block, ...(value === '' ? { caption: [] } : { caption: text(value) }) })
          }
        />

        <button type="button" className="quiet tiny" onClick={() => setPicking(true)}>
          {t('media.replace')}
        </button>
      </figure>

      {/*
        Outside the figure, not inside it. A <figure> holding a hidden library
        of every other image on the site is not what the element means, and it
        makes "the image in this block" impossible to name in a selector.
      */}
      <MediaPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(picked) => {
          onChange({ ...block, mediaId: picked.id })
          setPicking(false)
        }}
      />
    </>
  )
}
