/**
 * Limpeza do histórico: posts já publicados (ou que deram erro) saem do banco depois de alguns dias.
 *
 * Os agendados (pending/processing) nunca são tocados. Fica um período de carência, em vez de apagar
 * na hora, porque a aba Resultados do Facebook/YouTube busca as métricas pelo mediaId dos posts
 * publicados, e o histórico do painel é montado a partir deles.
 * Posts de loop de Stories ficam de fora: a dedupe do loop consulta o sourceFile deles para não
 * reenfileirar a mesma mídia.
 */

const DEFAULT_RETENTION_DAYS = 14;

function retentionDays(env = process.env) {
  const n = Number(env.POST_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

async function purgeOldPosts(db, { days = retentionDays(), now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  const result = await db.run(
    `DELETE FROM posts WHERE "status" IN ('success', 'error')
       AND COALESCE("publishedAt", "scheduledAt") < ?
       AND COALESCE("sourceFile", '') NOT LIKE 'loop:%'`,
    [cutoff]
  );
  return result?.changes ?? result?.rowCount ?? 0;
}

module.exports = { purgeOldPosts, retentionDays, DEFAULT_RETENTION_DAYS };
