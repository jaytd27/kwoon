// Runs MuPDF off the main thread. Owns the open document; the UI talks to it
// through the request/response protocol in ./protocol.ts.

import * as mupdf from 'mupdf'
import type {
  AnnotInfo,
  AnnotPatch,
  AnnotSpec,
  AnnotStyle,
  DocState,
  FieldChange,
  FieldInfo,
  FieldKind,
  OcrPage,
  OpenResult,
  PageInfo,
  Point,
  Quad,
  RenderResult,
  ImagePayload,
  RGB,
  SearchHit,
  TextFont,
  TextLine,
  TextLineStyle,
  WatermarkSpec,
  WorkerReady,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

/** Thrown for requests that refer to something that no longer exists. */
class StaleError extends Error {}

let doc: mupdf.PDFDocument | null = null
let journalEnabled = false
/** Journal position of the last save; -1 when it can't be reached by undo/redo. */
let savedPosition = 0
const pageCache = new Map<number, mupdf.PDFPage>()
let idToIndex = new Map<number, number>()
/** Per-page content revisions keyed by page id, plus one for whole-document changes. */
const pageRevs = new Map<number, number>()
let docRev = 0
/** Pages edited since opening or the last save, by id (for the thumbnail dot). */
const editedPages = new Set<number>()
/** Extracted text per page id, for hit-testing text selections. */
const textCache = new Map<number, mupdf.StructuredText>()

function requireDoc(): mupdf.PDFDocument {
  if (!doc) throw new Error('No document is open')
  return doc
}

function clearPageCache() {
  for (const page of pageCache.values()) page.destroy()
  pageCache.clear()
}

function clearTextCache() {
  for (const text of textCache.values()) text.destroy()
  textCache.clear()
}

function closeDocument() {
  clearPageCache()
  clearTextCache()
  pageRevs.clear()
  editedPages.clear()
  idToIndex.clear()
  doc?.destroy()
  doc = null
  journalEnabled = false
}

function loadPage(index: number): mupdf.PDFPage {
  let page = pageCache.get(index)
  if (!page) {
    page = requireDoc().loadPage(index)
    pageCache.set(index, page)
  }
  return page
}

function journalPosition(): number {
  return journalEnabled ? requireDoc().getJournal().position : 0
}

function state(): DocState {
  const d = requireDoc()
  const pages: PageInfo[] = []
  let redactions = 0
  idToIndex = new Map()
  for (let i = 0; i < d.countPages(); i++) {
    const page = loadPage(i)
    const obj = page.getObject()
    // Count redaction marks from the raw /Annots array; cheaper than loading annotations.
    obj.get('Annots').forEach((annot) => {
      if (annot.get('Subtype').asName() === 'Redact') redactions++
    })
    const [x0, y0, x1, y1] = page.getBounds()
    const rotate = obj.getInheritable('Rotate')
    const id = obj.asIndirect()
    idToIndex.set(id, i)
    pages.push({
      id,
      width: x1 - x0,
      height: y1 - y0,
      rotation: rotate.isNumber() ? rotate.asNumber() : 0,
      rev: docRev + (pageRevs.get(id) ?? 0),
      edited: editedPages.has(id),
    })
  }
  return {
    pages,
    canUndo: journalEnabled && d.canUndo(),
    canRedo: journalEnabled && d.canRedo(),
    dirty: journalPosition() !== savedPosition,
    redactions,
    edits: journalPosition(),
  }
}

function describe(): OpenResult {
  const d = requireDoc()
  if (d.needsPassword()) return { needsPassword: true }
  if (!journalEnabled) {
    d.enableJournal()
    journalEnabled = true
    savedPosition = journalPosition()
  }
  return { needsPassword: false, title: d.getMetaData(mupdf.Document.META_INFO_TITLE) || null, ...state() }
}

function openPdf(data: ArrayBuffer): mupdf.PDFDocument {
  const opened = mupdf.Document.openDocument(data, 'application/pdf')
  const pdf = opened.asPDF()
  if (!pdf) {
    opened.destroy()
    throw new Error('This file is not a PDF')
  }
  return pdf
}

function open(data: ArrayBuffer): OpenResult {
  // Keep the current document until the new one has loaded, so a bad file
  // doesn't break what's already on screen.
  const pdf = openPdf(data)
  closeDocument()
  doc = pdf
  return describe()
}

function authenticate(password: string): OpenResult {
  if (!requireDoc().authenticatePassword(password)) throw new Error('Incorrect password')
  return describe()
}

/**
 * What a change can affect: one page's look (a page id), every page's look
 * but no text ('appearance', e.g. form fields that span pages), or anything
 * ('document', the default).
 */
type ChangeScope = number | 'appearance' | 'document'

/** Runs `fn` as one undoable step and returns the new document state. */
function mutate(name: string, fn: (d: mupdf.PDFDocument) => void, scope: ChangeScope = 'document'): DocState {
  const d = requireDoc()
  // A new step after undoing past the save point discards that save point.
  if (d.getJournal().position < savedPosition) savedPosition = -1
  d.beginOperation(name)
  try {
    fn(d)
    d.endOperation()
  } catch (err) {
    d.abandonOperation()
    throw err
  } finally {
    clearPageCache()
    if (typeof scope === 'number') {
      pageRevs.set(scope, (pageRevs.get(scope) ?? 0) + 1)
      editedPages.add(scope)
    } else {
      if (scope === 'document') clearTextCache()
      docRev++
    }
  }
  return state()
}

function indexOf(id: number): number {
  const index = idToIndex.get(id)
  if (index === undefined) throw new StaleError(`Page ${id} no longer exists`)
  return index
}

function render(id: number, scale: number): RenderResult {
  const page = pageById(id)
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  try {
    const width = pixmap.getWidth()
    const height = pixmap.getHeight()
    const stride = pixmap.getStride()
    const rgb = pixmap.getPixels()
    // Canvas ImageData wants RGBA; MuPDF gives us opaque RGB rows.
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      let src = y * stride
      let dst = y * width * 4
      for (let x = 0; x < width; x++) {
        rgba[dst++] = rgb[src++]
        rgba[dst++] = rgb[src++]
        rgba[dst++] = rgb[src++]
        rgba[dst++] = 255
      }
    }
    return { width, height, pixels: rgba }
  } finally {
    pixmap.destroy()
  }
}

