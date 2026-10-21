// Executed only by the reviewed hosted runner. No product module imports.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
const mode = process.argv[2];
if (mode === 'versions') {
  const vitest = JSON.parse(await readFile(resolve('node_modules/vitest/package.json'), 'utf8'));
  console.log(JSON.stringify({ node: process.versions.node, vitest: vitest.version }));
} else {
  const pg = createRequire(resolve('package.json'))('pg');
  const admin = process.env.FJVE_ADMIN_URL;
  const fixture = process.env.FJVE_FIXTURE_URL;
  const connect = async url => {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try { await client.connect(); return client; }
    catch (error) { await client.end().catch(() => {}); throw error; }
  };
  const identity = async (client, database) => {
    const row = (await client.query(`SELECT current_database() AS database,
      current_setting('server_version_num')::int AS version, current_user AS role`)).rows[0];
    if (row.database !== database || row.version !== 160015) throw Error('database/version mismatch');
    return row;
  };
  if (mode === 'bootstrap') {
    let db;
    const end = Date.now() + 75000;
    // TCP from the host to the published endpoint cannot see initdb's temporary Unix-only server.
    while (!db) {
      try { db = await connect(admin); await identity(db, 'postgres'); }
      catch { await db?.end().catch(() => {}); db = null; if (Date.now() >= end) throw Error('final TCP readiness deadline'); await sleep(250); }
    }
    try {
      const ddl = (await db.query(`SELECT format('CREATE ROLE mailflow_fixture LOGIN NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 2 PASSWORD %L', $1) AS ddl`,
      [process.env.FJVE_FIXTURE_PASSWORD])).rows[0].ddl;
      await db.query(ddl);
      for (const name of ['mailflow_svtw', 'mailflow_pyws_backup']) {
        await db.query('CREATE DATABASE ' + name + ' OWNER mailflow_fixture');
      }
      const limits = (await db.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolconnlimit
        FROM pg_roles WHERE rolname='mailflow_fixture'`)).rows[0];
      if (limits.rolsuper || limits.rolcreatedb || limits.rolcreaterole || limits.rolconnlimit !== 2) throw Error('role limits mismatch');
      const verified = [];
      for (const name of ['mailflow_svtw', 'mailflow_pyws_backup']) {
        const url = new URL(fixture); url.pathname = '/' + name;
        const peer = await connect(url.toString());
        try { verified.push(await identity(peer, name)); } finally { await peer.end(); }
      }
      console.log(JSON.stringify({ finalTcpReady: true, databases: verified, fixtureConnectionLimit: 2 }));
    } finally { await db.end(); }
  } else if (mode === 'audit') {
    const expected = process.env.FJVE_EXPECTED_DATABASE;
    if (!['mailflow_svtw', 'mailflow_pyws_backup'].includes(expected)) throw Error('unexpected audit database');
    const db = await connect(admin);
    try {
      const who = await identity(db, expected);
      let active = 1;
      const end = Date.now() + 6000;
      while (active && Date.now() < end) {
        active = Number((await db.query(`SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows[0].n);
        if (active) await sleep(100);
      }
      const schemas = (await db.query(`SELECT nspname FROM pg_namespace WHERE
        nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_' ORDER BY nspname`)).rows.map(r => r.nspname);
      const relations = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname`)).rows.map(r => r.relname);
      const clean = active === 0 && schemas.length === 0 && relations.length === 0;
      console.log(JSON.stringify({ ...who, otherBackends: active, leftoverSchemas: schemas, publicRelations: relations, clean }));
      if (!clean) process.exitCode = 1;
    } finally { await db.end(); }
  } else { throw Error('unknown helper mode'); }
}
