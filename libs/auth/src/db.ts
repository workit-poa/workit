import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DbInstance = PostgresJsDatabase<typeof schema>;
type SqlClient = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __workit_sql_client__: SqlClient | undefined;
  // eslint-disable-next-line no-var
  var __workit_drizzle_db__: DbInstance | undefined;
}

let dbInstance: DbInstance | undefined;

export function getDb(): DbInstance {
  if (dbInstance) return dbInstance;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const sqlClient = globalThis.__workit_sql_client__ ?? postgres(databaseUrl, { prepare: false });
  const db = globalThis.__workit_drizzle_db__ ?? drizzle(sqlClient, { schema });

  if (process.env.NODE_ENV !== "production") {
    globalThis.__workit_sql_client__ = sqlClient;
    globalThis.__workit_drizzle_db__ = db;
  }

  dbInstance = db;
  return db;
}

