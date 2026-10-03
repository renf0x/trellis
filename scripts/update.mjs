// Safe update for testers: backup data → get the new version → npm install → migrate data → show changes.
// data/ (docs, cases, chats, analyses, settings, keys) is never touched by git; this script only adds a backup.
//   update.cmd                    — update this folder from git
//   update.cmd --from "D:\old"    — new version unpacked from a zip: take data/ from the old folder
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const dataDir = resolve(process.env.TRELLIS_DATA ?? join(root, "data"));
const backups = `${dataDir}-backups`;
const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const from = fromIdx >= 0 ? resolve(args[fromIdx + 1] ?? "") : null;

const say = (s) => console.log(s);
const fail = (s) => {
  console.error(`\n✗ ${s}`);
  process.exit(1);
};
// Only npm needs a shell on Windows (npm.cmd); git and node run directly so arguments stay intact.
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, encoding: "utf8", shell: cmd === "npm" && process.platform === "win32", ...opts });
const exists = (p) => stat(p).then(() => true, () => false);
const isEmpty = async (p) => !(await exists(p)) || (await readdir(p)).length === 0;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function main() {
  say("Trellis: обновление\n");
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) fail(`Нужен Node.js 22.13 или новее, сейчас ${process.versions.node}`);

  // A running server holds the database open and would restart mid-update.
  const alive = await fetch("http://127.0.0.1:4317/api/modules", { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (alive) fail("Trellis запущен. Закройте окно приложения (npm run dev / start.cmd) и запустите обновление снова.");

  // 1. Backup.
  if (!(await isEmpty(dataDir))) {
    const git = run("git", ["rev-parse", "--short", "HEAD"]).stdout?.trim() || "nogit";
    const dest = join(backups, `${stamp()}-before-update-${git}`);
    await mkdir(backups, { recursive: true });
    await cp(dataDir, dest, { recursive: true, filter: (s) => !s.endsWith(".tmp") });
    say(`✓ Резервная копия данных: ${dest}`);
  }

  // 2. New version.
  let before = null;
  if (from) {
    const src = join(from, "data");
    if (!(await exists(src))) fail(`В ${from} нет папки data`);
    if (resolve(src) === dataDir) fail("--from указывает на эту же папку");
    await rm(dataDir, { recursive: true, force: true });
    await cp(src, dataDir, { recursive: true, filter: (s) => !s.endsWith(".tmp") });
    say(`✓ Данные перенесены из ${src}`);
  } else if (await exists(join(root, ".git"))) {
    const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
    if (dirty) {
      fail(`Изменены файлы приложения (папка data не в счёт):\n${dirty}\n` +
        "Сохраните их отдельно или отмените (git stash), затем повторите обновление.");
    }
    before = run("git", ["rev-parse", "HEAD"]).stdout.trim();
    // Files the new version adds but that already lie here untracked (e.g. arbor.py copied by hand)
    // would stop the pull: move them into the backups folder first.
    if (run("git", ["fetch", "--quiet"], { stdio: "inherit" }).status === 0) {
      const added = run("git", ["diff", "--name-only", "--diff-filter=A", "HEAD", "@{u}"]).stdout?.split(/\r?\n/).filter(Boolean) ?? [];
      const aside = join(backups, `${stamp()}-untracked`);
      for (const f of added) {
        if (!(await exists(join(root, f)))) continue;
        await mkdir(dirname(join(aside, f)), { recursive: true });
        await rename(join(root, f), join(aside, f));
        say(`✓ ${f} есть в новой версии, прежний файл перенесён в ${aside}`);
      }
    }
    say("… Загрузка новой версии (git pull)");
    const pull = run("git", ["pull", "--ff-only"], { stdio: "inherit" });
    if (pull.status !== 0) fail("git pull не прошёл. Данные не менялись; копия сохранена выше.");
  } else {
    say("Папка без git: распакуйте новую версию в новую папку и запустите там  update.cmd --from \"<старая папка>\"");
  }

  // 3. Dependencies.
  say("… Установка зависимостей (npm install)");
  const npm = run("npm", ["install", "--no-audit", "--no-fund"], { stdio: "inherit" });
  if (npm.status !== 0) fail("npm install не прошёл. Данные не менялись; копия сохранена выше.");

  // 4. Data format.
  const mig = run(process.execPath, ["--import", "tsx", "apps/server/src/data-cli.ts", "migrate"], { stdio: "inherit" });
  if (mig.status !== 0) fail("Миграция данных не прошла. Восстановить: npm run data -- list, затем npm run data -- restore <имя>");

  // 5. What changed.
  if (before) {
    const log = run("git", ["log", "--no-merges", "--pretty=format:  - %s", `${before}..HEAD`]).stdout.trim();
    say(log ? `\nЧто нового:\n${log}` : "\nУ вас уже последняя версия.");
  }
  const changelog = await readFile(join(root, "docs", "CHANGELOG.md"), "utf8").catch(() => "");
  const top = changelog.split(/\n(?=## )/)[1];
  if (top) say(`\n${top.trim()}`);
  say("\n✓ Готово. Запустите приложение: start.cmd (или npm run dev)");
}

main().catch((e) => fail(e.message));
