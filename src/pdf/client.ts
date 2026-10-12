// Promise-based wrapper around the PDF worker.
//
// Render requests go through a local queue so only one is in the worker at a
// time. The newest request is served first (it is most likely on screen), and
// requests whose AbortSignal fires before they are sent are dropped, so fast
// scrolling doesn't leave a backlog of pages nobody is looking at.

import type {
  AnnotInfo,
  AnnotPatch,
  AnnotSpec,
  AnnotStyle,
  DocState,
  FieldChange,
  FieldInfo,
  OpenResult,
  Point,
  Quad,
  RenderResult,
  OcrPage,
  ResultMap,
  SearchHit,
  TextLine,
  TextLineStyle,
  WatermarkSpec,
  WorkerReady,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface QueuedRender {
  id: number
  scale: number
  signal?: AbortSignal
  resolve: (value: RenderResult) => void
  reject: (reason: unknown) => void
}

function abortError() {
  return new DOMException('Render cancelled', 'AbortError')
}

export class PdfClient {
  private worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })
  private nextId = 1
  private pending = new Map<number, Pending>()
  private renderQueue: QueuedRender[] = []
  private renderInFlight = false
  /** Messages held until the worker reports that MuPDF has loaded. */
  private outbox: { message: unknown; transfer: Transferable[] }[] | null = []

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerReady>) => {
      const msg = event.data
      if ('ready' in msg) {
        for (const { message, transfer } of this.outbox ?? []) this.worker.postMessage(message, transfer)
        this.outbox = null
        return
      }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.ok) entry.resolve(msg.result)
      else entry.reject(msg.stale ? abortError() : new Error(msg.error))
    }
    // Errors that escape the worker's handler would otherwise leave callers
    // waiting forever.
    const failAll = (reason: string) => {
      console.error('PDF worker error:', reason)
      for (const entry of this.pending.values()) entry.reject(new Error(reason))
      this.pending.clear()
    }
    this.worker.onerror = (event) => failAll(event.message || 'The PDF engine crashed')
    this.worker.onmessageerror = () => failAll('A message from the PDF engine could not be read')
  }

  private send<T extends WorkerRequest>(req: T, transfer: Transferable[] = []): Promise<ResultMap[T['type']]> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      if (this.outbox) this.outbox.push({ message: { id, req }, transfer })
      else this.worker.postMessage({ id, req }, transfer)
    })
  }

  open(data: ArrayBuffer): Promise<OpenResult> {
    for (const job of this.renderQueue) job.reject(abortError())
    this.renderQueue = []
    return this.send({ type: 'open', data }, [data])
  }

  authenticate(password: string): Promise<OpenResult> {
    return this.send({ type: 'authenticate', password })
  }

  save(): Promise<Uint8Array<ArrayBuffer>> {
    return this.send({ type: 'save' })
  }

  /** Builds a new PDF from the pages at `pages` (indices). */
  extract(pages: number[]): Promise<Uint8Array<ArrayBuffer>> {
    return this.send({ type: 'extract', pages })
  }

  rotate(pages: number[], degrees: number): Promise<DocState> {
    return this.send({ type: 'rotate', pages, degrees })
  }

  deletePages(pages: number[]): Promise<DocState> {
    return this.send({ type: 'delete', pages })
  }

  /** Moves `pages` (indices) to sit before the page currently at index `to`. */
  move(pages: number[], to: number): Promise<DocState> {
    return this.send({ type: 'move', pages, to })
  }

  insertPdf(data: ArrayBuffer, at: number): Promise<DocState> {
    return this.send({ type: 'insertPdf', data, at }, [data])
  }

  insertBlank(at: number, width: number, height: number): Promise<DocState> {
    return this.send({ type: 'insertBlank', at, width, height })
  }

  undo(): Promise<DocState> {
    return this.send({ type: 'undo' })
  }

  redo(): Promise<DocState> {
    return this.send({ type: 'redo' })
  }

  listAnnots(page: number): Promise<AnnotInfo[]> {
    return this.send({ type: 'listAnnots', page })
  }

  /** Quads covering the text between two points, as a text selection would. */
  textQuads(page: number, from: Point, to: Point): Promise<Quad[]> {
    return this.send({ type: 'textQuads', page, from, to })
  }

  createAnnot(page: number, spec: AnnotSpec, style: AnnotStyle): Promise<{ state: DocState; annot: number }> {
    return this.send({ type: 'createAnnot', page, spec, style }, spec.kind === 'image' ? ['jpeg' in spec.image ? spec.image.jpeg : spec.image.rgba] : [])
  }

  updateAnnot(page: number, annot: number, patch: AnnotPatch): Promise<DocState> {
    return this.send({ type: 'updateAnnot', page, annot, patch })
  }

  deleteAnnot(page: number, annot: number): Promise<DocState> {
    return this.send({ type: 'deleteAnnot', page, annot })
  }

  listFields(page: number): Promise<FieldInfo[]> {
    return this.send({ type: 'listFields', page })
  }

  setField(page: number, widget: number, change: FieldChange): Promise<DocState> {
    return this.send({ type: 'setField', page, widget, change })
  }

  /** Writes a text watermark into the content of the pages at `pages` (indices). */
  watermark(pages: number[], spec: WatermarkSpec): Promise<DocState> {
    return this.send({ type: 'watermark', pages, spec })
  }

  /** Every occurrence of `query` in the document. */
  search(query: string, matchCase = false): Promise<SearchHit[]> {
    return this.send({ type: 'search', query, matchCase })
  }

  /** Marks every occurrence of `query` for redaction. */
  markRedactions(query: string, matchCase = false): Promise<{ state: DocState; count: number }> {
    return this.send({ type: 'markRedactions', query, matchCase })
  }

  /** Permanently removes the content under all redaction marks. */
  applyRedactions(): Promise<DocState> {
    return this.send({ type: 'applyRedactions' })
  }

  /** How much text each page already has, to find pages that need OCR. */
  textStats(): Promise<{ page: number; chars: number }[]> {
    return this.send({ type: 'textStats' })
  }

  /** Adds recognized words to pages as an invisible, searchable text layer. */
  addOcrText(pages: OcrPage[]): Promise<DocState> {
    return this.send({ type: 'addOcrText', pages })
  }

  /** Every annotation in the document with its page id (for the comments list). */
  allAnnots(): Promise<{ page: number; annot: AnnotInfo }[]> {
    return this.send({ type: 'allAnnots' })
  }

  /** Number of text characters on a page (0 for an image-only scan). */
  pageTextChars(page: number): Promise<number> {
    return this.send({ type: 'pageTextChars', page })
  }

  /** The lines of text on a page, for in-place editing. */
  textLines(page: number): Promise<TextLine[]> {
    return this.send({ type: 'textLines', page })
  }

  /** Replaces a line of page text (removing its glyphs) with `text`; empty text deletes the line. */
  replaceTextLine(page: number, line: TextLine, text: string, style: TextLineStyle): Promise<DocState> {
    return this.send({ type: 'replaceTextLine', page, line, text, style })
  }

  /** Renders the page with object number `id` at `scale` device pixels per point. */
  render(id: number, scale: number, signal?: AbortSignal): Promise<RenderResult> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      this.renderQueue.push({ id, scale, signal, resolve, reject })
      this.pumpRenders()
    })
  }

  private pumpRenders() {
    if (this.renderInFlight) return
    let job: QueuedRender | undefined
    while ((job = this.renderQueue.pop())) {
      if (!job.signal?.aborted) break
      job.reject(abortError())
    }
    if (!job) return
    const current = job
    this.renderInFlight = true
    this.send({ type: 'render', id: current.id, scale: current.scale })
      .then(
        (result) => (current.signal?.aborted ? current.reject(abortError()) : current.resolve(result)),
        current.reject,
      )
      .finally(() => {
        this.renderInFlight = false
        this.pumpRenders()
      })
  }
}

export const pdf = new PdfClient()
