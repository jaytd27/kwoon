import { createContext, useContext } from 'react'
import type { AnnotInfo, AnnotPatch, AnnotSpec, AnnotStyle, FieldChange, SearchHit, TextLine, TextLineStyle } from '../pdf/protocol'
import type { Tool } from './tools'

export interface AnnotSelection {
  pageId: number
  annotId: number
  /** Filled in once the page's annotation list has been loaded. */
  info: AnnotInfo | null
}

/** What the per-page annotation and form layers need from the app. */
export interface AnnotationController {
  tool: Tool
  style: AnnotStyle
  busy: boolean
  selection: AnnotSelection | null
  /** Matches of the current text search, and which one is current. */
  searchHits: SearchHit[]
  activeHit: number
  select(pageId: number, annot: AnnotInfo | null): void
  /** Called by a page layer whenever its annotation list is (re)loaded. */
  syncAnnotations(pageId: number, annots: AnnotInfo[]): void
  create(pageId: number, spec: AnnotSpec): void
  /** Moves, resizes or edits the selected annotation. */
  updateSelected(patch: AnnotPatch): void
  fillField(pageId: number, widgetId: number, change: FieldChange): void
  /** Replaces a line of existing page text, written in `style`; empty text deletes it. */
  editTextLine(pageId: number, line: TextLine, text: string, style: TextLineStyle): void
}

export const AnnotationContext = createContext<AnnotationController | null>(null)

export function useAnnotations(): AnnotationController {
  const ctx = useContext(AnnotationContext)
  if (!ctx) throw new Error('useAnnotations must be used inside AnnotationContext')
  return ctx
}
