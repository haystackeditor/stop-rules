/**
 * AWS Lambda adapter. A Lambda Function URL delivers requests in the API Gateway payload
 * format version 2.0 and expects a result in the same format, so this file translates
 * both ways and leaves every decision to handler.ts.
 *
 * deploy/aws/generate-template.ts inlines the compiled form of this file and handler.ts
 * into the CloudFormation template, which is why there is only ever one copy of the logic.
 */

import { handle } from "./handler.js";

export interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

/** A payload that is not the documented one, answered plainly instead of half read. */
function badEvent(field: string): FunctionUrlResult {
  return {
    statusCode: 400,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      error: "bad_event",
      message: `this Lambda event has no ${field}, so it is not a Function URL request`,
    }),
    isBase64Encoded: false,
  };
}

export async function lambdaHandler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  // Payload format 2.0 always carries these. Reading a POST as a GET because the method was
  // missing would answer the health route instead of saying what is wrong.
  const method = event.requestContext?.http?.method;
  if (method === undefined) return badEvent("requestContext.http.method");
  if (event.rawPath === undefined) return badEvent("rawPath");
  const query = event.rawQueryString === undefined ? "" : event.rawQueryString;
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(event.headers === undefined ? {} : event.headers)) {
    if (headerValue !== undefined) headers.set(name, headerValue);
  }
  const host = headers.get("host");
  if (host === null) return badEvent("host header");
  // node:http and undici own these two; the URL and the body length carry the same facts.
  headers.delete("host");
  headers.delete("content-length");

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && typeof event.body === "string") {
    init.body =
      event.isBase64Encoded === true ? Buffer.from(event.body, "base64") : Buffer.from(event.body);
  }
  const url = `https://${host}${event.rawPath}${query.length > 0 ? `?${query}` : ""}`;
  const response = await handle(new Request(url, init), process.env);

  const out: Record<string, string> = {};
  response.headers.forEach((headerValue, name) => {
    out[name] = headerValue;
  });
  return {
    statusCode: response.status,
    headers: out,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

export const handler = lambdaHandler;
