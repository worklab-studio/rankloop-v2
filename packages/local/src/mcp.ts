/** A minimal MCP client over streamable HTTP.
 *
 * The dashboard's `/mcp` endpoint is the machine surface spec 0023 built for
 * agents, and in `local_noauth` mode it needs no token — so the whole client
 * is: initialize, then `tools/call`, parsing either a plain JSON body or an
 * SSE-framed one (the transport may answer with `text/event-stream` even for
 * a single response).
 *
 * Hand-rolled instead of pulling the SDK for the same reason the CLI
 * hand-rolls argv: this package ships zero runtime dependencies, and a
 * dependency that could one day grow a postinstall script is not worth
 * avoiding ~100 lines. */

export interface McpToolResult {
  /** The tool's structured payload — what the runner actually consumes. */
  structured: Record<string, unknown> | null;
  /** The human-readable text blocks, kept for logs and error messages. */
  text: string;
  isError: boolean;
}

export interface McpClient {
  call(tool: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export async function connectMcp(
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<McpClient> {
  const endpoint = new URL("/mcp", serverUrl).toString();
  let sessionId: string | null = null;
  let nextId = 1;

  async function post(body: Record<string, unknown>): Promise<unknown | null> {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Both, per the streamable-HTTP spec — the server picks.
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

    const sid = response.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    // Notifications get 202/204 with no body; that is success, not silence
    // to worry about.
    if (response.status === 202 || response.status === 204) return null;

    const raw = await response.text();
    if (response.status >= 400) {
      throw new Error(
        `rankloop answered ${response.status} on ${endpoint}: ${raw.slice(0, 300)}`,
      );
    }
    return parseBody(raw);
  }

  await post({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "rankloop-local", version: "0.1.0" },
    },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    async call(tool, args) {
      const payload = await post({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: tool, arguments: args },
      });
      return toToolResult(tool, payload);
    },
  };
}

/** The body may be plain JSON or one-or-more SSE `data:` frames. The last
 *  data frame carries the response — earlier ones are progress we ignore. */
export function parseBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed);
  }
  const frames = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== "");
  const last = frames.at(-1);
  if (last === undefined) throw new Error("SSE response carried no data frame");
  return JSON.parse(last);
}

function toToolResult(tool: string, payload: unknown): McpToolResult {
  if (payload === null || typeof payload !== "object") {
    throw new Error(`${tool}: empty response from the server`);
  }
  const envelope = payload as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: { type?: string; text?: string }[];
    };
  };
  if (envelope.error) {
    throw new Error(`${tool}: ${envelope.error.message ?? "JSON-RPC error"}`);
  }
  const result = envelope.result ?? {};
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");

  // A tool-level error is data, not an exception: the caller decides whether
  // "no approved proposals" ends the run or just this proposal.
  return {
    structured: result.structuredContent ?? null,
    text,
    isError: result.isError === true,
  };
}
