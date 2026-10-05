# pyroscope-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for [Grafana Pyroscope](https://grafana.com/oss/pyroscope/). Lets AI assistants query continuous profiling data — flamegraphs, hotspot functions, memory allocations, label discovery — directly from any MCP-compatible client.

> **Note:** This server is query-only. Profile ingestion is expected to be handled by your application profilers (Pyroscope SDKs, agents, or exporters).

## Tools

| Tool | Description |
|------|-------------|
| `pyroscope_render_profile` | Flamegraph + timeline data from `/pyroscope/render` |
| `pyroscope_label_names` | List all label names in a time range |
| `pyroscope_label_values` | List values for a given label (e.g. `service_name`) |
| `pyroscope_profile_types` | List available profile types (cpu, memory, goroutines…) |
| `pyroscope_series` | Fetch matching label sets for a selector |
| `pyroscope_connect_query` | Raw access to any `/querier.v1.QuerierService/*` endpoint |

## Prerequisites

- Node.js 20+
- A running Pyroscope instance (local, self-hosted, or Grafana Cloud)

## Setup

```bash
git clone https://github.com/your-org/pyroscope-mcp
cd pyroscope-mcp
npm ci
npm run build
```

## Configuration

All settings are provided via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PYROSCOPE_BASE_URL` | `http://localhost:4040` | Pyroscope server URL |
| `PYROSCOPE_AUTH_TOKEN` | — | Bearer token (Grafana Cloud or Azure AD) |
| `PYROSCOPE_TENANT_ID` | — | Multi-tenant org ID (`X-Scope-OrgID` header) |
| `PYROSCOPE_TIMEOUT_MS` | `30000` | Request timeout in milliseconds |

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

---

## Adding to MCP Clients

### VS Code (GitHub Copilot)

Create or edit `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "pyroscope": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"],
      "env": {
        "PYROSCOPE_BASE_URL": "http://localhost:4040"
      }
    }
  }
}
```

Then open the **MCP: List Servers** command in VS Code (`Cmd+Shift+P`) and start the server. Copilot Chat will automatically discover the tools.

For a global (user-level) config instead of per-workspace, add the same block to your VS Code `settings.json` under `"mcp"`:

```json
{
  "mcp": {
    "servers": {
      "pyroscope": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/pyroscope-mcp/dist/index.js"],
        "env": {
          "PYROSCOPE_BASE_URL": "http://localhost:4040"
        }
      }
    }
  }
}
```

---

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "pyroscope": {
      "command": "node",
      "args": ["/absolute/path/to/pyroscope-mcp/dist/index.js"],
      "env": {
        "PYROSCOPE_BASE_URL": "http://localhost:4040",
        "PYROSCOPE_AUTH_TOKEN": ""
      }
    }
  }
}
```

Restart Claude Desktop. A hammer icon will appear in the chat input when the server is active.

On **Windows**, wrap the command:

```json
{
  "mcpServers": {
    "pyroscope": {
      "command": "cmd",
      "args": ["/c", "node", "C:\\path\\to\\pyroscope-mcp\\dist\\index.js"],
      "env": {
        "PYROSCOPE_BASE_URL": "http://localhost:4040"
      }
    }
  }
}
```

---

### Cursor

Open **Cursor Settings → MCP** and add a new server entry, or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pyroscope": {
      "command": "node",
      "args": ["/absolute/path/to/pyroscope-mcp/dist/index.js"],
      "env": {
        "PYROSCOPE_BASE_URL": "http://localhost:4040"
      }
    }
  }
}
```

Reload Cursor. The tools appear automatically in the Composer agent context.

---

### Zed

Add to your Zed `settings.json` (open via **Zed → Settings**):

```json
{
  "context_servers": {
    "pyroscope": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/pyroscope-mcp/dist/index.js"],
        "env": {
          "PYROSCOPE_BASE_URL": "http://localhost:4040"
        }
      }
    }
  }
}
```

---

### Any MCP-compatible client (generic stdio config)

```json
{
  "mcpServers": {
    "pyroscope": {
      "command": "node",
      "args": ["/absolute/path/to/pyroscope-mcp/dist/index.js"],
      "env": {
        "PYROSCOPE_BASE_URL": "http://localhost:4040",
        "PYROSCOPE_AUTH_TOKEN": "your-bearer-token-if-needed",
        "PYROSCOPE_TENANT_ID": "your-org-id-if-needed"
      }
    }
  }
}
```

---

## Example prompts once connected

- *"List all services sending profiles in the last hour."*
- *"Show the hottest CPU functions for `media-agent` in the last 30 minutes."*
- *"What is the memory allocation hotspot in `api-gateway`?"*
- *"Compare CPU usage between `worker-service` and `data-pipeline`."*
- *"What profile types are available for `checkout-api`?"*

---

## Notes

- For multi-tenant Pyroscope, set `PYROSCOPE_TENANT_ID` or pass `tenantId` per tool call.
- The Pyroscope URL comes only from `PYROSCOPE_BASE_URL`. Tools cannot override it, so a prompt-injected tool call cannot send `PYROSCOPE_AUTH_TOKEN` to another host.
- `pyroscope_connect_query` gives raw access to advanced endpoints:
  - `/querier.v1.QuerierService/SelectMergeStacktraces`
  - `/querier.v1.QuerierService/SelectSeries`
  - `/querier.v1.QuerierService/Diff`
- For Grafana Cloud Pyroscope, set `PYROSCOPE_BASE_URL` to your stack URL and `PYROSCOPE_AUTH_TOKEN` to a service account token.

---

## Query smoke test

1. Start Pyroscope locally:

```bash
docker run -d --name pyroscope -p 4040:4040 grafana/pyroscope:latest
```

2. Query label names from the last hour:

```bash
NOW_MS=$(($(date +%s)*1000))
START_MS=$((NOW_MS-3600000))
curl -sS -H 'Content-Type: application/json' \
  -d "{\"start\":$START_MS,\"end\":$NOW_MS}" \
  http://localhost:4040/querier.v1.QuerierService/LabelNames
```

3. Query service names from the last hour:

```bash
NOW_MS=$(($(date +%s)*1000))
START_MS=$((NOW_MS-3600000))
curl -sS -H 'Content-Type: application/json' \
  -d "{\"name\":\"service_name\",\"start\":$START_MS,\"end\":$NOW_MS}" \
  http://localhost:4040/querier.v1.QuerierService/LabelValues
```
