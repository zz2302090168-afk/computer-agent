import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';

type Executor = Pool | PoolConnection;
type SqlParameter =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | Buffer
  | Uint8Array;

export class PreparedQuery {
  private readonly executor: Executor;
  readonly sql: string;
  readonly params: SqlParameter[];

  constructor(executor: Executor, sql: string, params: SqlParameter[] = []) {
    this.executor = executor;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: SqlParameter[]) {
    return new PreparedQuery(this.executor, this.sql, params);
  }

  async first<T>() {
    const [rows] = await this.executor.execute<RowDataPacket[]>(
      this.sql,
      this.params,
    );
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T>() {
    const [rows] = await this.executor.execute<RowDataPacket[]>(
      this.sql,
      this.params,
    );
    return { results: rows as T[] };
  }

  async run() {
    const [result] = await this.executor.execute<ResultSetHeader>(
      this.sql,
      this.params,
    );
    return { meta: { changes: result.affectedRows } };
  }
}

export class MySqlDatabase {
  private readonly executor: Executor;

  constructor(executor: Executor) {
    this.executor = executor;
  }

  prepare(sql: string) {
    return new PreparedQuery(this.executor, sql);
  }

  async batch(queries: PreparedQuery[]) {
    if (!('getConnection' in this.executor))
      return Promise.all(queries.map((query) => query.run()));
    const connection = await this.executor.getConnection();
    try {
      await connection.beginTransaction();
      const results = [];
      for (const query of queries)
        results.push(
          await new PreparedQuery(connection, query.sql, query.params).run(),
        );
      await connection.commit();
      return results;
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }

  async transaction<T>(work: (db: MySqlDatabase) => Promise<T>) {
    if (!('getConnection' in this.executor)) return work(this);
    const connection = await this.executor.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(new MySqlDatabase(connection));
      await connection.commit();
      return result;
    } catch (cause) {
      await connection.rollback();
      throw cause;
    } finally {
      connection.release();
    }
  }
}

const globalForMysql = globalThis as typeof globalThis & { mysqlPool?: Pool };

function connectionUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw Error('MySQL 未配置，请在 .env.local 设置 DATABASE_URL');
  if (!/^mysql:\/\//i.test(url))
    throw Error('DATABASE_URL 必须是 mysql:// 地址');
  return url;
}

export function database() {
  const pool =
    globalForMysql.mysqlPool ??
    mysql.createPool({
      uri: connectionUrl(),
      connectionLimit: 10,
      charset: 'utf8mb4',
      enableKeepAlive: true,
    });
  globalForMysql.mysqlPool = pool;
  return new MySqlDatabase(pool);
}

export const getDb = database;
