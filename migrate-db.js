/**
 * Copia os dados de um Postgres para outro (ex: Neon -> Supabase).
 *
 * Pré-requisito: o banco de DESTINO já precisa ter as tabelas criadas.
 * Isso acontece sozinho quando o app sobe apontando para ele (initDB roda
 * os CREATE TABLE IF NOT EXISTS). Então a ordem é:
 *
 *   1. Trocar a DATABASE_URL no Render para o banco novo e esperar o deploy
 *   2. Rodar este script para copiar os dados do banco antigo
 *
 * Uso (PowerShell):
 *   $env:SOURCE_URL="postgresql://...neon.tech/neondb?sslmode=require"
 *   $env:TARGET_URL="postgresql://...supabase.co:5432/postgres"
 *   node migrate-db.js
 *
 * Rode com --dry-run para só contar as linhas, sem escrever nada.
 */

// Credenciais ficam em .env.migration (ignorado pelo git), nunca na linha de comando.
require('dotenv').config({ path: '.env.migration' });

const { Pool } = require('pg');

// Ordem importa: accounts antes de posts por causa da referência accountId.
const TABLES = ['global_config', 'accounts', 'posts', 'push_subscriptions'];

const DRY_RUN = process.argv.includes('--dry-run');

const { SOURCE_URL, TARGET_URL } = process.env;

if (!SOURCE_URL || !TARGET_URL) {
  console.error('❌ Defina SOURCE_URL e TARGET_URL antes de rodar.');
  process.exit(1);
}

const source = new Pool({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
const target = new Pool({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

/** Colunas em comum entre origem e destino, para sobreviver a diferenças de schema. */
async function sharedColumns(table) {
  const q = 'SELECT column_name FROM information_schema.columns WHERE table_name = $1';
  const [src, tgt] = await Promise.all([source.query(q, [table]), target.query(q, [table])]);
  const tgtCols = new Set(tgt.rows.map(r => r.column_name));
  return src.rows.map(r => r.column_name).filter(c => tgtCols.has(c));
}

async function migrateTable(table) {
  const cols = await sharedColumns(table);

  if (cols.length === 0) {
    console.log(`⏭️  ${table}: tabela não existe nos dois lados, pulando`);
    return;
  }

  const list = cols.map(c => `"${c}"`).join(', ');
  const { rows } = await source.query(`SELECT ${list} FROM "${table}"`);

  if (rows.length === 0) {
    console.log(`➖ ${table}: vazia na origem`);
    return;
  }

  if (DRY_RUN) {
    console.log(`🔍 ${table}: ${rows.length} linhas seriam copiadas (${cols.length} colunas)`);
    return;
  }

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  // ON CONFLICT DO NOTHING deixa o script seguro para rodar mais de uma vez.
  const insert = `INSERT INTO "${table}" (${list}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

  let ok = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const res = await target.query(insert, cols.map(c => row[c]));
      res.rowCount > 0 ? ok++ : skipped++;
    } catch (e) {
      console.error(`   ⚠️  linha ignorada em ${table}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`✅ ${table}: ${ok} copiadas, ${skipped} ignoradas (de ${rows.length})`);
}

(async () => {
  console.log(DRY_RUN ? '🔍 DRY RUN — nada será escrito\n' : '🚚 Migrando dados\n');

  try {
    await source.query('SELECT 1');
  } catch (e) {
    console.error('❌ Não consegui conectar na ORIGEM:', e.message);
    console.error('   Se o projeto do Neon estiver pausado por cota, a conexão só volta quando a cota resetar.');
    process.exit(1);
  }

  try {
    await target.query('SELECT 1');
  } catch (e) {
    console.error('❌ Não consegui conectar no DESTINO:', e.message);
    process.exit(1);
  }

  for (const table of TABLES) {
    try {
      await migrateTable(table);
    } catch (e) {
      console.error(`❌ ${table}: ${e.message}`);
    }
  }

  await source.end();
  await target.end();
  console.log('\nFim.');
})();
