import { useState, type ReactNode } from 'react'
import type { AnnotSelection } from '../annotations/context'
import { MODES, type Mode } from '../annotations/modes'
import { FONTS, FONT_SIZES, OPACITIES, STROKE_TOOLS, WIDTHS, hexToRgb, paletteFor, rgbToHex, type Tool } from '../annotations/tools'
import type { AnnotInfo, AnnotPatch, AnnotStyle, TextFont } from '../pdf/protocol'
import { TYPE_LABELS } from '../format'
import { Icon } from './Icon'
import type { ToolRowActions } from './ToolRow'


const TOOL_LABELS: Partial<Record<Tool, string>> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strike out',
  note: 'Comment',
  text: 'Text box',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  ink: 'Draw',
}

const TOOL_HINTS: Partial<Record<Tool, string>> = {
  highlight: 'Drag across text to highlight it.',
  underline: 'Drag across text to underline it.',
  strikeout: 'Drag across text to strike it out.',
  note: 'Click on the page to place a comment, then type it here.',
  text: 'Click on the page and type. Ctrl+Enter or clicking away finishes; double-click a text box to edit it.',
  rect: 'Drag on the page to draw.',
  ellipse: 'Drag on the page to draw.',
  line: 'Drag on the page to draw.',
  arrow: 'Drag on the page to draw.',
  ink: 'Draw freehand on the page.',
  editText: 'Click a line of text to change it, or clear it to delete the line. The bar above it sets font, size, bold, italic and colour.',
  redactText: 'Drag across text to mark it. Nothing is removed until you apply redactions.',
  redactArea: 'Drag a box over anything, including images. Nothing is removed until you apply redactions.',
}

export interface CommentEntry {
  page: number
  pageIndex: number
  annot: AnnotInfo
}

interface Props {
  mode: Mode
  tool: Tool
  toolStyle: AnnotStyle
  selection: AnnotSelection | null
  busy: boolean
  focusComment: boolean
  comments: CommentEntry[]
  pageSelectionLabel: string
  canDeletePages: boolean
  actions: ToolRowActions
  onToolStyleChange(patch: Partial<AnnotStyle>): void
  onUpdateSelected(patch: AnnotPatch): void
  onDeleteSelected(): void
  onOpenComment(entry: CommentEntry): void
}

export function Inspector(props: Props) {
  return (
    <aside className="kw-sidebar kw-sidebar--inspector inspector" aria-label="Inspector">
      <Properties {...props} />
      <Comments comments={props.comments} selection={props.selection} onOpen={props.onOpenComment} />
      <PageActions {...props} />
    </aside>
  )
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="inspector__section">
      <header className="inspector__header">
        <h2 className="kw-panel__title">{title}</h2>
        {meta && <span className="kw-panel__meta">{meta}</span>}
      </header>
      <div className="inspector__body">{children}</div>
    </section>
  )
}

