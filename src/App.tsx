import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import './App.css'
import { AnnotationContext, type AnnotationController, type AnnotSelection } from './annotations/context'
import { MODES, TOOL_MODES, type Mode } from './annotations/modes'
import { DEFAULT_STYLES, type DrawingTool, type Tool } from './annotations/tools'
import { CommandPalette, type Command } from './components/CommandPalette'
import { Inspector, type CommentEntry } from './components/Inspector'
import { StackedLockup } from './components/Logo'
import { OcrDialog } from './components/OcrDialog'
import { ApplyRedactionsDialog, FindRedactDialog, UnappliedRedactionsDialog } from './components/RedactionDialogs'
import { Sidebar } from './components/Sidebar'
import { SignatureDialog } from './components/SignatureDialog'
import { StatusBar } from './components/StatusBar'
import { Toasts, type ToastMessage } from './components/Toasts'
import { ToolRow, type ToolRowActions } from './components/ToolRow'
import { TopBar, type SearchState } from './components/TopBar'
import { VIEWER_PADDING, Viewer, type ViewerHandle } from './components/Viewer'
import { WatermarkDialog, type WatermarkPages } from './components/WatermarkDialog'
import { loadImage } from './images'
import { pdf } from './pdf/client'
import type {
  AnnotInfo,
  AnnotPatch,
  AnnotSpec,
  AnnotStyle,
  DocState,
  FieldChange,
  OpenResult,
  Rect,
  SearchHit,
  TextLine,
  TextLineStyle,
  WatermarkSpec,
} from './pdf/protocol'
import { THEME_LABELS, getThemeMode, setThemeMode, type ThemeMode } from './theme/theme'
import { brand } from './theme/tokens'
import { MAX_SCALE, MIN_SCALE, ZOOM_PRESETS, clampScale } from './zoom'

interface OpenDocument extends DocState {
  /** Changes on every open so the viewer starts fresh. */
  key: number
  name: string
  size: number
}

type DialogName = 'signature' | 'watermark' | 'findRedact' | 'applyRedact' | 'downloadRedact' | 'ocr' | 'commands'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function unlock(result: OpenResult): Promise<DocState | null> {
  let message = 'This PDF is password protected. Enter the password:'
  while (result.needsPassword) {
    const password = window.prompt(message)
    if (password === null) return null
    try {
      result = await pdf.authenticate(password)
    } catch {
      message = 'Incorrect password. Try again:'
    }
  }
  return result
}

function downloadBytes(bytes: Uint8Array<ArrayBuffer>, fileName: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Formats sorted zero-based indices as one-based ranges, e.g. "1-3, 5". */
function formatRanges(indices: number[]): string {
  const parts: string[] = []
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i]
    while (i + 1 < indices.length && indices[i + 1] === indices[i] + 1) i++
    parts.push(start === indices[i] ? `${start + 1}` : `${start + 1}-${indices[i] + 1}`)
  }
  return parts.join(', ')
}

const isPdfDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files')
/** Annotations listed under Comments: notes, plus anything someone wrote a comment on. */
const isComment = (a: AnnotInfo) => a.type === 'Text' || (a.contents.trim() !== '' && a.type !== 'FreeText' && a.type !== 'Redact')
const wide = (px: number) => window.innerWidth > px

