const fs = require("node:fs");

const { clone, defaultState } = require("./store");

const STATE_KEY = "json_store_state";

function loadPg() {
  try {
    return require("pg");
  } catch (error) {
    error.message = `PostgreSQL storage requires the "pg" package. ${error.message}`;
    throw error;
  }
}

function sslOptions(connectionString, explicitSsl) {
  if (explicitSsl) return { rejectUnauthorized: false };
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode");
    return sslMode && sslMode !== "disable" ? { rejectUnauthorized: false } : undefined;
  } catch {
    return undefined;
  }
}

function createPostgresStore(options) {
  const { Pool } = loadPg();
  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: sslOptions(options.connectionString, options.ssl)
  });
  let readyPromise = null;

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        if (options.autoMigrate && options.schemaPath) {
          const schema = fs.readFileSync(options.schemaPath, "utf8");
          await pool.query(schema);
        } else {
          await pool.query(`
            create table if not exists app_settings (
              key text primary key,
              value jsonb not null,
              updated_at timestamptz not null default now()
            )
          `);
        }
        await pool.query(
          `
            insert into app_settings (key, value, updated_at)
            values ($1, $2::jsonb, now())
            on conflict (key) do nothing
          `,
          [STATE_KEY, JSON.stringify(defaultState())]
        );
      })();
    }
    return readyPromise;
  }

  async function read() {
    await ensureReady();
    const result = await pool.query("select value from app_settings where key = $1", [STATE_KEY]);
    return clone(result.rows[0]?.value || defaultState());
  }

  async function write(state) {
    await ensureReady();
    await pool.query(
      `
        insert into app_settings (key, value, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `,
      [STATE_KEY, JSON.stringify(state)]
    );
  }

  async function update(mutator) {
    await ensureReady();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        "select value from app_settings where key = $1 for update",
        [STATE_KEY]
      );
      const state = clone(result.rows[0]?.value || defaultState());
      const mutationResult = mutator(state) || {};
      await client.query(
        `
          insert into app_settings (key, value, updated_at)
          values ($1, $2::jsonb, now())
          on conflict (key) do update set value = excluded.value, updated_at = now()
        `,
        [STATE_KEY, JSON.stringify(state)]
      );
      await client.query("commit");
      return mutationResult;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    type: "postgres",
    ready: ensureReady,
    read,
    write,
    update,
    close: () => pool.end()
  };
}

module.exports = { createPostgresStore, STATE_KEY };
