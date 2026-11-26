# GigaNotes

A local-first, forum-style notes app for keeping track of things as they happen. It's built for **live blogging visual novels**: each game gets its own thread, and you post updates, screenshots, GIFs, and video clips as you play.

Everything stays on your computer. Notes, images, and videos are stored in a local `data` folder, and nothing is uploaded anywhere.

## Features

- **Threads for each project.** Make a thread per visual novel (or any topic). Each thread is a feed of messages, like a forum post or a chat log.
- **Rich media in messages.** Attach screenshots, GIFs, and videos. The app makes thumbnails, reads dimensions and duration, and keeps GIFs animated. Paste images from the clipboard or drag and drop files.
- **Link previews.** Links you post show a preview card with title and image.
- **Quick capture.** A global hotkey (default `Ctrl+Shift+N`, changeable in Settings) opens a small window to jot down a note from anywhere, even when the app is in the background.
- **Status and tags.** Mark each thread as *Playing*, *Finished*, *Dropped*, or *Plan to play*, and add tags. Filter the home screen by status.
- **Continue.** A button on the home screen jumps back to the thread you opened most recently.
- **Pins.** Pin important messages in a thread. A side panel lists all pins, and clicking one scrolls the feed to it.
- **Search.** Search across messages and threads.
- **Thread covers.** Each thread can use a custom cover image, or the first image in the thread.
- **Trash.** Deleted threads and messages go to the Trash first, where you can restore them.
- **Export and import.** Export a thread to share it or back it up. Import Discord HTML chat exports (one thread per file) or GigaNotes thread folders.
- **Windows desktop app.** Packaged as a portable `.exe`. No installer or internet connection needed.

## Download

Go to the [Releases page](https://github.com/deltadork/GigaNotes/releases) and download the latest `GigaNotes-x.y.z-windows-portable.exe`. Double-click it to run. Your notes are stored next to the app in its `data` folder.

## Run from source

Requirements: [Node.js](https://nodejs.org/) (LTS recommended) and [Git](https://git-scm.com/).

```bash
git clone https://github.com/deltadork/GigaNotes
cd GigaNotes
npm install
```

Then pick one of these:

| Command | What it does |
| --- | --- |
| `npm run app` | Builds the app and opens it in the Electron desktop window |
| `npm run dev` | Runs the API server and the Vite dev server for the browser UI with hot reload |
| `npm run build:app` | Builds the frontend and server without starting anything |
| `npm run dist` | Builds the Windows portable `.exe` into `release/` |

The API server listens on `127.0.0.1` only. The data folder defaults to `data/` in the project; set the `GIGA_DATA` environment variable to use a different location.

## Project layout

```
electron/   Desktop shell (window, quick-capture hotkey, preload bridge)
server/     Local API (Hono + node:sqlite), media processing (sharp, ffmpeg), link previews, import/export
src/        React frontend: home, thread view, capture, settings, trash
data/       Created at runtime: SQLite database and media files (not in git)
```

## Tech stack

- **Frontend:** React 19, TypeScript, Vite
- **Desktop:** Electron, electron-builder
- **Backend:** Hono on Node, built-in `node:sqlite` database
- **Media:** sharp (images), ffmpeg / ffprobe (video and GIF handling)

## Backups

Your notes live in the `data` folder: `data/` for the database and media files. Copy that folder to back it up, or to move your notes to another computer.

## License

MIT. See [LICENSE](LICENSE).
