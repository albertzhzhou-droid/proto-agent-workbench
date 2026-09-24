# Chat document parsing

Chat can attach PDF, DOCX and XLSX files from the file picker or import them from a path inside the current workspace. Text, source-code and `.ipynb` documents retain the editable text workflow.

## Reading and provenance

- PDF text is grouped by its real one-based page number. Image-only pages explicitly report that OCR is required. The reader does not infer content from scanned images.
- DOCX paragraphs, table rows, headers, footers, footnotes, endnotes and comments retain their source XML part and paragraph/table locations. The text follows document order. Tracked deletions and field instructions are omitted; field results remain readable.
- XLSX extraction reads each sheet's populated cells, including labelled hidden sheets. Each cell retains its address, value and formula text when present. Formula values come from the file's cache; formulas, macros, external links and embedded objects are never executed. Numeric date cells currently retain spreadsheet serial values.

The original attachment, complete extracted text and structured JSON are saved separately under `build/chat/<conversation>/documents/<document>/`. Source SHA-256 and extraction SHA-256 bind each imported document to those artifacts. Workspace imports preserve the existing source. Importing from a selected file also preserves its exact bytes in the artifact directory.

The document panel pages through the extraction and shows source paths, hashes and reading notes. A source document remains read-only. **Create draft from this page** makes an editable Markdown copy of the displayed extraction; it does not rewrite the original Office file or PDF. Export of a parsed document points to the complete `extracted.txt` artifact.

Each selected source contributes an indexed excerpt of at most 12,000 characters to a conversation message. Its extraction metadata reports the full size and section count. Research tools can read remaining sections or use the saved complete extraction; the excerpt is not labelled as the complete document.

## Limits and failure behavior

Attachments are bounded to 20 MiB. Office ZIP input is checked before and during decompression, with at most 10,000 entries, 64 MiB of declared total expansion and 24 MiB per entry. Parsing rejects duplicate/unsafe paths, encrypted Office entries, XML DTD/entity declarations and XML deeper than 128 elements. No archive files are extracted to caller-controlled paths.

PDF extraction permits up to 1,000 pages. XLSX permits up to 256 sheets, 200,000 shared strings and 100,000 populated cells. A complete text extraction is limited to 8 MiB and 50,000 sections; structured artifacts are limited to 24 MiB. Exceeding a limit produces an actionable error instead of a silently partial extraction. Large PDF pages and DOCX paragraphs are split into labelled continuation sections.

Password-protected PDFs require an unlocked copy. Text extraction does not reproduce original page layout, chart rendering, images or mathematical typesetting. Reading notes make these limitations visible beside the result.

## Runtime and verification

The desktop and browser preview use the same Node service. Runtime dependencies are Mozilla PDF.js (`pdfjs-dist` 6.3.289), `yauzl` 3.4.0 and `fast-xml-parser` 5.11.1; parsing does not depend on a separately installed Python document stack.

`apps/proto-workbench/tests/research-documents.test.mjs` exercises selectable PDF pages, DOCX reading order/tables/footnotes, XLSX cell/formula provenance, lossless large-document pagination, source hashes, extraction tamper detection, path containment, invalid archives, XML entity rejection, and Chat import/read/export behavior. Reviewable fixtures are generated under `build/chat-qa/document-fixtures/` when the test's `PROTO_DOCUMENT_FIXTURE_DIR` environment variable points there.
