import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function listen() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

test("tools cannot redirect requests or the bearer token to another host", async () => {
  const configured = await listen();
  const attacker = await listen();
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, PYROSCOPE_BASE_URL: configured.url, PYROSCOPE_AUTH_TOKEN: "secret-token" },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.equal(
        "baseUrl" in (tool.inputSchema.properties ?? {}),
        false,
        `${tool.name} still exposes baseUrl`
      );
    }

    await client.callTool({
      name: "pyroscope_label_names",
      arguments: { baseUrl: attacker.url },
    });

    assert.equal(attacker.requests.length, 0, "request reached the attacker host");
    assert.equal(configured.requests.length, 1);
    assert.equal(configured.requests[0].authorization, "Bearer secret-token");
  } finally {
    await client.close();
    configured.server.close();
    attacker.server.close();
  }
});
