import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUPABASE_DIR = path.join(ROOT, 'supabase');

// Imita o que o Supabase já traz pronto: papéis, schema auth, auth.uid() e os
// grants padrão do schema public (por isso os revokes das migrations importam).
const SUPABASE_SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export const MIGRATIONS_DIR = path.join(SUPABASE_DIR, 'migrations');
export const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
export const migrationSql = (f: string) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');

/** Banco novo em memória só com o shim do Supabase (sem migrations). */
export async function shimDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  return db;
}

/** Banco novo em memória com shim + migrations + seed. */
export async function freshDb(): Promise<PGlite> {
  const db = await shimDb();
  for (const f of migrationFiles()) await db.exec(migrationSql(f));
  await db.exec(fs.readFileSync(path.join(SUPABASE_DIR, 'seed.sql'), 'utf8'));
  return db;
}

/** Executa como um papel do Supabase (anon | authenticated | service_role). */
export async function asRole<T>(db: PGlite, role: string, fn: () => Promise<T>, sub?: string): Promise<T> {
  await db.exec(`set role ${role}`);
  if (sub) await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub]);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`);
  }
}

export const FIXTURE = path.join(ROOT, 'test/fixtures/trips-salvador-ba_catu-ba_2026-10-04.json');
