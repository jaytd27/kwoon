// Message types shared by the main thread and the PDF worker.
//
// All coordinates are in page space as MuPDF reports it: PDF points, origin at
// the top-left of the page as displayed (after rotation), y pointing down.

export type Point = [number, number]
export type Rect = [number, number, number, number]
/** Upper-left, upper-right, lower-left, lower-right corners. */
export type Quad = [number, number, number, number, number, number, number, number]
export type RGB = [number, number, number]

export interface PageInfo {
  /** PDF object number of the page; stable across reordering and undo. */
  id: number
  width: number
  height: number
  rotation: number
  /** Changes whenever the page's rendered content changes. */
  rev: number
  /** The page itself was edited (annotations, text, fields) since opening or the last save. */
  edited: boolean
}

/** The standard PDF fonts text boxes can use: sans, serif and monospace. */
export type TextFont = 'Helv' | 'TiRo' | 'Cour'

export interface AnnotStyle {
  color: RGB
  opacity: number
  /** Stroke width in points; ignored by text markup and notes. */
  width: number
  /** Text boxes only. */
  font?: TextFont
  fontSize?: number
}

/**
 * Image data for the worker: JPEGs pass through as-is (they can't be
 * transparent); anything else arrives decoded so its alpha channel survives.
 */
export type ImagePayload = { jpeg: ArrayBuffer } | { rgba: ArrayBuffer; width: number; height: number }

export type AnnotSpec =
  | { kind: 'highlight' | 'underline' | 'strikeout'; quads: Quad[] }
  | { kind: 'note'; at: Point }
  | { kind: 'rect' | 'ellipse'; rect: Rect }
  | { kind: 'line' | 'arrow'; from: Point; to: Point }
  | { kind: 'ink'; strokes: Point[][] }
  /** A text box with its top-left corner at `at`. */
  | { kind: 'text'; at: Point; text: string }
  | { kind: 'image'; rect: Rect; image: ImagePayload }
  /** Redaction marks: nothing is removed until redactions are applied. */
  | { kind: 'redactText'; quads: Quad[] }
  | { kind: 'redactArea'; rect: Rect }

export interface AnnotInfo {
  /** PDF object number of the annotation. */
  id: number
  type: string
  bounds: Rect
  /** The annotation's Rect, for types that have one (used for resizing). */
  rect: Rect | null
  color: RGB | null
  opacity: number
  /** Null when the annotation has no stroke width to change. */
  width: number | null
  contents: string
  /** Text boxes only. */
  font: TextFont | null
  fontSize: number | null
}

export interface AnnotPatch {
  color?: RGB
  opacity?: number
  width?: number
  /** For text boxes this is the text itself; the box is resized to fit. */
  contents?: string
  font?: TextFont
  fontSize?: number
  /** Moves the annotation by this many points. */
  offset?: Point
  /** Resizes the annotation to this Rect. */
  rect?: Rect
}

export interface WatermarkSpec {
  text: string
  fontSize: number
  color: RGB
  opacity: number
  /** Counter-clockwise, in degrees, as the page is displayed. */
  angle: number
}

export interface DocState {
  pages: PageInfo[]
  canUndo: boolean
  canRedo: boolean
  /** True when there are changes since the file was opened or last saved. */
  dirty: boolean
  /** Redaction marks not yet applied, across the document. */
  redactions: number
  /** Undoable steps taken so far. */
  edits: number
}

/** A word found by OCR, in page space (points, as displayed). */
export interface OcrWord {
  text: string
  /** x0 and x1 bound the word; y0 is the top of its line, y1 the bottom. */
  bbox: Rect
  /** Where the line's baseline crosses this word. */
  baseline: number
}

export interface OcrPage {
  /** Page id. */
  page: number
  words: OcrWord[]
}

/** A line of existing page text, as offered for editing. */
export interface TextLine {
  text: string
  bbox: Rect
  /** Covers the line's glyphs; follows the line's direction. */
  quad: Quad
  /** Baseline origin of the first character. */
  origin: Point
  /** Unit vector along the baseline, in page space. */
  dir: Point
  size: number
  color: RGB
  font: { name: string; family: 'sans' | 'serif' | 'mono'; bold: boolean; italic: boolean }
}

