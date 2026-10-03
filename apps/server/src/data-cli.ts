// Data folder commands for testers and the update script:
//   migrate | backup [reason] | list | restore <name> | version
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupData, DATA_VERSION, listBackups, migrateData, readDataVersion, restoreData } from "./migrate.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const dataDir = resolve(process.env.TRELLIS_DATA ?? join(repoRoot, "data"));
const [cmd, arg] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "migrate": {
      const r = await migrateData(dataDir, console.log);
      console.log(r.applied.length ? `Данные обновлены: формат ${r.from} → ${r.to}` : `Данные в порядке, формат ${r.to}`);
      return;
    }
    case "backup": {
      const p = await backupData(dataDir, arg ?? "manual");
      console.log(p ? `Резервная копия: ${p}` : "Папка data пуста, копировать нечего");
      return;
    }
    case "list": {
      const names = await listBackups(dataDir);
      console.log(names.length ? names.join("\n") : "Резервных копий нет");
      return;
    }
    case "restore": {
      if (!arg) throw new Error("Укажите копию: npm run data -- restore <имя> (список: npm run data -- list)");
      await restoreData(dataDir, arg);
      console.log(`Восстановлено из ${arg}. Текущие данные до восстановления тоже сохранены в копию.`);
      return;
    }
    case "version": {
      const v = await readDataVersion(dataDir);
      console.log(`Формат данных: ${v?.version ?? "не записан (1)"}; приложение понимает ${DATA_VERSION}`);
      return;
    }
    default:
      console.log("Команды: migrate | backup [причина] | list | restore <имя> | version");
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${(err as Error).message}`);
  process.exit(1);
});
