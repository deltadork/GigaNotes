# Review notes (for the final Sonnet review pass)

Uncertain or untested spots, collected while building on Haiku.

## Phase 3: paste, drag-drop, upload, media
- **Not tested in a real browser.** Server upload was tested with curl (image + video: dimensions, duration, thumbnails, media URLs all return 200). Paste (Ctrl+V of a screenshot), drag-drop and the "+" picker still need a manual check.
- **Video probe fixed:** `server/media.ts` used `-show_entries ... side_data=rotation`, which made ffprobe dump packets and broke JSON parsing on every video upload. Now it uses `-show_streams -show_format`. Rotation is read from `side_data_list` / `tags.rotate`; not yet tested on a rotated phone video.
- **GIFs** render from the original file (so they animate). Their thumbnail is not used in the feed. Large GIFs will be slow.
- **Media boxes** use inline `aspect-ratio` from stored width/height, falling back to 16:9 when missing. Check that no layout shift happens while scrolling up through old media (not yet tested with load-older).
- **Draft per thread (hard requirement 7)** is not implemented yet. Not part of phase 3 as built so far.
- **Failed send** restores text and files to the composer. Should be checked when the server is down.
- **Preview URLs** are revoked on send, on remove, and on leaving the thread. Not checked for leaks.

## Phase 4: load older messages, stick to bottom
- **Paging API tested** with curl: 250 messages gave pages of 100, 100, 51 with `hasMore` correct.
- **Scroll behavior not tested in a browser.** Check: scrolling up loads older messages and the view stays on the same message; no jump when an older page is added; no fight between the "restore position" step and the "stick to bottom" step.
- **Scroll chaining:** when the view is still within 200px of the top after a load, it loads again. A short thread can load all its pages at once. Check that this does not trigger on every render.
- **Race:** a late older-page response is dropped if the user switched threads. The `loadingOlder` flag is reset in `finally`.
- **Composer growth:** the feed shrinks when the composer grows (pending files, multi-line text), so a user at the bottom may stop being at the bottom. Not handled yet.

## Phase 5: draft per thread (requirement 7)
- Drafts are text only, stored in `localStorage` under `giganotes-draft-<id>`. Attached files are not kept.
- **Tradeoff:** localStorage lives in the browser profile, not in the `data` folder, so drafts are not part of the backup. Moving drafts to the server would need a schema change (Sonnet task).
- Not tested in a browser: draft restores when switching threads and when reopening the app; draft clears on send; draft returns if a send fails.

## Phase 6: status (requirement 8)
- Chip on cards and the home filter pills already existed. Added: `PATCH /api/threads/:id/status` (tested: 200 on valid, 400 on bad status, 404 on missing thread) and a header chip that moves to the next status on click.
- The click cycles in fixed order (Playing → Finished → Dropped → Plan to play → Playing). Not a dropdown. Check that this is what you want.
- Failed save reverts the chip and shows an error line. Not tested in a browser.

## Phase 7: Continue (requirement 9)
- Opening a thread calls `POST /api/threads/:id/open`, which sets `last_opened_at` (tested: 200, 404 for missing thread).
- Home shows a "Continue" button in the header when some thread has been opened. It links to the thread with the latest `lastOpenedAt`. Hidden until something has been opened.
- Not tested in a browser. Check the button text and placement at the top of the home screen.

## Phase 8: pins (requirement 10)
- Server: `PATCH /api/messages/:id/pin` and `GET /api/threads/:id/pins` (tested with curl: pin, list, unpin, 400 on bad value).
- Pin button (📌) on each message, shown on hover or when pinned. Header "Pinned (n)" button opens a right-side panel with text and media. Esc or ✕ closes it. Open/closed state is remembered in localStorage (`giganotes-pins-open`).
- Clicking a pinned message in the panel scrolls to it in the feed. If it is older than the loaded messages, older pages are loaded first (loop until found, then merged in). Flashes for 1.6s.
- **Untested in browser:** jump across many pages; the scroll-after-prepend logic in `jump` and the layout effect; panel width squeezing the feed on narrow windows; Esc when focus is in the textarea.
- Panel is 320px wide, so the feed narrows when it is open.

