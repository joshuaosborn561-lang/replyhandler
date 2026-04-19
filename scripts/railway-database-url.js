/**
 * Shared helpers for scripts that connect to Postgres (Railway CLI, deploy, etc.).
 */
function resolveDatabaseUrl() {
  const u = process.env.DATABASE_URL;
  if (u && !/railway\.internal/.test(u)) return u;
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.RAILWAY_TCP_PROXY_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const pass = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB || 'railway';
  if (host && pass) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
  return u || null;
}

/** pg Client `ssl` option for hosted DBs that require TLS */
function pgSslOption(url) {
  if (!url) return undefined;
  return url.includes('amazonaws.com') || /sslmode=require/i.test(url)
    ? { rejectUnauthorized: false }
    : undefined;
}

module.exports = { resolveDatabaseUrl, pgSslOption };
