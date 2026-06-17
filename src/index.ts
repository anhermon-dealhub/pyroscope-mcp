import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_BASE_URL = process.env.PYROSCOPE_BASE_URL ?? "http://localhost:4040";
const DEFAULT_TENANT_ID = process.env.PYROSCOPE_TENANT_ID;
const AUTH_TOKEN = process.env.PYROSCOPE_AUTH_TOKEN;
const TIMEOUT_MS = Number(process.env.PYROSCOPE_TIMEOUT_MS ?? 30000);

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
  baseUrl?: string;
};

function formatResponsePreview(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.length > 12000 ? `${payload.slice(0, 12000)}\n...truncated...` : payload;
  }

  const pretty = JSON.stringify(payload, null, 2);
  return pretty.length > 12000 ? `${pretty.slice(0, 12000)}\n...truncated...` : pretty;
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

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = `${baseUrl}${options.endpoint}${queryString ? `?${queryString}` : ""}`;

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  if (tenantId) {
    headers["X-Scope-OrgID"] = tenantId;
  }

  if (AUTH_TOKEN) {
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
    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`Pyroscope request failed (${response.status} ${response.statusText}): ${raw}`);
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
    tenantId: z.string().optional().describe("Optional per-request tenant override."),
    baseUrl: z.string().url().optional().describe("Optional per-request Pyroscope base URL override."),
  },
  async ({ query, from, until, format, maxNodes, groupBy, tenantId, baseUrl }) => {
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
      baseUrl,
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
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch."),
    matchers: z.array(z.string()).optional().describe("Optional label selectors."),
    tenantId: z.string().optional(),
    baseUrl: z.string().url().optional(),
  },
  async ({ start, end, matchers, tenantId, baseUrl }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/LabelNames",
      body: { start, end, matchers },
      tenantId,
      baseUrl,
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
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch."),
    matchers: z.array(z.string()).optional().describe("Optional label selectors."),
    tenantId: z.string().optional(),
    baseUrl: z.string().url().optional(),
  },
  async ({ name, start, end, matchers, tenantId, baseUrl }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/LabelValues",
      body: { name, start, end, matchers },
      tenantId,
      baseUrl,
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
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch."),
    tenantId: z.string().optional(),
    baseUrl: z.string().url().optional(),
  },
  async ({ start, end, tenantId, baseUrl }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/ProfileTypes",
      body: { start, end },
      tenantId,
      baseUrl,
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
    start: z.number().int().optional().describe("Start timestamp in milliseconds since epoch."),
    end: z.number().int().optional().describe("End timestamp in milliseconds since epoch."),
    matchers: z.array(z.string()).optional().describe("Matchers like {service_name=\"checkout\"}."),
    labelNames: z.array(z.string()).optional().describe("Optional label names to return."),
    tenantId: z.string().optional(),
    baseUrl: z.string().url().optional(),
  },
  async ({ start, end, matchers, labelNames, tenantId, baseUrl }) => {
    const payload = await pyroscopeRequest({
      endpoint: "/querier.v1.QuerierService/Series",
      body: { start, end, matchers, labelNames },
      tenantId,
      baseUrl,
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
    body: z.record(z.unknown()).describe("Raw JSON body for the selected endpoint."),
    tenantId: z.string().optional(),
    baseUrl: z.string().url().optional(),
  },
  async ({ endpoint, body, tenantId, baseUrl }) => {
    const payload = await pyroscopeRequest({
      endpoint,
      body,
      tenantId,
      baseUrl,
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
