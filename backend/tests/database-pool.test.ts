import test from 'node:test';
import assert from 'node:assert/strict';
import mysql, { type Pool } from 'mysql2/promise';
import { database } from '../../db';

void test('生产进程内多次访问数据库复用一个连接池', async (t) => {
  const previousEnv = process.env;
  const previousPool = Object.getOwnPropertyDescriptor(globalThis, 'mysqlPool');
  const pools: Pool[] = [];
  process.env = {
    ...previousEnv,
    NODE_ENV: 'production',
    DATABASE_URL: 'mysql://test:test@127.0.0.1:3306/test',
  };
  Reflect.deleteProperty(globalThis, 'mysqlPool');
  t.after(async () => {
    process.env = previousEnv;
    if (previousPool)
      Object.defineProperty(globalThis, 'mysqlPool', previousPool);
    else Reflect.deleteProperty(globalThis, 'mysqlPool');
    await Promise.all(pools.map((pool) => pool.end()));
  });
  const originalCreatePool = mysql.createPool;
  t.mock.method(
    mysql,
    'createPool',
    (options: Parameters<typeof mysql.createPool>[0]) => {
      const pool = originalCreatePool(options);
      pools.push(pool);
      return pool;
    },
  );
  database().prepare('SELECT 1');
  database().prepare('SELECT 2');
  assert.equal(pools.length, 1);
});
