# Kwoon

An open-source PDF editor that runs entirely in your browser, built on [MuPDF.js](https://mupdf.readthedocs.io/). Your files never leave your device.

Live: https://kwoon.pages.dev (deployed from `main`).

## Features

- [x] View and render PDFs (thumbnails, zoom, fit width), search the text, and a Ctrl+K command bar
- [x] Modes (View, Annotate, Edit, Organize, Sign, Protect), an inspector with properties, comments and page actions, and a status bar
- [x] Page operations: reorder (drag and drop), rotate, delete, insert blank pages, insert/merge other PDFs, extract pages to a new PDF
- [x] Undo / redo
- [x] Annotations: highlight, underline, strikeout, sticky notes with comments, rectangles, ellipses, lines, arrows, freehand ink — with color, width and opacity, move and delete
- [x] Form filling (AcroForm): text, multiline, checkboxes, radio buttons, dropdowns and list boxes, with Tab navigation and undo
- [x] Add content: text boxes (font, size, color), images (PNG, JPEG, WebP, GIF with transparency), drawn or typed signatures (saved for reuse), and text watermarks; resize handles for shapes and images
- [x] True redaction: mark text or areas (or find & mark every match), then permanently remove the text, image pixels, graphics, annotations and form values underneath; downloading warns about unapplied marks
- [x] OCR for scanned documents (Tesseract.js, in the browser): adds an invisible text layer so scans can be searched, selected, highlighted and redacted; 7 languages; skips pages that already have text
- [x] In-place editing of existing text: click a line to change or delete it, and restyle it (font, size, bold, italic, colour) from the bar above it; new text keeps the line's position and angle, and starts in its size and colour and the closest standard font

## Known limitations

- Text you add or edit (text boxes, edited lines, watermarks, OCR) uses the standard PDF fonts, so only Latin characters are supported, and edited lines use the closest standard font rather than the document's own.
- Edited text doesn't reflow: each line is replaced on its own.
- OCR needs pages to be upright; rotate sideways scans first. Its engine and language data are downloaded from a CDN on first use.
- Form JavaScript (calculations, validation) and XFA forms aren't supported.
- No cryptographic digital signatures, PDF-to-Office conversion, or special handling for badly broken files.

## Design

The interface uses the **Graphite** theme (Kwoon theme package v2): Moonlit (dark) by default, with Daylight (light) and Follow system, a single violet accent for state, Space Grotesk / IBM Plex Sans / IBM Plex Mono (self-hosted via Fontsource), and the crescent-and-K mark with the tagline *A moonlit home for your documents*. Tokens and component styles live in `src/theme/`; see the design guidelines that came with the theme package for the reasoning.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # fixtures, engine tests and browser tests (uses a local Chrome)
```

See `CLAUDE.md` for architecture notes, MuPDF quirks and testing details.

## License

Kwoon is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE), as required by its use of MuPDF.
