const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { runStartupMigration, syncPostgresState } = require("../src/postgresStore");
const { defaultState } = require("../src/store");

function createRecordingClient() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    }
  };
}

function findInsert(client, tableName) {
  return client.queries.find((query) => query.sql.includes(`insert into ${tableName}`));
}

async function run() {
  const tables = new Set(["threads_accounts", "posts"]);
  const configuredClient = createRecordingClient();
  await syncPostgresState(configuredClient, tables, defaultState(), {
    threadsUserId: "threads-user-1"
  });

  const configuredAccountInsert = findInsert(configuredClient, "threads_accounts");
  const configuredPostInsert = findInsert(configuredClient, "posts");
  assert.ok(configuredAccountInsert, "Threads account must be inserted before posts are synchronized.");
  assert.ok(configuredPostInsert, "Seed posts must still be synchronized.");
  assert.equal(configuredAccountInsert.params[2], "threads-user-1");
  assert.equal(configuredPostInsert.params[1], configuredAccountInsert.params[0]);
  assert.ok(
    configuredClient.queries.indexOf(configuredAccountInsert) < configuredClient.queries.indexOf(configuredPostInsert),
    "The referenced Threads account must be inserted before its posts."
  );

  const unconfiguredClient = createRecordingClient();
  await syncPostgresState(unconfiguredClient, tables, defaultState());
  const unconfiguredAccountInsert = findInsert(unconfiguredClient, "threads_accounts");
  const unconfiguredPostInsert = findInsert(unconfiguredClient, "posts");
  assert.ok(unconfiguredAccountInsert, "An unconfigured local account must still satisfy the posts foreign key.");
  assert.equal(unconfiguredAccountInsert.params[2], null);
  assert.equal(unconfiguredPostInsert.params[1], unconfiguredAccountInsert.params[0]);

  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  assert.match(schema, /alter column threads_user_id drop not null/i);

  let migrationAttempts = 0;
  let migrationRetries = 0;
  let releases = 0;
  const migrationPool = {
    async connect() {
      migrationAttempts += 1;
      return {
        async query(sql) {
          if (sql === "test schema" && migrationAttempts === 1) {
            const error = new Error("deadlock detected");
            error.code = "40P01";
            throw error;
          }
          return { rows: [] };
        },
        release() { releases += 1; }
      };
    }
  };
  await runStartupMigration(migrationPool, "test schema", {
    attempts: 3,
    sleep: async () => { migrationRetries += 1; }
  });
  assert.equal(migrationAttempts, 2);
  assert.equal(migrationRetries, 1);
  assert.equal(releases, 2);

  let permanentAttempts = 0;
  await assert.rejects(
    runStartupMigration({
      async connect() {
        permanentAttempts += 1;
        return {
          async query(sql) {
            if (sql === "bad schema") {
              const error = new Error("syntax error");
              error.code = "42601";
              throw error;
            }
            return { rows: [] };
          },
          release() {}
        };
      }
    }, "bad schema", { attempts: 3, sleep: async () => {} }),
    /syntax error/
  );
  assert.equal(permanentAttempts, 1);

  console.log("Postgres account foreign-key regression passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
