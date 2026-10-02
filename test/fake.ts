/**
 * A scripted fetch for the tests: answers in order, and records every request it was sent.
 * Nothing here talks to the network.
 */

import type { FetchInit, FetchLike } from "../src/clef.js";

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** One scripted answer: a status and a JSON body, or a function of the request it answers. */
export type Scripted =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | ((request: SentRequest) => { status: number; body: unknown; headers?: Record<string, string> });

export function scriptedFetch(answers: Scripted[]): { fetchImpl: FetchLike; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const queue = [...answers];
  const fetchImpl: FetchLike = (url: string, init: FetchInit) => {
    const request: SentRequest = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
    sent.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error(`no scripted answer left for request ${sent.length}`);
    const answer = typeof next === "function" ? next(request) : next;
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json", ...answer.headers },
      }),
    );
  };
  return { fetchImpl, sent };
}

/** Workers AI's wrapped answer: one noul per question id, and the token count it reports. */
export function workersAi(answers: Record<string, number>, inputTokens: number): { status: number; body: unknown } {
  const wrapped: Record<string, { type: "noul"; noul: number }> = {};
  for (const [id, noul] of Object.entries(answers)) wrapped[id] = { type: "noul", noul };
  return {
    status: 200,
    body: {
      success: true,
      result: { model: "clef", answers: wrapped, usage: { input_tokens: inputTokens, output_tokens: 0 } },
      errors: [],
      messages: [],
    },
  };
}

/** The same answer for every question a request asked, so it fits however a node was split. */
export function answerAll(noul: number, inputTokens: number): (request: SentRequest) => { status: number; body: unknown } {
  return (request) => {
    const ids = Object.keys(request.body["questions"] as Record<string, unknown>);
    return workersAi(Object.fromEntries(ids.map((id) => [id, noul])), inputTokens);
  };
}

export const noSleep = (): Promise<void> => Promise.resolve();
