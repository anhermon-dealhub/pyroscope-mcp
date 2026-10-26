import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function listen(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

const okJson = (_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end("{}");
};

async function withClient(env, fn) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, PYROSCOPE_TENANT_ID: "", PYROSCOPE_AUTH_TOKEN: "", ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await fn(client, stderr);
  } finally {
    await client.close();
  }
}

test("Connect tools default start/end to the last hour when omitted", async () => {
  const stub = await listen(okJson);
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url }, async (client) => {
      const before = Date.now();
      for (const name of ["pyroscope_label_names", "pyroscope_label_values", "pyroscope_profile_types", "pyroscope_series"]) {
        await client.callTool({ name, arguments: name === "pyroscope_label_values" ? { name: "service_name" } : {} });
      }
      const after = Date.now();
      assert.equal(stub.requests.length, 4);
      for (const r of stub.requests) {
        const body = JSON.parse(r.body);
        assert.ok(body.end >= before && body.end <= after, `end defaulted to now for ${r.url}`);
        assert.equal(body.end - body.start, 3600000);
      }
    });
  } finally {
    stub.server.close();
  }
});

test("explicit start/end are passed through untouched", async () => {
  const stub = await listen(okJson);
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url }, async (client) => {
      await client.callTool({ name: "pyroscope_label_names", arguments: { start: 1000, end: 2000 } });
      const body = JSON.parse(stub.requests[0].body);
      assert.equal(body.start, 1000);
      assert.equal(body.end, 2000);
    });
  } finally {
    stub.server.close();
  }
});

test("oversized responses are rejected with a clear error", async () => {
  const stub = await listen((_req, res) => {
    res.setHeader("content-type", "text/plain");
    // chunked, no content-length, so the streaming cap is exercised
    const chunk = "a".repeat(1024 * 1024);
    for (let i = 0; i < 12; i++) res.write(chunk);
    res.end();
  });
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url }, async (client) => {
      const result = await client.callTool({ name: "pyroscope_label_names", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /exceeds the \d+ byte limit/);
    });
  } finally {
    stub.server.close();
  }
});

test("error bodies are truncated to about 2 KB", async () => {
  const stub = await listen((_req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end("x".repeat(50000));
  });
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url }, async (client) => {
      const result = await client.callTool({ name: "pyroscope_label_names", arguments: {} });
      assert.equal(result.isError, true);
      const text = result.content[0].text;
      assert.match(text, /500/);
      assert.ok(text.length < 2500, `message length ${text.length}`);
      assert.match(text, /truncated/);
    });
  } finally {
    stub.server.close();
  }
});

test("invalid PYROSCOPE_TIMEOUT_MS falls back to 30000 and logs to stderr", async () => {
  const stub = await listen(okJson);
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url, PYROSCOPE_TIMEOUT_MS: "abc" }, async (client, stderr) => {
      const result = await client.callTool({ name: "pyroscope_label_names", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(stub.requests.length, 1);
      assert.match(stderr.join(""), /invalid PYROSCOPE_TIMEOUT_MS, using 30000/);
    });
  } finally {
    stub.server.close();
  }
});

for (const bad of ["0", "-5", "1.5", "Infinity"]) {
  test(`PYROSCOPE_TIMEOUT_MS=${bad} is rejected`, async () => {
    const stub = await listen(okJson);
    try {
      await withClient({ PYROSCOPE_BASE_URL: stub.url, PYROSCOPE_TIMEOUT_MS: bad }, async (client, stderr) => {
        await client.callTool({ name: "pyroscope_label_names", arguments: {} });
        assert.match(stderr.join(""), /using 30000/);
      });
    } finally {
      stub.server.close();
    }
  });
}

test("tenantId is hidden and ignored unless PYROSCOPE_ALLOW_TENANT_OVERRIDE=true", async () => {
  const stub = await listen(okJson);
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url, PYROSCOPE_TENANT_ID: "own-tenant" }, async (client) => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        assert.equal("tenantId" in (tool.inputSchema.properties ?? {}), false, `${tool.name} exposes tenantId`);
      }
      await client.callTool({ name: "pyroscope_label_names", arguments: { tenantId: "victim" } });
      assert.equal(stub.requests[0].headers["x-scope-orgid"], "own-tenant");
    });
  } finally {
    stub.server.close();
  }
});

test("tenantId override works when PYROSCOPE_ALLOW_TENANT_OVERRIDE=true", async () => {
  const stub = await listen(okJson);
  try {
    await withClient(
      { PYROSCOPE_BASE_URL: stub.url, PYROSCOPE_TENANT_ID: "own-tenant", PYROSCOPE_ALLOW_TENANT_OVERRIDE: "true" },
      async (client) => {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          assert.equal("tenantId" in (tool.inputSchema.properties ?? {}), true, `${tool.name} lacks tenantId`);
        }
        await client.callTool({ name: "pyroscope_label_names", arguments: { tenantId: "other" } });
        assert.equal(stub.requests[0].headers["x-scope-orgid"], "other");
      }
    );
  } finally {
    stub.server.close();
  }
});

test("bearer token is refused over http to a non-loopback host", async () => {
  const stub = await listen(okJson);
  try {
    await withClient({ PYROSCOPE_BASE_URL: "http://pyroscope.example.com:4040", PYROSCOPE_AUTH_TOKEN: "secret-token" }, async (client) => {
      const result = await client.callTool({ name: "pyroscope_label_names", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Refusing to send PYROSCOPE_AUTH_TOKEN/);
      assert.doesNotMatch(result.content[0].text, /secret-token/);
    });
    assert.equal(stub.requests.length, 0);
  } finally {
    stub.server.close();
  }
});

test("bearer token is still sent over http to loopback", async () => {
  const stub = await listen(okJson);
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url, PYROSCOPE_AUTH_TOKEN: "secret-token" }, async (client) => {
      const result = await client.callTool({ name: "pyroscope_label_names", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(stub.requests[0].headers.authorization, "Bearer secret-token");
    });
  } finally {
    stub.server.close();
  }
});

test("pyroscope_connect_query accepts a raw body under zod 4", async () => {
  const stub = await listen(okJson);
  try {
    await withClient({ PYROSCOPE_BASE_URL: stub.url }, async (client) => {
      const result = await client.callTool({
        name: "pyroscope_connect_query",
        arguments: { endpoint: "/querier.v1.QuerierService/Diff", body: { a: 1, nested: { b: [2] } } },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(JSON.parse(stub.requests[0].body), { a: 1, nested: { b: [2] } });
    });
  } finally {
    stub.server.close();
  }
});