export default function App() {
  const [doc, setDoc] = useState<OpenDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [dragging, setDragging] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => wide(900))
  const [inspectorOpen, setInspectorOpen] = useState(() => wide(1200))
  const [theme, setTheme] = useState<ThemeMode>(getThemeMode)
  const [mode, setMode] = useState<Mode>('view')
  const [currentPage, setCurrentPage] = useState(0)
  /** Explicitly picked pages; empty means "the current page". */
  const [pickedIds, setPickedIds] = useState<Set<number>>(new Set())
  const [fitWidth, setFitWidth] = useState(true)
  const [customScale, setCustomScale] = useState(1)
  const [viewerWidth, setViewerWidth] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [toolStyles, setToolStyles] = useState<Record<DrawingTool, AnnotStyle>>(DEFAULT_STYLES)
  const [annotSelection, setAnnotSelection] = useState<AnnotSelection | null>(null)
  const [focusComment, setFocusComment] = useState(false)
  const [dialog, setDialog] = useState<DialogName | null>(null)
  const [search, setSearch] = useState<SearchState>({ query: '', count: null, index: 0 })
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [comments, setComments] = useState<CommentEntry[]>([])
  const [textChars, setTextChars] = useState<number | null>(null)
  const viewerRef = useRef<ViewerHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const insertInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const toastId = useRef(0)
  /** Guards against overlapping operations computed from stale page indices. */
  const opRunning = useRef(false)
  /**
   * Form edits run in order on their own chain rather than through `run`, so
   * tabbing quickly between fields never drops a value.
   */
  const formQueue = useRef<Promise<void>>(Promise.resolve())
  /** Page to scroll to once the viewer has laid out the next document state. */
  const pendingScroll = useRef<number | null>(null)

  const pages = useMemo(() => doc?.pages ?? [], [doc])
  const widestPage = pages.length ? Math.max(...pages.map((p) => p.width)) : 1
  const fitScale = clampScale((viewerWidth - VIEWER_PADDING * 2) / widestPage)
  const scale = fitWidth && viewerWidth > 0 ? fitScale : customScale

  const selectedIds = useMemo(() => {
    if (pickedIds.size) return pickedIds
    return new Set(pages[currentPage] ? [pages[currentPage].id] : [])
  }, [pickedIds, pages, currentPage])

  const selectedIndices = useMemo(
    () => pages.flatMap((page, index) => (selectedIds.has(page.id) ? [index] : [])),
    [pages, selectedIds],
  )
  const pageSelectionLabel = selectedIndices.length > 1 ? `${selectedIndices.length} pages` : `Page ${currentPage + 1}`

  // ---------- Toasts ----------

  const notify = useCallback((kind: ToastMessage['kind'], text: string, action?: ToastMessage['action']) => {
    const id = ++toastId.current
    setToasts((list) => [...list.filter((t) => t.text !== text), { id, kind, text, action }].slice(-3))
  }, [])
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), [])

  // ---------- Document state ----------

  useEffect(() => {
    if (pendingScroll.current === null) return
    viewerRef.current?.scrollToPage(pendingScroll.current)
    pendingScroll.current = null
  }, [doc])

  useEffect(() => {
    if (!doc?.dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [doc?.dirty])

  // The comments list follows every change to the document.
  useEffect(() => {
    if (!doc) return
    let live = true
    pdf.allAnnots().then(
      (list) => {
        if (!live) return
        const index = new Map(doc.pages.map((p, i) => [p.id, i]))
        setComments(
          list
            .filter((e) => isComment(e.annot) && index.has(e.page))
            .map((e) => ({ ...e, pageIndex: index.get(e.page)! }))
            .sort((a, b) => a.pageIndex - b.pageIndex || a.annot.bounds[1] - b.annot.bounds[1]),
        )
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [doc])

  const current = pages[currentPage]
  useEffect(() => {
    if (!current) return
    let live = true
    pdf.pageTextChars(current.id).then(
      (n) => live && setTextChars(n),
      () => live && setTextChars(null),
    )
    return () => {
      live = false
    }
  }, [current])

  /** Runs one operation at a time, reporting failures as an error toast. */
  const run = useCallback(
    async (what: string, operation: () => Promise<void>) => {
      if (opRunning.current) return
      opRunning.current = true
      setBusy(true)
      try {
        await operation()
      } catch (err) {
        notify('error', `${what}: ${errorMessage(err)}`)
      } finally {
        opRunning.current = false
        setBusy(false)
      }
    },
    [notify],
  )

  const applyState = useCallback((state: DocState, options: { pick?: Set<number>; scrollTo?: number } = {}) => {
    setDoc((prev) => (prev ? { ...prev, ...state } : prev))
    const ids = new Set(state.pages.map((p) => p.id))
    setPickedIds((prev) => options.pick ?? new Set([...prev].filter((id) => ids.has(id))))
    setAnnotSelection((prev) => (prev && ids.has(prev.pageId) ? prev : null))
    if (options.scrollTo !== undefined) pendingScroll.current = Math.min(options.scrollTo, state.pages.length - 1)
  }, [])

  const openFile = useCallback(
    (file: File) => {
      if (doc?.dirty && !window.confirm(`Discard unsaved changes to ${doc.name}?`)) return
      void run(`Couldn't open ${file.name}`, async () => {
        const state = await unlock(await pdf.open(await file.arrayBuffer()))
        if (!state) {
          // Password prompt cancelled; the worker has already swapped documents.
          setDoc(null)
          document.title = brand.name
          return
        }
        setDoc((prev) => ({ ...state, key: (prev?.key ?? 0) + 1, name: file.name, size: file.size }))
        setPickedIds(new Set())
        setAnnotSelection(null)
        setCurrentPage(0)
        setSearch({ query: '', count: null, index: 0 })
        setSearchHits([])
        setMode('view')
        setTool('select')
        document.title = `${file.name} — ${brand.name}`
        // A document with no text at all is almost certainly a scan.
        const stats = await pdf.textStats()
        if (stats.length && stats.every((s) => s.chars === 0)) {
          notify('info', 'This PDF looks like a scan, so its text can’t be searched or selected yet.', {
            label: 'Run OCR',
            run: () => setDialog('ocr'),
          })
        }
      })
    },
    [doc, run, notify],
  )

  /** Saves and downloads; `applyRedactionsFirst` applies pending redaction marks in the same step. */
  const saveFile = useCallback(
    (applyRedactionsFirst = false) => {
      if (!doc) return
      setDialog(null)
      void run("Couldn't export", async () => {
        if (applyRedactionsFirst) {
          applyState(await pdf.applyRedactions())
          setAnnotSelection(null)
        }
        const bytes = await pdf.save()
        downloadBytes(bytes, doc.name)
        setDoc((prev) =>
          prev ? { ...prev, dirty: false, size: bytes.length, pages: prev.pages.map((p) => ({ ...p, edited: false })) } : prev,
        )
      })
    },
    [doc, run, applyState],
  )

  const exportFile = useCallback(() => {
    if (!doc) return
    // Marks alone hide nothing: make sure that's a deliberate choice.
    if (doc.redactions > 0) setDialog('downloadRedact')
    else saveFile()
  }, [doc, saveFile])

  // ---------- Pages ----------

  const rotate = (degrees: number) =>
    void run("Couldn't rotate", async () => applyState(await pdf.rotate(selectedIndices, degrees)))

  const deleteSelected = () => {
    if (selectedIndices.length >= pages.length) {
      notify('error', 'A PDF needs at least one page, so you can’t delete them all.')
      return
    }
    void run("Couldn't delete", async () =>
      applyState(await pdf.deletePages(selectedIndices), { pick: new Set(), scrollTo: selectedIndices[0] }),
    )
  }

  const extract = () => {
    if (!doc) return
    void run("Couldn't extract", async () => {
      const base = doc.name.replace(/\.pdf$/i, '')
      downloadBytes(await pdf.extract(selectedIndices), `${base} (pages ${formatRanges(selectedIndices)}).pdf`)
    })
  }

  const move = (to: number) => {
    const first = selectedIndices[0]
    const last = selectedIndices[selectedIndices.length - 1]
    const contiguous = last - first + 1 === selectedIndices.length
    if (contiguous && to >= first && to <= last + 1) return
    const landing = to - selectedIndices.filter((i) => i < to).length
    void run("Couldn't move pages", async () =>
      applyState(await pdf.move(selectedIndices, to), { pick: new Set(selectedIds), scrollTo: landing }),
    )
  }

  /** Index just after the selection, where new pages go. */
  const insertionPoint = () => (selectedIndices.length ? selectedIndices[selectedIndices.length - 1] + 1 : pages.length)

  const insertBlank = () => {
    const at = insertionPoint()
    const like = pages[at - 1] ?? pages[0]
    void run("Couldn't insert a page", async () => {
      const state = await pdf.insertBlank(at, like.width, like.height)
      applyState(state, { pick: new Set([state.pages[at].id]), scrollTo: at })
    })
  }

  const insertFiles = (files: File[], at: number) => {
    void run("Couldn't insert pages", async () => {
      const before = new Set(pages.map((p) => p.id))
      let state: DocState | null = null
      let position = at
      for (const file of files) {
        const count = state?.pages.length ?? pages.length
        try {
          state = await pdf.insertPdf(await file.arrayBuffer(), position)
        } catch (err) {
          throw new Error(`${file.name}: ${errorMessage(err)}`)
        }
        position += state.pages.length - count
      }
      if (state) {
        const added = new Set(state.pages.filter((p) => !before.has(p.id)).map((p) => p.id))
        applyState(state, { pick: added, scrollTo: at })
      }
    })
  }

  const history = useCallback(
    (direction: 'undo' | 'redo') =>
      void run(`Couldn't ${direction}`, async () => applyState(await (direction === 'undo' ? pdf.undo() : pdf.redo()))),
    [run, applyState],
  )

  // ---------- Modes, tools and annotations ----------

  const toolStyle = toolStyles[tool === 'select' ? 'rect' : tool]

  const changeTool = useCallback((next: Tool) => {
    setTool(next)
    if (next !== 'select') setMode(TOOL_MODES[next])
    setAnnotSelection(null)
  }, [])

  const changeMode = useCallback((next: Mode) => {
    setMode(next)
    setTool('select')
    setAnnotSelection(null)
  }, [])

  const selectAnnot = useCallback((pageId: number, annot: AnnotInfo | null) => {
    setAnnotSelection(annot ? { pageId, annotId: annot.id, info: annot } : null)
    setFocusComment(false)
    if (annot) setInspectorOpen(true)
  }, [])

  const syncAnnotations = useCallback((pageId: number, annots: AnnotInfo[]) => {
    setAnnotSelection((prev) => {
      if (!prev || prev.pageId !== pageId) return prev
      const info = annots.find((a) => a.id === prev.annotId)
      if (!info) return null
      return JSON.stringify(info) === JSON.stringify(prev.info) ? prev : { ...prev, info }
    })
  }, [])

  const createAnnot = useCallback(
    (pageId: number, spec: AnnotSpec) =>
      void run("Couldn't add the annotation", async () => {
        const { state, annot } = await pdf.createAnnot(pageId, spec, toolStyle)
        applyState(state)
        setAnnotSelection({ pageId, annotId: annot, info: null })
        if (spec.kind === 'note') {
          // Comments are one-off: go straight to typing.
          setFocusComment(true)
          setInspectorOpen(true)
          setTool('select')
        }
      }),
    [run, applyState, toolStyle],
  )

  const updateSelectedAnnot = useCallback(
    (patch: AnnotPatch) => {
      const sel = annotSelection
      if (!sel) return
      void run("Couldn't change the annotation", async () =>
        applyState(await pdf.updateAnnot(sel.pageId, sel.annotId, patch)),
      )
    },
    [annotSelection, run, applyState],
  )

  /**
   * Places an image in the middle of the current page, scaled to fit within
   * `maxWidth` points (default: half the page) at most at its natural size.
   */
  const placeImage = (blob: Blob, what: string, maxWidth?: number) => {
    const page = pages[currentPage]
    if (!page) return
    void run(`Couldn't add the ${what}`, async () => {
      const { payload, width, height } = await loadImage(blob)
      // Treat pixels as 1/96 inch, like a browser does, so images keep their usual size.
      const natural = Math.min(1, (maxWidth ?? page.width * 0.5) / (width * 0.75), (page.height * 0.5) / (height * 0.75))
      const w = width * 0.75 * natural
      const h = height * 0.75 * natural
      const x = (page.width - w) / 2
      const y = (page.height - h) / 2
      const rect: Rect = [x, y, x + w, y + h]
      const { state, annot } = await pdf.createAnnot(page.id, { kind: 'image', rect, image: payload }, { color: [0, 0, 0], opacity: 1, width: 0 })
      applyState(state)
      setTool('select')
      setAnnotSelection({ pageId: page.id, annotId: annot, info: null })
    })
  }

  const markRedactions = (query: string, matchCase: boolean) => {
    setDialog(null)
    void run("Couldn't mark the matches", async () => {
      const { state, count } = await pdf.markRedactions(query, matchCase)
      applyState(state)
      if (count) notify('info', `Marked ${count} ${count === 1 ? 'match' : 'matches'} for redaction. Nothing is removed until you apply.`)
      else notify('error', `No matches for “${query}”.`)
    })
  }

  const applyRedactions = () => {
    setDialog(null)
    void run("Couldn't apply redactions", async () => {
      applyState(await pdf.applyRedactions())
      setAnnotSelection(null)
      setTool('select')
      notify('success', 'Redactions applied. The content under them is gone.')
    })
  }

  const addWatermark = (spec: WatermarkSpec, which: WatermarkPages) => {
    setDialog(null)
    const indices = which === 'all' ? pages.map((_, i) => i) : which === 'current' ? [currentPage] : selectedIndices
    void run("Couldn't add the watermark", async () => applyState(await pdf.watermark(indices, spec)))
  }

  const deleteSelectedAnnot = useCallback(() => {
    const sel = annotSelection
    if (!sel) return
    void run("Couldn't delete the annotation", async () => {
      applyState(await pdf.deleteAnnot(sel.pageId, sel.annotId))
      setAnnotSelection(null)
    })
  }, [annotSelection, run, applyState])

  const fillField = useCallback(
    (pageId: number, widgetId: number, change: FieldChange) => {
      formQueue.current = formQueue.current.then(async () => {
        try {
          applyState(await pdf.setField(pageId, widgetId, change))
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') notify('error', `Couldn't fill in the field: ${errorMessage(err)}`)
        }
      })
    },
    [applyState, notify],
  )

  const editTextLine = useCallback(
    (pageId: number, line: TextLine, text: string, style: TextLineStyle) =>
      void run("Couldn't change the text", async () => applyState(await pdf.replaceTextLine(pageId, line, text, style))),
    [run, applyState],
  )

  const changeToolStyle = (patch: Partial<AnnotStyle>) => {
    if (tool !== 'select') setToolStyles((styles) => ({ ...styles, [tool]: { ...styles[tool], ...patch } }))
  }

  const updateSelectedAndStyle = (patch: AnnotPatch) => {
    updateSelectedAnnot(patch)
    // Restyling what you just drew also sets the style for the next one.
    const { color, width, opacity, font, fontSize } = patch
    const style = Object.fromEntries(Object.entries({ color, width, opacity, font, fontSize }).filter(([, v]) => v !== undefined))
    if (Object.keys(style).length) changeToolStyle(style)
  }

  // ---------- Search ----------

  const showHit = useCallback(
    (hits: SearchHit[], index: number) => {
      const hit = hits[index]
      if (!hit) return
      const pageIndex = pages.findIndex((p) => p.id === hit.page)
      if (pageIndex >= 0) viewerRef.current?.scrollToPage(pageIndex, Math.min(...hit.quads.map((q) => q[1])))
    },
    [pages],
  )

  const runSearch = (query: string) => {
    const q = query.trim()
    if (!q) {
      setSearch({ query: '', count: null, index: 0 })
      setSearchHits([])
      return
    }
    pdf.search(q).then(
      (hits) => {
        setSearchHits(hits)
        setSearch({ query, count: hits.length, index: 0 })
        if (hits.length) showHit(hits, 0)
      },
      (err) => notify('error', `Search failed: ${errorMessage(err)}`),
    )
  }

  const stepSearch = (step: 1 | -1) => {
    if (!searchHits.length) return
    const index = (search.index + step + searchHits.length) % searchHits.length
    setSearch((s) => ({ ...s, index }))
    showHit(searchHits, index)
  }

  const clearSearch = () => {
    setSearch({ query: '', count: null, index: 0 })
    setSearchHits([])
  }

  // ---------- View ----------

  const changeTheme = (next: ThemeMode) => {
    setThemeMode(next)
    setTheme(next)
  }

  const setZoom = useCallback((value: number | 'fit') => {
    if (value === 'fit') {
      setFitWidth(true)
    } else {
      setFitWidth(false)
      setCustomScale(clampScale(value))
    }
  }, [])

  const zoomBy = useCallback((factor: number) => setZoom(scale * factor), [scale, setZoom])

  const zoomStep = useCallback(
    (direction: 1 | -1) => {
      const next =
        direction > 0
          ? ZOOM_PRESETS.find((z) => z > scale + 0.001) ?? MAX_SCALE
          : [...ZOOM_PRESETS].reverse().find((z) => z < scale - 0.001) ?? MIN_SCALE
      setZoom(next)
    },
    [scale, setZoom],
  )

  const goToPage = useCallback(
    (index: number, y?: number) => {
      if (!pages.length) return
      viewerRef.current?.scrollToPage(Math.min(Math.max(index, 0), pages.length - 1), y)
    },
    [pages],
  )

  const openComment = (entry: CommentEntry) => {
    setTool('select')
    goToPage(entry.pageIndex, entry.annot.bounds[1])
    selectAnnot(entry.page, entry.annot)
  }

  const annotationController = useMemo<AnnotationController>(
    () => ({
      tool,
      style: toolStyle,
      busy,
      selection: annotSelection,
      searchHits,
      activeHit: search.index,
      select: selectAnnot,
      syncAnnotations,
      create: createAnnot,
      updateSelected: updateSelectedAnnot,
      fillField,
      editTextLine,
    }),
    [tool, toolStyle, busy, annotSelection, searchHits, search.index, selectAnnot, syncAnnotations, createAnnot, updateSelectedAnnot, fillField, editTextLine],
  )

  const actions: ToolRowActions = {
    addImage: () => imageInputRef.current?.click(),
    addSignature: () => setDialog('signature'),
    addWatermark: () => setDialog('watermark'),
    runOcr: () => setDialog('ocr'),
    findRedact: () => setDialog('findRedact'),
    applyRedactions: () => setDialog('applyRedact'),
    rotate,
    deletePages: deleteSelected,
    extractPages: extract,
    insertBlank,
    insertPdf: () => insertInputRef.current?.click(),
  }

  const commands: Command[] = [
    { id: 'open', label: 'Open a PDF…', icon: 'open', shortcut: 'Ctrl O', run: () => fileInputRef.current?.click() },
    { id: 'export', label: 'Export the PDF', icon: 'export', keywords: 'download save', shortcut: 'Ctrl S', disabled: !doc, run: exportFile },
    { id: 'search', label: 'Search text', icon: 'search', keywords: 'find', shortcut: 'Ctrl F', disabled: !doc, run: () => searchInputRef.current?.focus() },
    { id: 'ocr', label: 'Run OCR (recognise text in scans)', icon: 'ocr', keywords: 'scan searchable', disabled: !doc, run: actions.runOcr },
    { id: 'merge', label: 'Insert pages from PDFs (merge)…', icon: 'merge', keywords: 'combine append', disabled: !doc, run: actions.insertPdf },
    { id: 'extract', label: `Extract ${pageSelectionLabel.toLowerCase()} to a new PDF`, icon: 'extract', keywords: 'split save pages', disabled: !doc, run: extract },
    { id: 'blank', label: 'Insert a blank page', icon: 'filePlus', keywords: 'add page', disabled: !doc, run: insertBlank },
    { id: 'rotl', label: `Rotate ${pageSelectionLabel.toLowerCase()} left`, icon: 'revert', disabled: !doc, run: () => rotate(-90) },
    { id: 'rotr', label: `Rotate ${pageSelectionLabel.toLowerCase()} right`, icon: 'rotate', disabled: !doc, run: () => rotate(90) },
    { id: 'delete', label: `Delete ${pageSelectionLabel.toLowerCase()}`, icon: 'trash', keywords: 'remove pages', disabled: !doc || selectedIndices.length >= pages.length, run: deleteSelected },
    { id: 'watermark', label: 'Add a watermark…', icon: 'watermark', keywords: 'stamp confidential draft', disabled: !doc, run: actions.addWatermark },
    { id: 'signature', label: 'Add a signature…', icon: 'sign', keywords: 'sign', disabled: !doc, run: actions.addSignature },
    { id: 'image', label: 'Add an image…', icon: 'image', keywords: 'picture logo stamp', disabled: !doc, run: actions.addImage },
    { id: 'findredact', label: 'Find and redact…', icon: 'redact', keywords: 'remove hide black out', disabled: !doc, run: actions.findRedact },
    { id: 'applyredact', label: 'Apply redactions', icon: 'protect', disabled: !doc?.redactions, run: actions.applyRedactions },
    ...MODES.map((m) => ({ id: `mode-${m.mode}`, label: `Switch to ${m.label}`, icon: 'more' as const, keywords: 'mode', disabled: !doc, run: () => changeMode(m.mode) })),
    { id: 'undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl Z', disabled: !doc?.canUndo, run: () => history('undo') },
    { id: 'redo', label: 'Redo', icon: 'redo', shortcut: 'Ctrl Y', disabled: !doc?.canRedo, run: () => history('redo') },
    { id: 'fit', label: 'Fit page width', icon: 'fitWidth', keywords: 'zoom', shortcut: 'Ctrl 0', disabled: !doc, run: () => setZoom('fit') },
    { id: 'thumbs', label: sidebarOpen ? 'Hide page thumbnails' : 'Show page thumbnails', icon: 'sidebar', disabled: !doc, run: () => setSidebarOpen((o) => !o) },
    { id: 'inspector', label: inspectorOpen ? 'Hide the inspector' : 'Show the inspector', icon: 'inspector', disabled: !doc, run: () => setInspectorOpen((o) => !o) },
    ...(['dark', 'light', 'system'] as ThemeMode[]).map((m) => ({
      id: `theme-${m}`,
      label: `Appearance: ${THEME_LABELS[m]}`,
      icon: (m === 'dark' ? 'moon' : m === 'light' ? 'sun' : 'monitor') as 'moon',
      keywords: 'theme colour dark light',
      disabled: theme === m,
      run: () => changeTheme(m),
    })),
  ]

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const target = event.target instanceof HTMLElement ? event.target : null
      const inField = target?.matches('input, textarea, select') ?? false
      if (!(event.ctrlKey || event.metaKey)) {
        // The thumbnails handle Delete for pages themselves.
        if (!doc || inField || target?.closest('.thumbs')) return
        if (key === 'escape') {
          if (annotSelection) setAnnotSelection(null)
          else setTool('select')
        } else if ((key === 'delete' || key === 'backspace') && annotSelection) {
          deleteSelectedAnnot()
        } else {
          return
        }
        event.preventDefault()
        return
      }
      if (key === 'k') setDialog((d) => (d === 'commands' ? null : 'commands'))
      else if (key === 'o') fileInputRef.current?.click()
      else if (!doc) return
      else if (key === 's') exportFile()
      else if (key === 'f') searchInputRef.current?.focus()
      else if ((key === 'z' && event.shiftKey) || key === 'y') {
        if (inField) return
        history('redo')
      } else if (key === 'z') {
        if (inField) return
        history('undo')
      } else if (key === '=' || key === '+') zoomStep(1)
      else if (key === '-') zoomStep(-1)
      else if (key === '0') setZoom('fit')
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [doc, exportFile, history, zoomStep, setZoom, annotSelection, deleteSelectedAnnot])

  return (
    <div
      className="kw-shell app"
      onDragOver={(e) => {
        // The thumbnails handle their own drops (inserting pages).
        if (e.defaultPrevented || !isPdfDrag(e)) {
          setDragging(false)
          return
        }
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        setDragging(false)
        if (e.defaultPrevented || !isPdfDrag(e)) return
        e.preventDefault()
        const file = e.dataTransfer.files[0]
        if (file) openFile(file)
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        data-role="open"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) openFile(file)
          e.target.value = ''
        }}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) placeImage(file, 'image')
          e.target.value = ''
        }}
      />
      <input
        ref={insertInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) insertFiles(files, insertionPoint())
          e.target.value = ''
        }}
      />

      <TopBar
        fileName={doc?.name ?? null}
        dirty={doc?.dirty ?? false}
        fileSize={doc?.size ?? null}
        mode={mode}
        busy={busy}
        theme={theme}
        search={search}
        searchInputRef={searchInputRef}
        onModeChange={changeMode}
        onSearch={runSearch}
        onSearchStep={stepSearch}
        onSearchClear={clearSearch}
        onOpen={() => fileInputRef.current?.click()}
        onExport={exportFile}
        onCommand={() => setDialog('commands')}
        onThemeChange={changeTheme}
      />

      <AnnotationContext.Provider value={annotationController}>
        {doc && (
          <ToolRow
            mode={mode}
            tool={tool}
            busy={busy}
            redactions={doc.redactions}
            pageSelectionLabel={pageSelectionLabel}
            canDeletePages={selectedIndices.length < pages.length}
            sidebarOpen={sidebarOpen}
            inspectorOpen={inspectorOpen}
            canUndo={doc.canUndo}
            canRedo={doc.canRedo}
            currentPage={currentPage}
            pageCount={pages.length}
            scale={scale}
            fitWidth={fitWidth}
            actions={actions}
            onToolChange={changeTool}
            onToggleSidebar={() => setSidebarOpen((o) => !o)}
            onToggleInspector={() => setInspectorOpen((o) => !o)}
            onUndo={() => history('undo')}
            onRedo={() => history('redo')}
            onGoToPage={goToPage}
            onZoomIn={() => zoomStep(1)}
            onZoomOut={() => zoomStep(-1)}
            onSetZoom={setZoom}
          />
        )}

        <main className="kw-body workspace">
          {doc ? (
            <>
              {sidebarOpen && (
                <Sidebar
                  key={`sidebar-${doc.key}`}
                  pages={pages}
                  currentPage={currentPage}
                  selected={selectedIds}
                  busy={busy}
                  onSelectionChange={setPickedIds}
                  onNavigate={goToPage}
                  onDelete={deleteSelected}
                  onMove={move}
                  onDropFiles={insertFiles}
                />
              )}
              <Viewer
                key={`viewer-${doc.key}`}
                ref={viewerRef}
                pages={pages}
                scale={scale}
                onCurrentPageChange={setCurrentPage}
                onWidthChange={setViewerWidth}
                onZoom={zoomBy}
              />
              {inspectorOpen && (
                <Inspector
                  mode={mode}
                  tool={tool}
                  toolStyle={toolStyle}
                  selection={annotSelection}
                  busy={busy}
                  focusComment={focusComment}
                  comments={comments}
                  pageSelectionLabel={pageSelectionLabel}
                  canDeletePages={selectedIndices.length < pages.length}
                  actions={actions}
                  onToolStyleChange={changeToolStyle}
                  onUpdateSelected={updateSelectedAndStyle}
                  onDeleteSelected={deleteSelectedAnnot}
                  onOpenComment={openComment}
                />
              )}
            </>
          ) : (
            <div className="empty-state">
              <StackedLockup loading={busy} />
              <div className="kw-dropzone empty-state__drop">
                <h1>{busy ? 'Opening…' : 'Drop a PDF here'}</h1>
                <p className="kw-muted">Or choose one from your computer. Everything happens in this browser; your files stay on your device.</p>
                <button className="kw-btn kw-btn--primary kw-btn--lg" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                  <span>Choose a PDF</span>
                </button>
              </div>
            </div>
          )}
        </main>
      </AnnotationContext.Provider>

      <StatusBar
        page={current ?? null}
        currentPage={currentPage}
        pageCount={pages.length}
        edits={doc?.edits ?? 0}
        redactions={doc?.redactions ?? 0}
        textChars={current ? textChars : null}
      />

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      {dialog === 'commands' && <CommandPalette commands={commands} onClose={() => setDialog(null)} />}
      {dialog === 'signature' && (
        <SignatureDialog
          onClose={() => setDialog(null)}
          onUse={(blob) => {
            setDialog(null)
            placeImage(blob, 'signature', 180)
          }}
        />
      )}
      {dialog === 'watermark' && <WatermarkDialog selectedCount={pickedIds.size} onClose={() => setDialog(null)} onApply={addWatermark} />}
      {dialog === 'ocr' && (
        <OcrDialog
          pages={pages}
          currentPage={currentPage}
          onClose={() => setDialog(null)}
          onDone={(results) => {
            setDialog(null)
            void run("Couldn't add the recognised text", async () => {
              const found = results.filter((r) => r.words.length)
              if (found.length) applyState(await pdf.addOcrText(found))
              const words = found.reduce((n, r) => n + r.words.length, 0)
              const pagesWord = (n: number) => (n === 1 ? '1 page' : `${n} pages`)
              const empty = results.filter((r) => !r.words.length).map((r) => pages.findIndex((p) => p.id === r.page) + 1)
              const emptyNote = empty.length
                ? ` Nothing readable on page${empty.length === 1 ? '' : 's'} ${empty.join(', ')}; if a page is sideways, rotate it and run OCR again.`
                : ''
              notify(
                words ? 'success' : 'info',
                words ? `Recognised ${words} words on ${pagesWord(found.length)}. The text is now searchable.${emptyNote}` : `No text was found.${emptyNote}`,
              )
              setTextChars(null)
            })
          }}
        />
      )}
      {dialog === 'findRedact' && <FindRedactDialog onClose={() => setDialog(null)} onMark={markRedactions} />}
      {dialog === 'applyRedact' && doc && <ApplyRedactionsDialog count={doc.redactions} onClose={() => setDialog(null)} onApply={applyRedactions} />}
      {dialog === 'downloadRedact' && doc && (
        <UnappliedRedactionsDialog
          count={doc.redactions}
          onClose={() => setDialog(null)}
          onApplyAndDownload={() => saveFile(true)}
          onDownloadAnyway={() => saveFile()}
        />
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="kw-dropzone drop-overlay__zone">{doc ? 'Drop to open — or drop on the thumbnails to insert pages' : 'Drop to open'}</div>
        </div>
      )}
    </div>
  )
}
