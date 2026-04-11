import GodotSQLiteKyselyDialect from 'godot-sqlite-kysely';
import { Kysely, sql } from 'kysely';
import type { SqliteCookie, SqliteCookieStore } from './store';

const DefaultCookieStorePath = 'user://godot-fetch-cookies';
const DefaultCookieTableName = 'http_cookies';
const DefaultCookieStoreWorkerModule = '@godot-fetch/cookies-sqlite/sqlite-cookie-store.worker';

export interface SqliteCookieStoreOptions {
  defaultExtension?: string;
  path?: string;
  tableName?: string;
  workerModule?: string;
}

type SqliteCookieRow = {
  domain: string;
  expiry: null | number | string;
  http_only: null | number | string;
  name: string;
  path: string;
  secure: null | number | string;
  value: string;
};

type CookieDatabase = {
  [DefaultCookieTableName]: {
    domain: string;
    expiry: number;
    http_only: number;
    name: string;
    path: string;
    secure: number;
    value: string;
  };
};

function sanitizeTableName(input: unknown): string {
  const tableName = typeof input === 'string' && input.length > 0
    ? input
    : DefaultCookieTableName;

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid SQLite cookie table name: ${tableName}`);
  }

  return tableName;
}

function toNumber(value: null | number | string | undefined, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function toCookieMap(rows: readonly SqliteCookieRow[]): Readonly<Record<string, Readonly<Record<string, SqliteCookie>>>> {
  const result: Record<string, Record<string, SqliteCookie>> = Object.create(null);

  for (const row of rows) {
    const domain = String(row.domain ?? '');
    const path = String(row.path ?? '/');
    const name = String(row.name ?? '');

    if (domain.length === 0 || name.length === 0) {
      continue;
    }

    const pathMap = result[path] ?? (result[path] = Object.create(null));

    pathMap[name] = {
      domain,
      expiry: toNumber(row.expiry, Number.POSITIVE_INFINITY),
      httpOnly: toNumber(row.http_only, 0) === 1,
      name,
      path,
      secure: toNumber(row.secure, 0) === 1,
      value: String(row.value ?? ''),
    };
  }

  return result;
}

function resolveWorkerModule(input: unknown): string {
  if (typeof input === 'string' && input.trim().length > 0) {
    return input;
  }

  return DefaultCookieStoreWorkerModule;
}

async function initializeSchema(db: Kysely<CookieDatabase>, tableName: string): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.raw(tableName)} (
      domain TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      expiry INTEGER NOT NULL,
      secure INTEGER NOT NULL,
      http_only INTEGER NOT NULL,
      PRIMARY KEY (domain, path, name)
    )
  `.execute(db);
}

export function createSqliteCookieStore(options?: SqliteCookieStoreOptions): SqliteCookieStore {
  const config = options ?? {};
  const path = typeof config.path === 'string' && config.path.length > 0
    ? config.path
    : DefaultCookieStorePath;
  const tableName = sanitizeTableName(config.tableName);

  const db = new Kysely<CookieDatabase>({
    dialect: new GodotSQLiteKyselyDialect({
      path,
      ...(typeof config.defaultExtension === 'string' ? { defaultExtension: config.defaultExtension } : undefined),
      workerModule: resolveWorkerModule(config.workerModule),
    }),
  });

  const schemaReady = initializeSchema(db, tableName);

  const withSchema = async <T>(run: () => Promise<T>): Promise<T> => {
    await schemaReady;
    return await run();
  };

  return {
    async deleteCookie(domain, path, name) {
      await withSchema(async () => {
        await sql`
          DELETE FROM ${sql.raw(tableName)}
          WHERE domain = ${domain}
            AND path = ${path}
            AND name = ${name}
        `.execute(db);
      });
    },

    async getCookies(domain) {
      return await withSchema(async () => {
        const result = await sql<SqliteCookieRow>`
          SELECT domain, path, name, value, expiry, secure, http_only
          FROM ${sql.raw(tableName)}
          WHERE domain = ${domain}
        `.execute(db);

        const map = toCookieMap(result.rows);
        return Object.keys(map).length > 0 ? map : null;
      });
    },

    async setCookies(cookies) {
      await withSchema(async () => {
        const now = Date.now();

        await db.transaction().execute(async trx => {
          for (const cookie of cookies) {
            if (now >= cookie.expiry) {
              await sql`
                DELETE FROM ${sql.raw(tableName)}
                WHERE domain = ${cookie.domain}
                  AND path = ${cookie.path}
                  AND name = ${cookie.name}
              `.execute(trx);

              continue;
            }

            await sql`
              INSERT INTO ${sql.raw(tableName)} (
                domain,
                path,
                name,
                value,
                expiry,
                secure,
                http_only
              )
              VALUES (
                ${cookie.domain},
                ${cookie.path},
                ${cookie.name},
                ${cookie.value},
                ${Math.trunc(cookie.expiry)},
                ${cookie.secure ? 1 : 0},
                ${cookie.httpOnly ? 1 : 0}
              )
              ON CONFLICT(domain, path, name)
              DO UPDATE SET
                value = excluded.value,
                expiry = excluded.expiry,
                secure = excluded.secure,
                http_only = excluded.http_only
            `.execute(trx);
          }
        });
      });
    },
  };
}