/** How replacement text is written: a standard font, its size in points and its colour. */
export interface TextLineStyle {
  family: TextLine['font']['family']
  bold: boolean
  italic: boolean
  size: number
  color: RGB
}

/** One occurrence of a search term. */
export interface SearchHit {
  /** Page id. */
  page: number
  /** A hit can span lines, so it may take several quads. */
  quads: Quad[]
}

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'signature' | 'button'

/** One widget (the on-page box) of an AcroForm field. */
export interface FieldInfo {
  /** PDF object number of the widget. */
  id: number
  name: string
  kind: FieldKind
  bounds: Rect
  value: string
  /** Checkboxes and radio buttons: whether this widget is on. */
  checked: boolean
  /** Choice fields: export value and display label of each option. */
  options: { value: string; label: string }[]
  multiline: boolean
  password: boolean
  readOnly: boolean
  /** 0 when unlimited. */
  maxLength: number
  /** Font size in points; 0 means "fit to the field". */
  fontSize: number
}

export type FieldChange = { text: string } | { choice: string } | { toggle: true }

export type WorkerRequest =
  | { type: 'open'; data: ArrayBuffer }
  | { type: 'authenticate'; password: string }
  | { type: 'render'; id: number; scale: number }
  | { type: 'save' }
  | { type: 'extract'; pages: number[] }
  | { type: 'rotate'; pages: number[]; degrees: number }
  | { type: 'delete'; pages: number[] }
  | { type: 'move'; pages: number[]; to: number }
  | { type: 'insertPdf'; data: ArrayBuffer; at: number }
  | { type: 'insertBlank'; at: number; width: number; height: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'listAnnots'; page: number }
  | { type: 'textQuads'; page: number; from: Point; to: Point }
  | { type: 'createAnnot'; page: number; spec: AnnotSpec; style: AnnotStyle }
  | { type: 'updateAnnot'; page: number; annot: number; patch: AnnotPatch }
  | { type: 'deleteAnnot'; page: number; annot: number }
  | { type: 'listFields'; page: number }
  | { type: 'setField'; page: number; widget: number; change: FieldChange }
  | { type: 'watermark'; pages: number[]; spec: WatermarkSpec }
  | { type: 'search'; query: string; matchCase: boolean }
  | { type: 'markRedactions'; query: string; matchCase: boolean }
  | { type: 'applyRedactions' }
  | { type: 'textStats' }
  | { type: 'addOcrText'; pages: OcrPage[] }
  | { type: 'textLines'; page: number }
  | { type: 'allAnnots' }
  | { type: 'pageTextChars'; page: number }
  | { type: 'replaceTextLine'; page: number; line: TextLine; text: string; style: TextLineStyle }

export type OpenResult = { needsPassword: true } | ({ needsPassword: false; title: string | null } & DocState)

export interface RenderResult {
  width: number
  height: number
  pixels: Uint8ClampedArray<ArrayBuffer>
}

export interface ResultMap {
  open: OpenResult
  authenticate: OpenResult
  render: RenderResult
  save: Uint8Array<ArrayBuffer>
  extract: Uint8Array<ArrayBuffer>
  rotate: DocState
  delete: DocState
  move: DocState
  insertPdf: DocState
  insertBlank: DocState
  undo: DocState
  redo: DocState
  listAnnots: AnnotInfo[]
  textQuads: Quad[]
  createAnnot: { state: DocState; annot: number }
  updateAnnot: DocState
  deleteAnnot: DocState
  listFields: FieldInfo[]
  setField: DocState
  watermark: DocState
  search: SearchHit[]
  markRedactions: { state: DocState; count: number }
  applyRedactions: DocState
  /** Number of text characters on each page, by page id. */
  textStats: { page: number; chars: number }[]
  addOcrText: DocState
  textLines: TextLine[]
  allAnnots: { page: number; annot: AnnotInfo }[]
  pageTextChars: number
  replaceTextLine: DocState
}

/** Sent once by the worker when MuPDF has loaded and it can take requests. */
export interface WorkerReady {
  ready: true
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  /** `stale`: the request referred to a page that no longer exists. */
  | { id: number; ok: false; error: string; stale: boolean }