function Properties(props: Props) {
  const { tool, toolStyle, selection, busy, mode } = props
  const info = selection?.info ?? null

  if (info?.type === 'Redact') {
    return (
      <Section title="Redaction mark" meta="not applied">
        <p className="kw-muted">The content under this mark is removed only when you apply redactions.</p>
        <button className="kw-btn kw-btn--danger kw-btn--sm" onClick={props.onDeleteSelected} disabled={busy}>
          <Icon name="trash" /> Remove mark
        </button>
      </Section>
    )
  }

  // Controls edit the selected annotation if there is one, else the tool's defaults.
  let target: { kind: string; color: string | null; width: number | null; opacity: number; font: TextFont | null; fontSize: number | null } | null = null
  if (info) {
    target = { kind: info.type, color: info.color ? rgbToHex(info.color) : null, width: info.width, opacity: info.opacity, font: info.font, fontSize: info.fontSize }
  } else if (TOOL_LABELS[tool]) {
    target = {
      kind: tool,
      color: rgbToHex(toolStyle.color),
      width: STROKE_TOOLS.has(tool) ? toolStyle.width : null,
      opacity: toolStyle.opacity,
      font: tool === 'text' ? (toolStyle.font ?? 'Helv') : null,
      fontSize: tool === 'text' ? (toolStyle.fontSize ?? 14) : null,
    }
  }

  if (!target) {
    const hint = TOOL_HINTS[tool] ?? MODES.find((m) => m.mode === mode)?.hint
    return (
      <Section title="Properties">
        {hint && <p className="kw-muted">{hint}</p>}
        {tool === 'select' && <p className="kw-muted">Click an annotation to change it here.</p>}
      </Section>
    )
  }

  const change = (patch: Partial<AnnotStyle>) => {
    if (info) props.onUpdateSelected(patch)
    else props.onToolStyleChange(patch)
  }
  const palette = paletteFor(target.kind)
  const title = info ? (TYPE_LABELS[info.type] ?? info.type) : (TOOL_LABELS[tool] ?? 'Properties')

  return (
    <Section title={title} meta={info ? 'selected' : 'new'}>
      {!info && TOOL_HINTS[tool] && <p className="kw-muted">{TOOL_HINTS[tool]}</p>}
      {target.color !== null && (
        <div className="kw-field">
          <span>Colour</span>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {palette.map(({ hex, name }) => (
              <button
                key={hex}
                className="kw-swatch"
                role="radio"
                aria-checked={target.color === hex}
                aria-label={name}
                title={name}
                style={{ background: hex }}
                disabled={busy}
                onClick={() => change({ color: hexToRgb(hex) })}
              />
            ))}
          </div>
        </div>
      )}
      {(target.font !== null || target.fontSize !== null) && (
        <div className="inspector__row">
          {target.font !== null && (
            <label className="kw-field">
              Font
              <select className="kw-select" value={target.font} disabled={busy} onChange={(e) => change({ font: e.target.value as TextFont })} aria-label="Font">
                {FONTS.map((f) => (
                  <option key={f.font} value={f.font}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {target.fontSize !== null && (
            <label className="kw-field">
              Size
              <select
                className="kw-select kw-input--mono"
                value={FONT_SIZES.includes(target.fontSize) ? target.fontSize : ''}
                disabled={busy}
                onChange={(e) => change({ fontSize: Number(e.target.value) })}
                aria-label="Font size"
              >
                {!FONT_SIZES.includes(target.fontSize) && <option value="">{target.fontSize} pt</option>}
                {FONT_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s} pt
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="inspector__row">
        {target.width !== null && (
          <label className="kw-field">
            Stroke
            <select
              className="kw-select kw-input--mono"
              value={WIDTHS.includes(target.width) ? target.width : ''}
              disabled={busy}
              onChange={(e) => change({ width: Number(e.target.value) })}
              aria-label="Stroke width"
            >
              {!WIDTHS.includes(target.width) && <option value="">{target.width} pt</option>}
              {WIDTHS.map((w) => (
                <option key={w} value={w}>
                  {w} pt
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="kw-field">
          Opacity
          <select
            className="kw-select kw-input--mono"
            value={OPACITIES.includes(target.opacity) ? target.opacity : ''}
            disabled={busy}
            onChange={(e) => change({ opacity: Number(e.target.value) })}
            aria-label="Opacity"
          >
            {!OPACITIES.includes(target.opacity) && <option value="">{Math.round(target.opacity * 100)}%</option>}
            {OPACITIES.map((o) => (
              <option key={o} value={o}>
                {Math.round(o * 100)}%
              </option>
            ))}
          </select>
        </label>
      </div>
      {info && selection && info.type === 'FreeText' && <p className="kw-muted">Double-click the text box on the page to edit its text.</p>}
      {info && selection && info.type !== 'FreeText' && (
        <CommentField
          key={`${selection.pageId}:${selection.annotId}`}
          initial={info.contents}
          autoFocus={props.focusComment}
          disabled={busy}
          onCommit={(contents) => props.onUpdateSelected({ contents })}
        />
      )}
      {info && (
        <button className="kw-btn kw-btn--danger kw-btn--sm" onClick={props.onDeleteSelected} disabled={busy} title="Delete (Del)">
          <Icon name="trash" /> Delete {(TYPE_LABELS[info.type] ?? 'annotation').toLowerCase()}
        </button>
      )}
    </Section>
  )
}

function CommentField({ initial, autoFocus, disabled, onCommit }: { initial: string; autoFocus: boolean; disabled: boolean; onCommit(value: string): void }) {
  const [value, setValue] = useState(initial)
  return (
    <label className="kw-field">
      Comment
      <textarea
        className="kw-textarea"
        placeholder="Add a comment…"
        aria-label="Comment"
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        rows={3}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== initial && onCommit(value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur()
          if (e.key === 'Escape') {
            setValue(initial)
            requestAnimationFrame(() => (e.target as HTMLTextAreaElement).blur())
          }
        }}
      />
    </label>
  )
}

function Comments({ comments, selection, onOpen }: { comments: CommentEntry[]; selection: AnnotSelection | null; onOpen(entry: CommentEntry): void }) {
  return (
    <Section title="Comments" meta={comments.length ? `${comments.length}` : undefined}>
      {comments.length === 0 ? (
        <p className="kw-muted">No comments yet. Add one with Comment in Annotate mode, or write one on any annotation.</p>
      ) : (
        <ol className="comment-list">
          {comments.map((entry, i) => {
            const selected = selection?.annotId === entry.annot.id && selection.pageId === entry.page
            return (
              <li key={`${entry.page}:${entry.annot.id}`}>
                <button className={`kw-card kw-comment comment-card ${selected ? 'is-selected' : ''}`} onClick={() => onOpen(entry)}>
                  <span className="kw-comment__head">
                    <span className="kw-pin">{i + 1}</span>
                    <span className="kw-comment__author">{TYPE_LABELS[entry.annot.type] ?? entry.annot.type}</span>
                    <span className="kw-comment__time">p. {entry.pageIndex + 1}</span>
                  </span>
                  <span className={`kw-comment__body ${entry.annot.contents ? '' : 'kw-muted'}`}>{entry.annot.contents || 'No text yet'}</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </Section>
  )
}

function PageActions(props: Props) {
  const { actions, busy } = props
  return (
    <Section title="Pages" meta={props.pageSelectionLabel}>
      <div className="inspector__actions">
        <button className="kw-btn kw-btn--secondary kw-btn--sm" onClick={() => actions.rotate(-90)} disabled={busy}>
          <Icon name="revert" /> Rotate left
        </button>
        <button className="kw-btn kw-btn--secondary kw-btn--sm" onClick={() => actions.rotate(90)} disabled={busy}>
          <Icon name="rotate" /> Rotate right
        </button>
        <button className="kw-btn kw-btn--secondary kw-btn--sm" onClick={actions.extractPages} disabled={busy}>
          <Icon name="extract" /> Extract
        </button>
        <button className="kw-btn kw-btn--secondary kw-btn--sm" onClick={actions.insertPdf} disabled={busy}>
          <Icon name="merge" /> Insert PDF
        </button>
        <button className="kw-btn kw-btn--secondary kw-btn--sm" onClick={actions.insertBlank} disabled={busy}>
          <Icon name="filePlus" /> Blank page
        </button>
        <button className="kw-btn kw-btn--danger kw-btn--sm" onClick={actions.deletePages} disabled={busy || !props.canDeletePages}>
          <Icon name="trash" /> Delete
        </button>
      </div>
    </Section>
  )
}
