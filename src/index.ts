#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_BASE_URL = process.env.PYROSCOPE_BASE_URL ?? "http://localhost:4040";
const DEFAULT_TENANT_ID = process.env.PYROSCOPE_TENANT_ID;
const AUTH_TOKEN = process.env.PYROSCOPE_AUTH_TOKEN;
const ALLOW_TENANT_OVERRIDE = process.env.PYROSCOPE_ALLOW_TENANT_OVERRIDE === "true";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 2048;
const DEFAULT_RANGE_MS = 60 * 60 * 1000;

function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(
      `pyroscope-mcp: invalid PYROSCOPE_TIMEOUT_MS, using ${DEFAULT_TIMEOUT_MS}`
    );
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

const TIMEOUT_MS = parseTimeoutMs(process.env.PYROSCOPE_TIMEOUT_MS);

function isPlaintextRemote(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  return !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
}

// Only exposed to the model when the operator opts in; see PYROSCOPE_ALLOW_TENANT_OVERRIDE.
const tenantShape = (
  ALLOW_TENANT_OVERRIDE
    ? { tenantId: z.string().optional().describe("Optional per-request tenant override.") }
    : {}
) as { tenantId: z.ZodOptional<z.ZodString> };

function timeRange(start?: number, end?: number): { start: number; end: number } {
  const now = Date.now();
  return { start: start ?? (end ?? now) - DEFAULT_RANGE_MS, end: end ?? now };
}

const server = new McpServer({
  name: "pyroscope-mcp",
  version: "0.1.0",
});

type RequestOptions = {
  method?: "GET" | "POST";
  endpoint: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  tenantId?: string;
};

function formatResponsePreview(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.length > 12000 ? `${payload.slice(0, 12000)}\n...truncated...` : payload;
  }

  const pretty = JSON.stringify(payload, null, 2);
  return pretty.length > 12000 ? `${pretty.slice(0, 12000)}\n...truncated...` : pretty;
}

async function readBodyCapped(response: Response): Promise<string> {
  const tooLarge = () =>
    new Error(`Pyroscope response exceeds the ${MAX_RESPONSE_BYTES} byte limit; narrow the query.`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function pyroscopeRequest(options: RequestOptions): Promise<unknown> {
  const method = options.method ?? "POST";
  const queryString = options.query
    ? new URLSearchParams(
        Object.entries(options.query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)])
      ).toString()
    : "";

  const baseUrl = DEFAULT_BASE_URL.replace(/\/$/, "");
  const url = `${baseUrl}${options.endpoint}${queryString ? `?${queryString}` : ""}`;

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const tenantId = (ALLOW_TENANT_OVERRIDE ? options.tenantId : undefined) ?? DEFAULT_TENANT_ID;
  if (tenantId) {
    headers["X-Scope-OrgID"] = tenantId;
  }

  if (AUTH_TOKEN) {
    if (isPlaintextRemote(baseUrl)) {
      throw new Error(
        "Refusing to send PYROSCOPE_AUTH_TOKEN over plaintext http to a non-loopback host. Use https."
      );
    }
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await readBodyCapped(response);

    if (!response.ok) {
      const shown =
        raw.length > MAX_ERROR_BODY_CHARS ? `${raw.slice(0, MAX_ERROR_BODY_CHARS)}...truncated...` : raw;
      throw new Error(`Pyroscope request failed (${response.status} ${response.statusText}): ${shown}`);
    }

    if (contentType.includes("application/json")) {
      return raw ? JSON.parse(raw) : {};
    }

    return raw;
  } finally {
    clearTimeout(timeout);
  }
}

