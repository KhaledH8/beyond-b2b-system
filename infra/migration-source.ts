import type { Knex } from 'knex';
import fs from 'fs';
import path from 'path';

interface MigrationEntry {
  module: string;
  file: string;
}

/**
 * Loads migration files from all module subdirectories under infra/migrations/.
 * Files are sorted globally by filename, so timestamp prefixes (YYYYMMDDHHMMSS)
 * control cross-module execution order.
 */
export class ModuleMigrationSource
  implements Knex.MigrationSource<MigrationEntry>
{
  private readonly migrationsDir = path.resolve(__dirname, 'migrations');

  async getMigrations(_loadExtensions: readonly string[]): Promise<MigrationEntry[]> {
    const entries: MigrationEntry[] = [];

    const modules = fs
      .readdirSync(this.migrationsDir)
      .filter((name) =>
        fs.statSync(path.join(this.migrationsDir, name)).isDirectory(),
      );

    for (const mod of modules) {
      const moduleDir = path.join(this.migrationsDir, mod);
      const files = fs
        .readdirSync(moduleDir)
        .filter(
          (f) =>
            /\.(ts|js)$/.test(f) &&
            !f.endsWith('.d.ts') &&
            f !== '.gitkeep',
        );
      for (const file of files) {
        entries.push({ module: mod, file });
      }
    }

    return entries.sort((a, b) => a.file.localeCompare(b.file));
  }

  getMigrationName(entry: MigrationEntry): string {
    return entry.file;
  }

  async getMigration(entry: MigrationEntry): Promise<Knex.Migration> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(this.migrationsDir, entry.module, entry.file));
  }
}