function toTransferable(buffer: mupdf.Buffer): Uint8Array<ArrayBuffer> {
  try {
    // Copy out of WASM memory so the result can be transferred.
    return new Uint8Array(buffer.asUint8Array())
  } finally {
    buffer.destroy()
  }
}

function save(): Uint8Array<ArrayBuffer> {
  repairForExport()
  const bytes = toTransferable(requireDoc().saveToBuffer('garbage,compress'))
  savedPosition = journalPosition()
  editedPages.clear()
  return bytes
}

function extract(indices: number[]): Uint8Array<ArrayBuffer> {
  const d = requireDoc()
  const out = new mupdf.PDFDocument()
  try {
    const map = out.newGraftMap()
    for (const index of indices) map.graftPage(-1, d, index)
    return toTransferable(out.saveToBuffer('garbage,compress'))
  } finally {
    out.destroy()
  }
}

function rotate(indices: number[], degrees: number): DocState {
  return mutate('Rotate pages', (d) => {
    for (const index of indices) {
      const obj = d.findPage(index)
      const current = obj.getInheritable('Rotate')
      const value = ((((current.isNumber() ? current.asNumber() : 0) + degrees) % 360) + 360) % 360
      obj.put('Rotate', value)
    }
  })
}

function deletePages(indices: number[]): DocState {
  const d = requireDoc()
  const remove = new Set(indices)
  if (remove.size >= d.countPages()) throw new Error('A PDF needs at least one page')
  return mutate('Delete pages', (d) => {
    const keep: number[] = []
    for (let i = 0; i < d.countPages(); i++) if (!remove.has(i)) keep.push(i)
    d.rearrangePages(keep)
  })
}

/** Moves `indices` so they sit together before the page currently at `to`. */
function move(indices: number[], to: number): DocState {
  return mutate('Move pages', (d) => {
    const moving = new Set(indices)
    const rest: number[] = []
    let insertAt = 0
    for (let i = 0; i < d.countPages(); i++) {
      if (moving.has(i)) continue
      if (i < to) insertAt++
      rest.push(i)
    }
    const sortedMoving = [...moving].sort((a, b) => a - b)
    d.rearrangePages([...rest.slice(0, insertAt), ...sortedMoving, ...rest.slice(insertAt)])
  })
}

function insertPdf(data: ArrayBuffer, at: number): DocState {
  const src = openPdf(data)
  try {
    if (src.needsPassword()) throw new Error('Password-protected PDFs can’t be inserted yet')
    return mutate('Insert pages', () => {
      const map = requireDoc().newGraftMap()
      for (let i = 0; i < src.countPages(); i++) map.graftPage(at + i, src, i)
    })
  } finally {
    src.destroy()
  }
}

function insertBlank(at: number, width: number, height: number): DocState {
  return mutate('Insert blank page', (d) => {
    d.insertPage(at, d.addPage([0, 0, width, height], 0, {}, ''))
  })
}

// ---------- Annotations ----------

const ANNOT_TYPES: Record<AnnotSpec['kind'], mupdf.PDFAnnotationType> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  note: 'Text',
  rect: 'Square',
  ellipse: 'Circle',
  line: 'Line',
  arrow: 'Line',
  ink: 'Ink',
  text: 'FreeText',
  image: 'Stamp',
  redactText: 'Redact',
  redactArea: 'Redact',
}

/** Not listed for editing: popups belong to their parent, links and form fields are separate features. */
const HIDDEN_TYPES = new Set<string>(['Popup', 'Link', 'Widget'])

const TEXT_FONTS: Record<TextFont, string> = { Helv: 'Helvetica', TiRo: 'Times-Roman', Cour: 'Courier' }
const DEFAULT_FONT_SIZE = 14
/** Padding MuPDF leaves around text inside a text box, in points. */
const TEXT_PADDING = 4
const metricFonts = new Map<string, mupdf.Font>()

function toTextFont(name: string): TextFont {
  return name in TEXT_FONTS ? (name as TextFont) : 'Helv'
}

/** Width of `text` in points in one of the 14 standard PDF fonts, from its glyph metrics. */
function standardTextWidth(fontName: string, size: number, text: string): number {
  let metrics = metricFonts.get(fontName)
  if (!metrics) {
    metrics = new mupdf.Font(fontName)
    metricFonts.set(fontName, metrics)
  }
  let width = 0
  for (const ch of text) width += metrics.advanceGlyph(metrics.encodeCharacter(ch))
  return width * size
}