## Phase 9: desktop app and quick capture (requirement 11)
- **Stack:** Electron 45 (embeds Node 24). No Rust here, so Tauri was not an option. `better-sqlite3` was replaced by the built-in `node:sqlite`, because a native module would need a C++ compiler to match Electron's Node. Behind a small wrapper in `server/index.ts`, so the server code is otherwise unchanged.
- **Server in the app:** `server/index.ts` is bundled to `dist-server/server.mjs` (esbuild) and imported by `electron/main.cjs`. When `GIGA_STATIC` is set, the server also serves `dist/` on port 3001. The app is one process, no child process.
- **Quick capture:** global hotkey Ctrl+Shift+N (`HOTKEY` in `electron/main.cjs`) shows a small always-on-top window (`#/capture`). Thread picker defaults to the last thread opened. Enter saves and closes, Esc closes, paste and drop work. The window is created at startup and reused, and closing it only hides it.
- **Tray:** closing the main window hides it. The app keeps running (hotkey + tray). Quit is in the tray menu. Single instance only.
- **Data folder:** dev uses the project `data/`. The portable exe uses `data/` next to the exe.
- **Verified:** the bundled server runs on Electron's Node (API, media, static, attachments). The Electron app starts, the main window shows the real library, and Ctrl+Shift+N (sent with SendKeys) shows the capture window, which defaults to the last thread.
- **Not verified:** saving from capture (no test message was sent to the real library); paste/drop in capture; tray menu; quit behavior; hotkey conflicts; a fresh machine without the project folder.
- **Not done:** start at login; app icon for the exe (only the tray icon is set); code signing.

## Packaging (done)
- `npm run dist` produces `release/GigaNotes 0.1.0.exe` (portable, about 213 MB, unsigned, default Electron icon).
- Launched the exe: it unpacks to a temp folder first, so the server takes about 15–40 seconds to answer on a cold start. Then the API answers and a `data/` folder is created next to the exe (`giganotes.db` and `media/`). Closed afterwards.
- The test run created `release/data/` with an empty database. Delete it before shipping if you don't want it.

## Still open
- Manual checks listed under "Sonnet review pass".

## Sonnet review pass (2026-11-19)
Tested against a scratch library (`GIGA_DATA=C:\Work\scratch-giga\data`, 250 seeded messages with images), never the real `data/`. Browser tests drove headless Edge through the DevTools protocol; shell tests ran the real Electron app.

**Verified (passing):** opens at bottom; older pages load with the same message staying at the same pixel offset (pages 100/100/50); no further loading at the top once everything is loaded; own send scrolls to bottom; composer growth keeps a bottom-pinned user at the bottom and does not move a user who scrolled up; draft restores after reload; pin panel open state remembered; pin jump across unloaded pages lands the message in view and stays stable; Esc closes the panel with focus in the textarea; Electron: second launch exits and leaves the first running; quick capture saves text plus a dropped file into the default thread; server rejects foreign Origin/Host (403), bad `%` escapes (400), `..` paths (403/404), directories (404), range requests (206/416).

