# A rule of the kind that works: a named thing not to call, and what to call instead

- Never call `fetch` directly. Use the `httpGet` helper from `src/http.ts`, which adds the
  auth header, the timeout and the retry.