function textWidth(font: TextFont, size: number, text: string): number {
  return standardTextWidth(TEXT_FONTS[font], size, text)
}

/** Sizes a text box to fit its text, keeping its top-left corner at `origin`. */
function fitTextBox(annot: mupdf.PDFAnnotation, text: string, font: TextFont, size: number, [x, y]: Point) {
  const lines = text.split('\n')
  const width = Math.max(...lines.map((line) => textWidth(font, size, line)), size)
  annot.setRect([x, y, x + width + TEXT_PADDING * 2, y + lines.length * size * 1.2 + TEXT_PADDING * 2])
}

function toRGB(color: mupdf.AnnotColor): RGB | null {
  switch (color.length) {
    case 1:
      return [color[0], color[0], color[0]]
    case 3:
      return [color[0], color[1], color[2]]
    case 4: {
      const [c, m, y, k] = color
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
    }
    default:
      return null
  }
}

function pageById(id: number): mupdf.PDFPage {
  return loadPage(indexOf(id))
}

function findAnnot(page: mupdf.PDFPage, id: number): mupdf.PDFAnnotation {
  const annot = page.getAnnotations().find((a) => a.getObject().asIndirect() === id)
  if (!annot) throw new StaleError(`Annotation ${id} no longer exists`)
  return annot
}

function describeAnnot(annot: mupdf.PDFAnnotation): AnnotInfo {
  const type = annot.getType()
  const info: AnnotInfo = {
    id: annot.getObject().asIndirect(),
    type,
    bounds: annot.getBounds(),
    rect: annot.hasRect() ? annot.getRect() : null,
    color: toRGB(annot.getColor()),
    opacity: annot.getOpacity(),
    width: annot.hasBorder() && type !== 'Text' && type !== 'FreeText' ? annot.getBorderWidth() : null,
    contents: annot.getContents(),
    font: null,
    fontSize: null,
  }
  if (type === 'FreeText') {
    // A text box's text color lives in its default appearance, not /C.
    const da = annot.getDefaultAppearance()
    info.color = toRGB(da.color) ?? [0, 0, 0]
    info.font = toTextFont(da.font)
    info.fontSize = da.size || DEFAULT_FONT_SIZE
  }
  if (type === 'Stamp' || type === 'Redact') info.color = null
  return info
}

function listAnnots(pageId: number): AnnotInfo[] {
  return pageById(pageId)
    .getAnnotations()
    .filter((a) => !HIDDEN_TYPES.has(a.getType()))
    .map(describeAnnot)
}

function pageText(pageId: number): mupdf.StructuredText {
  let text = textCache.get(pageId)
  if (!text) {
    text = pageById(pageId).toStructuredText('preserve-whitespace')
    textCache.set(pageId, text)
  }
  return text
}

function allAnnots(): { page: number; annot: AnnotInfo }[] {
  const d = requireDoc()
  const out: { page: number; annot: AnnotInfo }[] = []
  for (let i = 0; i < d.countPages(); i++) {
    const page = loadPage(i)
    const id = page.getObject().asIndirect()
    for (const annot of page.getAnnotations()) {
      if (!HIDDEN_TYPES.has(annot.getType())) out.push({ page: id, annot: describeAnnot(annot) })
    }
  }
  return out
}

function pageTextChars(pageId: number): number {
  return pageText(pageId).asText().replace(/\s/g, '').length
}

function textQuads(pageId: number, from: Point, to: Point): Quad[] {
  return pageText(pageId).highlight(from, to) as Quad[]
}

/** MuPDF.js returns at most this many quads per page from one search. */
const MAX_SEARCH_QUADS = 500

/** Every occurrence of `query` in the document. */
function search(query: string, matchCase: boolean): SearchHit[] {
  const needle = query.trim()
  if (!needle) return []
  const hits: SearchHit[] = []
  const d = requireDoc()
  for (let i = 0; i < d.countPages(); i++) {
    const id = loadPage(i).getObject().asIndirect()
    const found = pageText(id).search(needle, matchCase ? null : 'ignore-case') as Quad[][]
    // Hitting the cap means matches were dropped; for redaction that must not pass silently.
    if (found.reduce((n, quads) => n + quads.length, 0) >= MAX_SEARCH_QUADS) {
      throw new Error(`Too many matches on page ${i + 1} to list them all; try a longer search`)
    }
    for (const quads of found) hits.push({ page: id, quads })
  }
  return hits
}