**Fixed:**
- `src/Thread.tsx` layout effect consumed `forceBottom` on the empty first render, so bottom-on-open depended on luck. It now waits for `loaded`. `App.tsx` also gives `ThreadView` a `key`, so switching threads resets all state (attached files could have been sent to the wrong thread).
- `src/Thread.tsx`: feed `ResizeObserver` keeps a bottom-pinned user at the bottom when the composer, window or pins panel resizes (was listed as open in Phase 4).
- `src/Thread.tsx` send: a send that finishes or fails after leaving the thread no longer appends to, or restores text into, another thread; text typed during a failed send is no longer lost.
- `src/api.ts`: thread/messages/pins fetches now check `r.ok`; load, older-page and jump failures show an error instead of a blank view or an unhandled rejection.
- Paste (`pastedFiles` in `src/api.ts`, used by Thread and Capture): Ctrl+V of rich text (Word, web pages) no longer turns into an image attachment; text wins when the clipboard has plain text.
- `src/Capture.tsx`: file drop was claimed but missing; added. A drop outside a drop zone no longer navigates the window to the file. "No thread" now shows a message instead of silently doing nothing.
- `server/index.ts`: Origin/Host guard (other websites could POST to localhost without a preflight); JSON bodies like `null` no longer crash routes; media and static handlers decode safely and refuse NUL bytes and directories; media now streams (an open-ended `Range: bytes=0-` used to load the whole video into memory); an upload failure returns JSON and removes the files it wrote.
- `server/media.ts`: file extension is whitelisted (`.[a-z0-9]{1,5}`); a corrupt or unsupported image/video (HEIC, bad ffprobe) is stored as a plain file instead of failing the whole message.
- Thread cards had no cover image ever (nothing set `cover_path`): cover now falls back to the thumbnail of the thread's first image or GIF.
- `electron/main.cjs`: single-instance lock used `app.exit(0)` but the rest of startup still ran; now guarded. Refuses to start if port 3001 already answers (it would have shown the dev server's data). Windows only navigate to the local server. `session-end` lets Windows shut down instead of being blocked by hide-on-close. `GIGA_DATA` from the environment is honoured (for tests).
- Deleted `release/data`; rebuilt `release/GigaNotes 0.1.0.exe` with these fixes.

**Still open / not fixed:**
- Drafts are text-only, in the Electron profile (`%APPDATA%`), not in `data/` (known tradeoff). Last-thread and pins-open flags live there too.
- A message saved from quick capture does not appear in an already-open thread until it is reopened (no live refresh).
- Media with no stored width/height uses a 16:9 box; GIFs are shown from the original file.
- Fixed port 3001; a hotkey conflict shows an error dialog at startup.
- Not tested: real clipboard screenshot paste and OS file drag from Explorer (only synthetic events), rotated phone video, a slow network while scrolling through media, tray menu, the exe on a clean machine, start at login, app icon.

## Batch: search, status/tag filter, edit, day dividers, link previews, trash (built on Haiku, per request)
Schema changes (run automatically on first start; additive, ALTER TABLE ADD COLUMN):
`messages.edited_at`, `messages.deleted_at`, `threads.deleted_at`, new table `link_previews`.

- **Trash:** delete now moves threads and messages to Trash (`deleted_at`). Every list, count, cover, pin, export and message query excludes trashed rows. Restore and "Delete for good" in `#/trash`; "Empty Trash" wipes all. Items older than 30 days are purged at startup and hourly (`purgeExpired` in `server/index.ts`). **Not tested:** the 30-day purge itself (needs an old `deleted_at`).
- **Edit:** `PATCH /api/messages/:id` (text only, empty refused, sets `edited_at`). Feed shows "(edited)". Enter saves, Shift+Enter newline, Esc cancels. Tested with curl.
- **Search:** `GET /api/search?q=` (messages, LIKE with escaped wildcards, excludes trash, max 50). Home search box also filters threads by title and tags. Hit links go to `#/thread/ID?m=MSG`, which jumps to that message (`focus` prop in `Thread.tsx`). **Not browser-tested:** the jump from a hit.
- **Filters:** status pills and a new tag dropdown combine with the search box. Browser-untested.
- **Day dividers:** `.day-sep` (sepia, 12px, centred) where the day changes. Browser-untested. The first loaded message always gets one, even if older messages on the same day are not loaded.
- **Link previews:** `server/links.ts`. `GET /api/link-preview?url=` fetches the page (6 s timeout, 512 KB max, up to 3 redirects, http/https only) and reads og/twitter/meta tags. Private, loopback and link-local addresses are refused, checked on every redirect hop. Results cached in `link_previews` (failures are cached too, so they are not retried). The image is hot-linked from the site by the browser (`referrerPolicy=no-referrer`). Cards have a fixed 84px height so loading does not shift the feed. Tested: public `example.com` returned its title; `127.0.0.1` returned the fallback; `file://` gave 400. **Not tested:** redirect chains, DNS-rebinding (the check happens before the connection, not pinned to it), and the browser-side image load.
- **Launch build:** `release-new\win-unpacked\GigaNotes.exe` (new; `release-dir\win-unpacked-prev` untouched). Its `data\` is a copy of `win-unpacked-prev\data`. It started and served the library; the migration ran on the copy.

## Batch: txt reader in the right-side panel (built on Haiku, per request)
- **Change:** clicking a `.txt` attachment opens `TextReader` (`src/Thread.tsx`) in a right-side column (`.side`, 380px). It takes the top half of the column; the pinned panel, if open, takes the rest. Fetches the file as text, shows it in `pre` with wrapping. Save button downloads the original; ✕ or Esc closes (Esc closes the reader before the pins panel). Other files still download.
- **Detection:** `isText()` = file kind with a `.txt` name or `text/plain` MIME. Non-`.txt` text files (md, log, csv) still download.
- **Layout change:** pins panel width moved from 320px to the shared 380px column; it no longer owns its own border.
- **Not browser-tested.** `tsc --noEmit` passes; `vite build` was not run (it would overwrite `dist`). Check: UTF-8 Japanese text displays correctly, a large txt scrolls inside the reader, the feed keeps its scroll position when the reader opens, and the pins panel still works with the reader open.
- **Possible gap:** the fetch assumes UTF-8. A Shift-JIS or other legacy-encoded txt will show garbled characters.
