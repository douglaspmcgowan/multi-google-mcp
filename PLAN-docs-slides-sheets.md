# Plan — Docs, Slides and Sheets editing in multi-google

Douglas, 2026-09-17: *"please do some research into google drive apis and the best way to control all
that and then yes you can change it. come up with a plan and we can do it."*

## The finding that changes the shape of this

**No re-consent is needed.** Docs `documents.batchUpdate`, Slides `presentations.batchUpdate` and
Sheets `spreadsheets.batchUpdate` each accept `https://www.googleapis.com/auth/drive` as an
alternative to their own scope, and `config.ts` `SCOPES` already requests it. The `personal`,
`berkeley` and `pyrgos` tokens carry it today. Only `bhouse` would need `npm run add-account`.

This corrects what I told Douglas earlier in the session — I said `auth/documents` had to be added
and the accounts re-authorized. Verified against the three reference pages, 2026-09-17.

## What each API buys over the HTML-replace route we have

| | Today (`drive_update_content` with `html`) | With batchUpdate |
|---|---|---|
| Docs | Replaces the entire file. Destroys in-place edits by anyone else; cannot touch comments. | Targeted: `replaceAllText`, `insertText`, `deleteContentRange`, `updateTextStyle`, `updateParagraphStyle`, tables, images, comments, headers/footers. |
| Slides | **No HTML import exists.** A deck can only be created by uploading a real `.pptx` for conversion. | `createSlide`, `insertText`, `replaceAllText`, `createImage`, `replaceAllShapesWithImage`, tables, speaker notes. |
| Sheets | CSV/XLSX upload converts fine for bulk data in. | `values.update`/`append` for cells; `batchUpdate` for formatting, conditional formats, frozen rows, charts, new tabs. |

Keep the HTML route. It stays the right tool for a document this session owns end to end; batchUpdate
is for revising a document someone else is also editing, and for everything Slides.

## Build

1. `npm i @googleapis/docs @googleapis/slides @googleapis/sheets`. Same per-API package style as the
   existing `@googleapis/drive`, so startup stays fast and the deferred-import pattern in
   `src/tools/drive.ts` carries over unchanged.
2. `src/tools/docs.ts`
   - `docs_get_structure` — `documents.get`, returned as a compact outline of paragraph index ranges
     and their text, because raw `documents.get` is far too large to put in a model's context.
   - `docs_replace_text` — `replaceAllText`, the safe 90% case; takes a list of find/replace pairs.
   - `docs_batch_update` — an escape hatch taking a raw `requests` array for anything the wrappers
     do not cover.
3. `src/tools/slides.ts` — `slides_get_structure`, `slides_replace_text`, `slides_create_from_outline`
   (title + bullets per slide, the common ask), `slides_batch_update`.
4. `src/tools/sheets.ts` — `sheets_read_range`, `sheets_write_range`, `sheets_append_rows`,
   `sheets_batch_update`.
5. Tests in `test/`, faking the client exactly as `test/drive.test.ts` does, so they need no network
   and no tokens.
6. Update `.agents/references/multi-google.md` and
   `.agents/manifests/multi-google-accounts.json` in the same unit of work.

## Constraints carried forward

- **No destructive surface.** As with Drive, nothing that permanently deletes. `deleteContentRange`
  is scoped to an explicit index range the caller passes and is never wrapped in a
  "clear the document" convenience.
- **Index ranges are fragile.** Every index in a Docs request refers to the document *as it was
  read*, and each applied request shifts the ones after it. The tools therefore submit a whole batch
  in one call — the API applies it atomically and rejects the batch entirely if any request is
  invalid — and `docs_get_structure` is re-read after any write rather than reusing stale indices.
- **Never echo token values.** Unchanged.

## Cost

Roughly an hour, mostly the structure-summarizing in `docs_get_structure` and `slides_get_structure`,
which is the only part that is not mechanical.