function normalizeRect([x0, y0, x1, y1]: mupdf.Rect): mupdf.Rect {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

/**
 * Fixes things MuPDF writes that stricter readers (notably Adobe Acrobat)
 * reject or misdraw, and returns whether anything needed fixing. With
 * `apply` false it only checks.
 *
 * - Image soft masks must use DeviceGray (ISO 32000 §11.6.5.3); MuPDF gives
 *   them an ICC-based gray profile, and Acrobat then reports "an error
 *   exists on this page" and drops the image.
 * - New text boxes get a callout line from the page corner (/CL) that
 *   nobody asked for; it only belongs on callout-style text boxes.
 * - setIntent('StampImage') writes /IT null instead of a name.
 */
function makePortable(annot: mupdf.PDFAnnotation, apply = true): boolean {
  const d = requireDoc()
  const obj = annot.getObject()
  let needed = false
  const fix = (action: () => void) => {
    needed = true
    if (apply) action()
  }
  const type = annot.getType()
  if (type === 'FreeText' && !obj.get('CL').isNull() && obj.get('IT').asName() !== 'FreeTextCallout') {
    fix(() => obj.delete('CL'))
  }
  if (type === 'Stamp') {
    const xobjects = obj.get('AP').get('N').get('Resources').get('XObject')
    // (PDFObject.length counts array items only, so count dictionary entries.)
    let images = 0
    if (xobjects.isDictionary()) xobjects.forEach(() => images++)
    const isImage = images > 0
    const intent = obj.get('IT')
    if (!intent.isNull() && !intent.isName()) fix(() => obj.delete('IT'))
    if (isImage && !(intent.isName() && intent.asName() === 'StampImage')) fix(() => obj.put('IT', d.newName('StampImage')))
    if (isImage) {
      xobjects.forEach((image) => {
        const mask = image.get('SMask')
        if (!mask.isNull() && mask.get('ColorSpace').asName() !== 'DeviceGray') fix(() => mask.put('ColorSpace', d.newName('DeviceGray')))
      })
    }
  }
  return needed
}

/** Runs makePortable over every annotation (e.g. ones made by older Kwoon versions) before export. */
function repairForExport() {
  const d = requireDoc()
  const annots: mupdf.PDFAnnotation[] = []
  for (let i = 0; i < d.countPages(); i++) annots.push(...loadPage(i).getAnnotations())
  if (!annots.some((a) => makePortable(a, false))) return
  d.beginOperation('Prepare for export')
  try {
    for (const annot of annots) makePortable(annot)
    d.endOperation()
  } catch (err) {
    d.abandonOperation()
    throw err
  } finally {
    clearPageCache()
  }
}

/** Builds an image, keeping transparency as a separate soft mask. */
function buildImage(payload: ImagePayload): mupdf.Image {
  if ('jpeg' in payload) return new mupdf.Image(payload.jpeg)
  const { width, height } = payload
  const rgba = new Uint8ClampedArray(payload.rgba)
  const bbox: mupdf.Rect = [0, 0, width, height]
  const color = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false)
  const alpha = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, bbox, false)
  const colorPixels = color.getPixels()
  const alphaPixels = alpha.getPixels()
  const colorStride = color.getStride()
  const alphaStride = alpha.getStride()
  let opaque = true
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4
      const dst = y * colorStride + x * 3
      colorPixels[dst] = rgba[src]
      colorPixels[dst + 1] = rgba[src + 1]
      colorPixels[dst + 2] = rgba[src + 2]
      alphaPixels[y * alphaStride + x] = rgba[src + 3]
      if (rgba[src + 3] !== 255) opaque = false
    }
  }
  if (opaque) {
    alpha.destroy()
    return new mupdf.Image(color)
  }
  return new mupdf.Image(color, new mupdf.Image(alpha))
}

function createAnnot(pageId: number, spec: AnnotSpec, style: AnnotStyle): { state: DocState; annot: number } {
  let created = 0
  const state = mutate(
    'Add annotation',
    () => {
      const annot = pageById(pageId).createAnnotation(ANNOT_TYPES[spec.kind])
      annot.setOpacity(style.opacity)
      switch (spec.kind) {
        case 'highlight':
        case 'underline':
        case 'strikeout':
          annot.setColor(style.color)
          annot.setQuadPoints(spec.quads)
          break
        case 'note': {
          const [x, y] = spec.at
          annot.setColor(style.color)
          annot.setRect([x - 10, y - 10, x + 10, y + 10])
          annot.setIcon('Comment')
          break
        }
        case 'rect':
        case 'ellipse':
          annot.setColor(style.color)
          annot.setRect(normalizeRect(spec.rect))
          annot.setBorderWidth(style.width)
          break
        case 'line':
        case 'arrow':
          annot.setColor(style.color)
          annot.setLine(spec.from, spec.to)
          annot.setBorderWidth(style.width)
          if (spec.kind === 'arrow') {
            annot.setLineEndingStyles('None', 'ClosedArrow')
            annot.setInteriorColor(style.color)
          }
          break
        case 'ink':
          annot.setColor(style.color)
          annot.setInkList(spec.strokes)
          annot.setBorderWidth(style.width)
          break
        case 'text': {
          const font = style.font ?? 'Helv'
          const size = style.fontSize ?? DEFAULT_FONT_SIZE
          annot.setDefaultAppearance(font, size, style.color)
          annot.setContents(spec.text)
          fitTextBox(annot, spec.text, font, size, spec.at)
          break
        }
        case 'redactText':
          annot.setQuadPoints(spec.quads)
          break
        case 'redactArea':
          annot.setRect(normalizeRect(spec.rect))
          break
        case 'image': {
          const image = buildImage(spec.image)
          try {
            annot.setRect(normalizeRect(spec.rect))
            annot.setStampImage(image)
          } finally {
            image.destroy()
          }
          break
        }
      }
      annot.update()
      makePortable(annot)
      created = annot.getObject().asIndirect()
    },
    pageId,
  )
  return { state, annot: created }
}

function moveAnnot(annot: mupdf.PDFAnnotation, [dx, dy]: Point) {
  const shift = ([x, y]: mupdf.Point): mupdf.Point => [x + dx, y + dy]
  if (annot.hasInkList()) {
    annot.setInkList(annot.getInkList().map((stroke) => stroke.map(shift)))
  } else if (annot.hasLine()) {
    const [a, b] = annot.getLine()
    annot.setLine(shift(a), shift(b))
  } else if (annot.hasQuadPoints()) {
    annot.setQuadPoints(annot.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)) as mupdf.Quad))
  } else if (annot.hasVertices()) {
    annot.setVertices(annot.getVertices().map(shift))
  } else if (annot.hasRect()) {
    const [x0, y0, x1, y1] = annot.getRect()
    annot.setRect([x0 + dx, y0 + dy, x1 + dx, y1 + dy])
  }
}

