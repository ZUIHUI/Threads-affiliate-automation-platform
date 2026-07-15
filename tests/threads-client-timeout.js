const assert = require("node:assert/strict");

const { createTextContainer } = require("../src/threadsClient");

async function run() {
  const originalFetch = global.fetch;
  global.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });

  try {
    await assert.rejects(
      createTextContainer({
        threadsGraphBase: "https://graph.threads.test/v1.0",
        threadsUserId: "user-1",
        threadsAccessToken: "token",
        threadsApiTimeoutMs: 5
      }, { text: "Test post" }),
      (error) => error.code === "THREADS_API_TIMEOUT" && error.statusCode === 504
    );
  } finally {
    global.fetch = originalFetch;
  }

  console.log("Threads API timeout guard passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
