// Reading a mocked fetch back, for the adapter contract tests.
//
// Shared because all three adapters are proved the same way — which URL, which
// method, which bytes went out — and because `fetch`'s own argument types are
// wide enough (string | URL | Request, HeadersInit) that narrowing them once
// beats narrowing them three times in three test files.

export type FetchCall = {
  url: string;
  method: string;
  /** Exactly the string the adapter sent, unparsed: signatures cover bytes. */
  body: string | null;
  /** Lowercased, the way a server receives them. */
  headers: Record<string, string>;
};

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function headersOf(init: Parameters<typeof fetch>[1]): Record<string, string> {
  if (!init?.headers) return {};
  return Object.fromEntries(new Headers(init.headers).entries());
}

export function recordedCalls(calls: Parameters<typeof fetch>[]): FetchCall[] {
  return calls.map(([input, init]) => ({
    url: urlOf(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : null,
    headers: headersOf(init),
  }));
}

/** The request body as an object, for the assertions that care about fields
 *  rather than bytes. Throws rather than returning a default, so a test that
 *  reads the wrong call fails on the wrong call instead of on the assertion. */
export function jsonBodyOf(call: FetchCall): Record<string, unknown> {
  if (call.body === null) {
    throw new Error(`no request body was sent to ${call.url}`);
  }
  const parsed: unknown = JSON.parse(call.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object body for ${call.url}`);
  }
  return { ...parsed };
}

export function callAt(calls: FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (!call) throw new Error(`expected a request at index ${index}`);
  return call;
}