function updateAnnot(pageId: number, annotId: number, patch: AnnotPatch): DocState {
  return mutate(
    'Edit annotation',
    () => {
      const annot = findAnnot(pageById(pageId), annotId)
      if (annot.getType() === 'FreeText') {
        const da = annot.getDefaultAppearance()
        const font = patch.font ?? toTextFont(da.font)
        const size = patch.fontSize ?? (da.size || DEFAULT_FONT_SIZE)
        if (patch.color || patch.font || patch.fontSize) annot.setDefaultAppearance(font, size, patch.color ?? da.color)
        if (patch.contents !== undefined) annot.setContents(patch.contents)
        if (patch.contents !== undefined || patch.font || patch.fontSize) {
          const [x, y] = annot.getRect()
          fitTextBox(annot, annot.getContents(), font, size, [x, y])
        }
      } else {
        if (patch.color) {
          annot.setColor(patch.color)
          if (annot.hasLine() && annot.getLineEndingStyles().end !== 'None') annot.setInteriorColor(patch.color)
        }
        if (patch.contents !== undefined) annot.setContents(patch.contents)
      }
      if (patch.opacity !== undefined) annot.setOpacity(patch.opacity)
      if (patch.width !== undefined && annot.hasBorder()) annot.setBorderWidth(patch.width)
      if (patch.offset) moveAnnot(annot, patch.offset)
      if (patch.rect && annot.hasRect()) annot.setRect(normalizeRect(patch.rect))
      annot.update()
      makePortable(annot)
    },
    pageId,
  )
}

function deleteAnnot(pageId: number, annotId: number): DocState {
  return mutate(
    'Delete annotation',
    () => {
      const page = pageById(pageId)
      page.deleteAnnotation(findAnnot(page, annotId))
    },
    pageId,
  )
}

// ---------- Redaction ----------

/** Marks every occurrence of `query` for redaction, as one undoable step. */
function markRedactions(query: string, matchCase: boolean): { state: DocState; count: number } {
  const hits = search(query, matchCase)
  if (!hits.length) return { state: state(), count: 0 }
  const docState = mutate(
    'Mark for redaction',
    () => {
      for (const hit of hits) {
        const annot = pageById(hit.page).createAnnotation('Redact')
        annot.setQuadPoints(hit.quads)
        annot.update()
      }
    },
    'appearance',
  )
  return { state: docState, count: hits.length }
}

function overlaps([a0, a1, a2, a3]: mupdf.Rect, [b0, b1, b2, b3]: mupdf.Rect) {
  return a0 < b2 && b0 < a2 && a1 < b3 && b1 < a3
}

/**
 * Permanently removes everything under each redaction mark: text, the
 * covered pixels of images, vector graphics that lie entirely inside a mark,
 * and any annotation or form field that overlaps one; then fills the areas
 * black. Saving writes a fresh file, so nothing removed survives in it.
 */
function applyRedactions(): DocState {
  return mutate('Apply redactions', (d) => {
    for (let i = 0; i < d.countPages(); i++) {
      const page = loadPage(i)
      const annots = [...page.getAnnotations()]
      const marks = annots.filter((a) => a.getType() === 'Redact').map((a) => a.getBounds())
      if (!marks.length) continue
      const underMark = (a: mupdf.PDFAnnotation) => marks.some((m) => overlaps(m, a.getBounds()))

      // MuPDF's redaction leaves some annotation types (e.g. notes) and form
      // fields in place, so remove whatever overlaps a mark ourselves.
      for (const annot of annots) {
        if (annot.getType() !== 'Redact' && annot.getType() !== 'Popup' && underMark(annot)) page.deleteAnnotation(annot)
      }
      for (const widget of [...page.getWidgets()].filter(underMark)) {
        // Clear the value first: the field dictionary can outlive its widget.
        if (widget.isText()) widget.setTextValue('')
        else if (widget.isChoice()) clearChoice(widget)
        page.deleteAnnotation(widget)
      }

      page.applyRedactions(
        true,
        mupdf.PDFPage.REDACT_IMAGE_PIXELS,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      )
    }
  })
}

/** Removes a choice field's value (MuPDF has no direct call for it). */
function clearChoice(widget: mupdf.PDFWidget) {
  // The value may sit on the widget or be inherited from a parent field.
  for (let field = widget.getObject(); !field.isNull(); field = field.get('Parent')) field.delete('V')
}

// ---------- Writing page content (watermarks, OCR text) ----------

/** Returns `base`, or `base` with a number added, that isn't yet a key of `dict`. */
function unusedKey(dict: mupdf.PDFObject, base: string): string {
  let key = base
  for (let n = 2; !dict.get(key).isNull(); n++) key = `${base}${n}`
  return key
}

/** Gets (creating if needed) the sub-dictionary `name` of a resources dictionary. */
function resourceDict(d: mupdf.PDFDocument, resources: mupdf.PDFObject, name: string): mupdf.PDFObject {
  let dict = resources.get(name)
  if (dict.isNull()) {
    dict = d.newDictionary()
    resources.put(name, dict)
  }
  return dict
}