server.tool(
  "pyroscope_render_profile",
  "Query the legacy /pyroscope/render endpoint for flamegraph and timeline data.",
  {
    query: z.string().describe("Pyroscope query, e.g. process_cpu:cpu:nanoseconds:cpu:nanoseconds{service_name=\"api\"}"),
    from: z.string().optional().describe("Start time (e.g. now-1h or unix ms). Defaults to now-1h."),
    until: z.string().optional().describe("End time (e.g. now). Defaults to now."),
    format: z.enum(["json", "dot"]).optional().describe("Response format."),
    maxNodes: z.number().int().positive().optional().describe("Maximum nodes in returned flamegraph."),
    groupBy: z.string().optional().describe("Single label to group timeline by."),
    ...tenantShape,
  },
  async ({ query, from, until, format, maxNodes, groupBy, tenantId }) => {
    const payload = await pyroscopeRequest({
      method: "GET",
      endpoint: "/pyroscope/render",
      query: {
        query,
        from: from ?? "now-1h",
        until: until ?? "now",
        format,
        maxNodes,
        groupBy,
      },
      tenantId,
    });

    return {
      content: [{ type: "text", text: formatResponsePreview(payload) }],
    };
  }
);

server.tool(
  "pyroscope_label_names",
  "List available label names via Connect API.",
  {
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch. Defaults to 1 hour before end."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch. Defaults to now."),
    matchers: z.array(z.string()).optional().describe("Optional label selectors."),
    ...tenantShape,
  },
  async ({ start, end, matchers, tenantId }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/LabelNames",
      body: { ...timeRange(start, end), matchers },
      tenantId,
    });

    return {
      content: [{ type: "text", text: formatResponsePreview(payload) }],
    };
  }
);

server.tool(
  "pyroscope_label_values",
  "List label values for a given label name via Connect API.",
  {
    name: z.string().describe("Label name, e.g. service_name"),
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch. Defaults to 1 hour before end."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch. Defaults to now."),
    matchers: z.array(z.string()).optional().describe("Optional label selectors."),
    ...tenantShape,
  },
  async ({ name, start, end, matchers, tenantId }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/LabelValues",
      body: { name, ...timeRange(start, end), matchers },
      tenantId,
    });

    return {
      content: [{ type: "text", text: formatResponsePreview(payload) }],
    };
  }
);

server.tool(
  "pyroscope_profile_types",
  "List available profile types via Connect API.",
  {
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch. Defaults to 1 hour before end."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch. Defaults to now."),
    ...tenantShape,
  },
  async ({ start, end, tenantId }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/ProfileTypes",
      body: { ...timeRange(start, end) },
      tenantId,
    });

    return {
      content: [{ type: "text", text: formatResponsePreview(payload) }],
    };
  }
);

server.tool(
  "pyroscope_series",
  "Return profile series for given matchers via Connect API.",
  {
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch. Defaults to 1 hour before end."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch. Defaults to now."),
    matchers: z.array(z.string()).optional().describe("Matchers like {service_name=\"checkout\"}."),
    labelNames: z.array(z.string()).optional().describe("Optional label names to return."),
    ...tenantShape,
  },
  async ({ start, end, matchers, labelNames, tenantId }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/Series",
      body: { ...timeRange(start, end), matchers, labelNames },
      tenantId,
    });

    return {
      content: [{ type: "text", text: formatResponsePreview(payload) }],
    };
  }
);

server.tool(
  "pyroscope_connect_query",
  "Execute any Pyroscope Connect query endpoint with a raw JSON request body.",
  {
    endpoint: z
      .string()
      .regex(/^\/querier\.v1\.QuerierService\/[A-Za-z0-9]+$/)
      .describe("Connect query endpoint path, e.g. /querier.v1.QuerierService/SelectMergeStacktraces"),
    body: z.record(z.string(), z.unknown()).describe("Raw JSON body for the selected endpoint."),
    ...tenantShape,
  },
  async ({ endpoint, body, tenantId }) => {
    const payload = await pyroscopeRequest({
      endpoint,
      body,
      tenantId,
    });

    return {
      content: [{ type: "text", text: formatResponsePreview(payload) }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start pyroscope-mcp server:", error);
  process.exit(1);
});
