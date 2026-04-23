import path from 'path';
import Knex from 'knex';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require('./knexfile').default as Knex.Config;
  const knex = Knex(config);
  try {
    const [batch, migrations] = await knex.migrate.rollback();
    if (migrations.length === 0) {
      console.log('Nothing to roll back.');
    } else {
      console.log(`Rolled back batch ${batch}: ${migrations.length} migration(s)`);
      for (const m of migrations) console.log(`  - ${m}`);
    }
  } finally {
    await knex.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