/** Adds `value` to the page's `category` resources (Font, ExtGState, ...) and returns its name. */
function addResource(d: mupdf.PDFDocument, page: mupdf.PDFObject, category: string, base: string, value: mupdf.PDFObject): string {
  let resources = page.getInheritable('Resources')
  if (resources.isNull()) {
    resources = d.newDictionary()
    page.put('Resources', resources)
  }
  const dict = resourceDict(d, resources, category)
  const key = unusedKey(dict, base)
  dict.put(key, value)
  return key
}

/**
 * Appends `content` to the page's content stream, drawn after everything
 * else. The existing content is wrapped in q/Q so graphics state it leaves
 * behind can't move or restyle what we add.
 */
function appendContent(d: mupdf.PDFDocument, page: mupdf.PDFObject, content: string) {
  const existing = page.get('Contents')
  // Our opening q stream carries this key, so a page already wrapped by an
  // earlier edit isn't wrapped again (deep q nesting breaks some readers).
  // KloneWrap is the key used before the rename; files saved then still carry it.
  const first = existing.isArray() && existing.length ? existing.get(0) : null
  if (first && (first.get('KwoonWrap').isBoolean() || first.get('KloneWrap').isBoolean())) {
    existing.push(d.addStream(content, {}))
    return
  }
  const contents = d.newArray()
  contents.push(d.addStream('q', { KwoonWrap: true }))
  if (existing.isArray()) existing.forEach((stream) => contents.push(stream))
  else if (!existing.isNull()) contents.push(existing)
  contents.push(d.addStream('Q', {}))
  contents.push(d.addStream(content, {}))
  page.put('Contents', contents)
}

/** PDF literal string in WinAnsi (Latin-1) encoding; other characters become '?'. */
function pdfString(text: string): string {
  let out = '('
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch
    else if (code >= 32 && code < 256) out += code < 127 ? ch : '\\' + code.toString(8).padStart(3, '0')
    else out += '?'
  }
  return out + ')'
}

const num = (n: number) => (Math.abs(n) < 1e-6 ? '0' : n.toFixed(4).replace(/\.?0+$/, ''))

/** Writes `spec` into the content of each page, centred and on top of everything else. */
function addWatermark(indices: number[], spec: WatermarkSpec): DocState {
  return mutate('Add watermark', (d) => {
    const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
    const state = d.addObject({ Type: 'ExtGState', ca: spec.opacity, CA: spec.opacity })
    const width = textWidth('Helv', spec.fontSize, spec.text)
    for (const index of indices) {
      const page = d.findPage(index)
      const fontKey = addResource(d, page, 'Font', 'KwoonWM', font)
      const stateKey = addResource(d, page, 'ExtGState', 'KwoonWMGS', state)

      // Centre on the visible area; the page's /Rotate turns the content
      // clockwise for display, so add it to get the angle the reader sees.
      const box = page.getInheritable('CropBox').isNull() ? page.getInheritable('MediaBox') : page.getInheritable('CropBox')
      const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => box.get(i).asNumber())
      const rotate = page.getInheritable('Rotate')
      const radians = ((spec.angle + (rotate.isNumber() ? rotate.asNumber() : 0)) * Math.PI) / 180
      const [cos, sin] = [Math.cos(radians), Math.sin(radians)]
      const [r, g, b] = spec.color
      appendContent(
        d,
        page,
        `q /${stateKey} gs ${num(r)} ${num(g)} ${num(b)} rg BT /${fontKey} ${num(spec.fontSize)} Tf ` +
          `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num((x0 + x1) / 2)} ${num((y0 + y1) / 2)} Tm ` +
          `${num(-width / 2)} ${num(-spec.fontSize * 0.35)} Td ${pdfString(spec.text)} Tj ET Q`,
      )
    }
  })
}

// ---------- OCR ----------

/** Helvetica's ascent as a fraction of the font size; tall letters reach about this high. */
const HELVETICA_ASCENT = 0.72

function textStats(): { page: number; chars: number }[] {
  const d = requireDoc()
  const stats = []
  for (let i = 0; i < d.countPages(); i++) {
    const id = loadPage(i).getObject().asIndirect()
    stats.push({ page: id, chars: pageText(id).asText().replace(/\s/g, '').length })
  }
  return stats
}

/**
 * Writes OCR results as invisible text (render mode 3) over each word, like
 * a "searchable PDF": the page looks the same, but its text can be searched,
 * selected, marked up and redacted. Words arrive in display space; the
 * inverse page transform maps them back into PDF space, which also handles
 * rotated pages.
 */
function addOcrText(pages: OcrPage[]): DocState {
  return mutate('Recognize text', (d) => {
    const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
    for (const { page: pageId, words } of pages) {
      if (!words.length) continue
      const page = pageById(pageId)
      const obj = page.getObject()
      const fontKey = addResource(d, obj, 'Font', 'KwoonOCR', font)
      const [a, b, c, dd, e, f] = mupdf.Matrix.invert(page.getTransform())
      const toPdf = (x: number, y: number): Point => [a * x + c * y + e, b * x + dd * y + f]
      const unit = (x: number, y: number): Point => {
        const len = Math.hypot(x, y)
        return [x / len, y / len]
      }
      // Display space runs y-down; text space runs y-up.
      const [rx, ry] = unit(a, b)
      const [ux, uy] = unit(-c, -dd)
      let content = `BT 3 Tr`
      for (const word of words) {
        const [x0, top, x1] = word.bbox
        const size = Math.max((word.baseline - top) / HELVETICA_ASCENT, 1)
        const natural = textWidth('Helv', size, word.text)
        if (!word.text.trim() || natural <= 0 || x1 <= x0) continue
        const [ox, oy] = toPdf(x0, word.baseline)
        content +=
          ` /${fontKey} ${num(size)} Tf ${num((100 * (x1 - x0)) / natural)} Tz` +
          ` ${num(rx)} ${num(ry)} ${num(ux)} ${num(uy)} ${num(ox)} ${num(oy)} Tm ${pdfString(word.text)} Tj`
      }
      appendContent(d, obj, content + ' ET')
    }
  })
}

