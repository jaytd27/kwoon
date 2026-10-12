import { useEffect, useRef, useState } from 'react'
import { useAnnotations } from '../annotations/context'
import { INKS, hexToRgb, rgbToHex } from '../annotations/tools'
import { pdf } from '../pdf/client'
import type { PageInfo, TextLine, TextLineStyle } from '../pdf/protocol'

const FAMILIES: { family: TextLineStyle['family']; label: string; css: string }[] = [
  { family: 'sans', label: 'Sans', css: 'Helvetica, Arial, sans-serif' },
  { family: 'serif', label: 'Serif', css: "'Times New Roman', Times, serif" },
  { family: 'mono', label: 'Mono', css: "'Courier New', Courier, monospace" },
]

/** Replacement text is written in a standard font with Latin-1 encoding. */
const UNSUPPORTED = /[^ -ÿ]/u

const MIN_SIZE = 1
const MAX_SIZE = 500
/** Room needed above a line for the style bar; nearer the top it goes below. */
const BAR_ROOM = 48

interface Props {
  page: PageInfo
  /** CSS pixels per PDF point. */
  scale: number
}

function styleOf(line: TextLine): TextLineStyle {
  const { family, bold, italic } = line.font
  return { family, bold, italic, size: Math.round(line.size * 10) / 10, color: line.color }
}

const luminance = ([r, g, b]: TextLineStyle['color']) => 0.2126 * r + 0.7152 * g + 0.0722 * b

const sameStyle =(a: TextLineStyle, b: TextLineStyle) =>
  a.family === b.family && a.bold === b.bold && a.italic === b.italic && a.size === b.size && rgbToHex(a.color) === rgbToHex(b.color)

/** Outlines the lines of existing page text and lets you edit one in place. */
export function TextEditLayer({ page, scale }: Props) {
  const ctx = useAnnotations()
  const [lines, setLines] = useState<TextLine[]>([])
  const [editing, setEditing] = useState<TextLine | null>(null)

  useEffect(() => {
    let live = true
    pdf.textLines(page.id).then(
      (list) => {
        if (live) setLines(list)
      },
      (err) => {
        if (err?.name !== 'AbortError') console.error('Failed to load text lines', err)
      },
    )
    return () => {
      live = false
    }
  }, [page.id, page.rev])

  return (
    <div className="text-edit-layer">
      {lines.map((line, i) => {
        if (line === editing) return null
        const [x0, y0, x1, y1] = line.bbox
        return (
          <button
            key={i}
            className="text-line"
            style={{ left: x0 * scale, top: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale }}
            title="Click to edit this text"
            aria-label={`Edit text: ${line.text}`}
            disabled={ctx.busy}
            onClick={() => setEditing(line)}
          />
        )
      })}
      {editing && (
        <LineEditor
          key={editing.text + editing.bbox.join()}
          line={editing}
          scale={scale}
          onDone={(result) => {
            setEditing(null)
            if (result && (result.text !== editing.text || !sameStyle(result.style, styleOf(editing)))) {
              ctx.editTextLine(page.id, editing, result.text, result.style)
            }
          }}
        />
      )}
    </div>
  )
}

interface LineEditorProps {
  line: TextLine
  scale: number
  /** Null when the edit was cancelled. */
  onDone(result: { text: string; style: TextLineStyle } | null): void
}

function LineEditor({ line, scale, onDone }: LineEditorProps) {
  const [text, setText] = useState(line.text)
  const [style, setStyle] = useState(() => styleOf(line))
  const [sizeText, setSizeText] = useState(String(styleOf(line).size))
  const done = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const unsupported = UNSUPPORTED.test(text)
  const [x0, y0, x1] = line.bbox
  // Rotated lines are edited horizontally next to where they are.
  const angle = (Math.atan2(line.dir[1], line.dir[0]) * 180) / Math.PI
  const color = rgbToHex(style.color)
  const original = rgbToHex(line.color)
  // The line's own colour is offered alongside the inks when it isn't one of them.
  const swatches = INKS.some((ink) => ink.hex === original) ? INKS : [{ hex: original, name: 'Original colour' }, ...INKS]

  const finish = (commit: boolean) => {
    if (done.current) return
    if (commit && UNSUPPORTED.test(text)) return
    done.current = true
    onDone(commit ? { text, style } : null)
  }

  const change = (patch: Partial<TextLineStyle>) => setStyle((s) => ({ ...s, ...patch }))

  const changeSize = (value: string) => {
    setSizeText(value)
    const size = Number(value)
    if (Number.isFinite(size) && size >= MIN_SIZE && size <= MAX_SIZE) change({ size })
  }

  return (
    <div
      className="line-editor"
      style={{ left: x0 * scale, top: y0 * scale }}
      onBlur={(e) => {
        // Moving between the text and the style bar keeps editing; leaving both commits.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) finish(!unsupported)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
    >
      <div
        className={`kw-float line-editor__bar${y0 * scale < BAR_ROOM ? ' line-editor__bar--below' : ''}`}
        role="toolbar"
        aria-label="Text style"
        // Clicking a button would otherwise take focus from the text (or drop it, in Safari).
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) e.preventDefault()
        }}
      >
        <select
          className="line-editor__font"
          value={style.family}
          aria-label="Font"
          onChange={(e) => {
            change({ family: e.target.value as TextLineStyle['family'] })
            input.current?.focus()
          }}
        >
          {FAMILIES.map((f) => (
            <option key={f.family} value={f.family}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="line-editor__size" title="Font size in points">
          <input
            type="number"
            min={MIN_SIZE}
            max={MAX_SIZE}
            step={0.5}
            value={sizeText}
            aria-label="Font size"
            onChange={(e) => changeSize(e.target.value)}
            onBlur={() => setSizeText(String(style.size))}
          />
          pt
        </label>
        <span className="kw-float__sep" />
        <button className="kw-float__btn line-editor__bold" aria-pressed={style.bold} aria-label="Bold" title="Bold" onClick={() => change({ bold: !style.bold })}>
          B
        </button>
        <button className="kw-float__btn line-editor__italic" aria-pressed={style.italic} aria-label="Italic" title="Italic" onClick={() => change({ italic: !style.italic })}>
          I
        </button>
        <span className="kw-float__sep" />
        <div className="line-editor__swatches" role="radiogroup" aria-label="Colour">
          {swatches.map(({ hex, name }) => (
            <button
              key={hex}
              className="kw-swatch line-editor__swatch"
              role="radio"
              aria-checked={color === hex}
              aria-label={name}
              title={name}
              style={{ background: hex }}
              onClick={() => change({ color: hexToRgb(hex) })}
            />
          ))}
        </div>
      </div>
      <input
        ref={input}
        autoFocus
        className={`line-editor__text${luminance(style.color) > 0.7 ? ' line-editor__text--light' : ''}`}
        value={text}
        aria-label="Edit text"
        spellCheck={false}
        style={{
          minWidth: (x1 - x0) * scale,
          width: `${Math.max(text.length, 1) + 2}ch`,
          transform: Math.abs(angle) > 1 ? `rotate(${angle}deg)` : undefined,
          fontFamily: FAMILIES.find((f) => f.family === style.family)!.css,
          fontWeight: style.bold ? 700 : 400,
          fontStyle: style.italic ? 'italic' : 'normal',
          fontSize: style.size * scale,
          color,
        }}
        onChange={(e) => setText(e.target.value)}
      />
      {unsupported && <span className="line-editor__warning">Only Latin letters and symbols can be typed into existing text.</span>}
    </div>
  )
}
