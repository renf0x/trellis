# Trellis: rules for an agent working in this folder

Trellis is a local QA app (docs, test cases, comparison and analysis). The user is a tester. Answer in Russian.

## Data is sacred

- `data/` holds everything the tester has: docs and cases, chats, analyses and their archive, doc remarks,
  workbench drafts, settings, encrypted keys and tokens. Never delete, move, rewrite or commit it.
- `data-backups/` holds backups made by the updater. Don't delete them unless the tester asks for it.
- Never print, copy or commit keys and tokens.

## Updating the app

When the tester asks to update (обнови, обновление, новая версия):

1. Make sure Trellis is not running (the `start.cmd` / `npm run dev` window). If it is, ask the tester to close it.
2. Run `node scripts/update.mjs` (it is what `update.cmd` runs, without the final `pause`).
   It backs up `data/`, runs `git pull --ff-only`, `npm install`, migrates the data format and prints what's new.
3. Show the tester the "what's new" part of the output, then they start the app with `start.cmd`.

Don't update with a bare `git pull` / `npm install`, and never use `git reset --hard`, `git clean`, `git stash`
or force-pull. If the script stops with an error, show the message and the hints in `docs/UPDATE.md`; the data
stays as it was and the backup is already made.

- A new version from a zip: `node scripts/update.mjs --from "C:\path\to\old\folder"` in the new folder.
- Backups: `npm run data -- list`, `npm run data -- restore <name>`, `npm run data -- backup "note"`.

## Other

- Start: `start.cmd` (or `npm run dev`), then http://127.0.0.1:5173.
- Checks after code changes: `npm test`, `npm run typecheck`.
- What's new: `docs/CHANGELOG.md`. Update guide for people: `docs/UPDATE.md`.