// ---------- Editing existing text ----------

const STANDARD_FONTS: Record<TextLine['font']['family'], [string, string, string, string]> = {
  // regular, bold, italic, bold italic
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
}

function standardFontFor({ family, bold, italic }: Pick<TextLineStyle, 'family' | 'bold' | 'italic'>): string {
  return STANDARD_FONTS[family][(bold ? 1 : 0) + (italic ? 2 : 0)]
}

/** The lines of text on a page, with what's needed to edit each in place. */
function textLines(pageId: number): TextLine[] {
  const lines: TextLine[] = []
  let current: { bbox: mupdf.Rect; dir: Point; text: string; first?: Quad; last?: Quad; origin?: Point; size: number; color: RGB; font?: TextLine['font'] } | null = null
  pageText(pageId).walk({
    beginLine(bbox, _wmode, dir) {
      current = { bbox, dir, text: '', size: 0, color: [0, 0, 0] }
    },
    onChar(c, origin, font, size, quad, color) {
      if (!current) return
      current.text += c
      if (!current.first) {
        current.first = quad
        current.origin = origin
        current.size = size
        current.color = toRGB(color as mupdf.AnnotColor) ?? [0, 0, 0]
        const name = font.getName()
        current.font = {
          name,
          family: font.isMono() ? 'mono' : font.isSerif() ? 'serif' : 'sans',
          bold: font.isBold() || /bold|black|heavy/i.test(name),
          italic: font.isItalic() || /italic|oblique/i.test(name),
        }
      }
      if (c.trim()) current.last = quad
    },
    endLine() {
      const line = current
      current = null
      if (!line?.first || !line.last || !line.font || !line.origin || !line.text.trim()) return
      const [f, l] = [line.first, line.last]
      lines.push({
        text: line.text.trimEnd(),
        bbox: line.bbox,
        // Upper-left/lower-left of the first glyph, upper-right/lower-right of the last.
        quad: [f[0], f[1], l[2], l[3], f[4], f[5], l[6], l[7]],
        origin: line.origin,
        dir: line.dir,
        size: line.size,
        color: line.color,
        font: line.font,
      })
    },
  })
  return lines
}

/**
 * Replaces a line of page text: removes its glyphs with a one-off redaction
 * (leaving any redaction marks the user has pending alone), then writes
 * `text` at the same baseline and angle in the standard font, size and
 * colour of `style`. Empty `text` just deletes the line.
 */
function replaceTextLine(pageId: number, line: TextLine, text: string, style: TextLineStyle): DocState {
  textCache.get(pageId)?.destroy()
  textCache.delete(pageId)
  return mutate('Edit text', () => {
    const d = requireDoc()
    const page = pageById(pageId)
    const obj = page.getObject()

    // Narrow the area to the middle band of the glyphs so neighbouring lines,
    // whose boxes often overlap this one slightly, are untouched.
    const q = line.quad
    const lerp = (ax: number, ay: number, bx: number, by: number, t: number) => [ax + (bx - ax) * t, ay + (by - ay) * t]
    const band = [
      ...lerp(q[4], q[5], q[0], q[1], 0.75),
      ...lerp(q[6], q[7], q[2], q[3], 0.75),
      ...lerp(q[4], q[5], q[0], q[1], 0.2),
      ...lerp(q[6], q[7], q[2], q[3], 0.2),
    ] as mupdf.Quad
    const eraser = page.createAnnotation('Redact')
    eraser.setQuadPoints([band])
    eraser.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)

    if (!text.trim()) return
    const fontKey = addResource(d, obj, 'Font', 'KwoonEdit', d.addSimpleFont(new mupdf.Font(standardFontFor(style))))
    const [a, b, c, dd, e, f] = mupdf.Matrix.invert(page.getTransform())
    const [ox, oy] = [a * line.origin[0] + c * line.origin[1] + e, b * line.origin[0] + dd * line.origin[1] + f]
    // Along the baseline, and "up" (display y runs down), mapped into PDF space.
    const along = [a * line.dir[0] + c * line.dir[1], b * line.dir[0] + dd * line.dir[1]]
    const up = [a * line.dir[1] - c * line.dir[0], b * line.dir[1] - dd * line.dir[0]]
    const [rx, ry] = along.map((v) => v / Math.hypot(along[0], along[1]))
    const [ux, uy] = up.map((v) => v / Math.hypot(up[0], up[1]))
    const [r, g, bl] = style.color
    appendContent(
      d,
      obj,
      `BT /${fontKey} ${num(style.size)} Tf ${num(r)} ${num(g)} ${num(bl)} rg ` +
        `${num(rx)} ${num(ry)} ${num(ux)} ${num(uy)} ${num(ox)} ${num(oy)} Tm ${pdfString(text)} Tj ET`,
    )
  }, pageId)
}

// ---------- Form fields ----------

function fieldKind(widget: mupdf.PDFWidget): FieldKind {
  switch (widget.getFieldType()) {
    case 'text':
      return 'text'
    case 'checkbox':
      return 'checkbox'
    case 'radiobutton':
      return 'radio'
    case 'combobox':
      return 'combo'
    case 'listbox':
      return 'list'
    case 'signature':
      return 'signature'
    default:
      return 'button'
  }
}

function describeField(widget: mupdf.PDFWidget): FieldInfo {
  const kind = fieldKind(widget)
  const obj = widget.getObject()
  const state = obj.get('AS')
  let options: FieldInfo['options'] = []
  if (kind === 'combo' || kind === 'list') {
    const labels = widget.getOptions()
    const values = widget.getOptions(true)
    options = labels.map((label, i) => ({ value: values[i] || label, label }))
  }
  return {
    id: obj.asIndirect(),
    name: widget.getName(),
    kind,
    bounds: widget.getBounds(),
    value: widget.getValue(),
    checked: state.isName() && state.asName() !== 'Off',
    options,
    multiline: kind === 'text' && widget.isMultiline(),
    password: kind === 'text' && widget.isPassword(),
    readOnly: widget.isReadOnly(),
    maxLength: kind === 'text' ? widget.getMaxLen() : 0,
    fontSize: widget.getDefaultAppearance().size,
  }
}

function listFields(pageId: number): FieldInfo[] {
  return pageById(pageId).getWidgets().map(describeField)
}

function setField(pageId: number, widgetId: number, change: FieldChange): DocState {
  // A field can have widgets on several pages, so redraw them all.
  return mutate(
    'Fill in form',
    () => {
      const widget = pageById(pageId)
        .getWidgets()
        .find((w) => w.getObject().asIndirect() === widgetId)
      if (!widget) throw new StaleError(`Form field ${widgetId} no longer exists`)
      if (widget.isReadOnly()) throw new Error('This field is read-only')
      if ('text' in change) widget.setTextValue(change.text)
      else if ('choice' in change) widget.setChoiceValue(change.choice)
      else widget.toggle()
      widget.update()
    },
    'appearance',
  )
}

function history(direction: 'undo' | 'redo'): DocState {
  const d = requireDoc()
  if (direction === 'undo' ? d.canUndo() : d.canRedo()) {
    if (direction === 'undo') d.undo()
    else d.redo()
    clearPageCache()
    clearTextCache()
    docRev++
  }
  return state()
}

function handle(req: WorkerRequest): { result: unknown; transfer?: Transferable[] } {
  switch (req.type) {
    case 'open':
      return { result: open(req.data) }
    case 'authenticate':
      return { result: authenticate(req.password) }
    case 'render': {
      const result = render(req.id, req.scale)
      return { result, transfer: [result.pixels.buffer] }
    }
    case 'save': {
      const result = save()
      return { result, transfer: [result.buffer] }
    }
    case 'extract': {
      const result = extract(req.pages)
      return { result, transfer: [result.buffer] }
    }
    case 'rotate':
      return { result: rotate(req.pages, req.degrees) }
    case 'delete':
      return { result: deletePages(req.pages) }
    case 'move':
      return { result: move(req.pages, req.to) }
    case 'insertPdf':
      return { result: insertPdf(req.data, req.at) }
    case 'insertBlank':
      return { result: insertBlank(req.at, req.width, req.height) }
    case 'undo':
    case 'redo':
      return { result: history(req.type) }
    case 'listAnnots':
      return { result: listAnnots(req.page) }
    case 'textQuads':
      return { result: textQuads(req.page, req.from, req.to) }
    case 'createAnnot':
      return { result: createAnnot(req.page, req.spec, req.style) }
    case 'updateAnnot':
      return { result: updateAnnot(req.page, req.annot, req.patch) }
    case 'deleteAnnot':
      return { result: deleteAnnot(req.page, req.annot) }
    case 'listFields':
      return { result: listFields(req.page) }
    case 'setField':
      return { result: setField(req.page, req.widget, req.change) }
    case 'watermark':
      return { result: addWatermark(req.pages, req.spec) }
    case 'search':
      return { result: search(req.query, req.matchCase) }
    case 'markRedactions':
      return { result: markRedactions(req.query, req.matchCase) }
    case 'applyRedactions':
      return { result: applyRedactions() }
    case 'textStats':
      return { result: textStats() }
    case 'addOcrText':
      return { result: addOcrText(req.pages) }
    case 'textLines':
      return { result: textLines(req.page) }
    case 'allAnnots':
      return { result: allAnnots() }
    case 'pageTextChars':
      return { result: pageTextChars(req.page) }
    case 'replaceTextLine':
      return { result: replaceTextLine(req.page, req.line, req.text, req.style) }
  }
}

self.onmessage = (event: MessageEvent<{ id: number; req: WorkerRequest }>) => {
  const { id, req } = event.data
  let response: WorkerResponse
  let transfer: Transferable[] = []
  try {
    const handled = handle(req)
    response = { id, ok: true, result: handled.result }
    transfer = handled.transfer ?? []
  } catch (err) {
    response = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stale: err instanceof StaleError,
    }
  }
  self.postMessage(response, { transfer })
}

// Requests that arrive while MuPDF is still loading can be dropped, so the
// client waits for this before sending anything.
self.postMessage({ ready: true } satisfies WorkerReady)
