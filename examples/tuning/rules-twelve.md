# Twelve rules

- Do not silently swallow errors. When code catches or receives an error it must rethrow it, return it to the caller, or log it with enough context to debug.
- Do not add fallback values or default branches that hide a failure the caller needs to know about.
- Do not leave stubs, placeholders, TODO implementations or fake data in code that is presented as finished.
- Do not write comments that only restate what the code does, or that narrate the change being made ("now we also handle X", "fixed the bug where"). A comment that explains why the code must be this way is fine.
- Do not delete, skip or loosen an existing test to make it pass.
- Do not hardcode a value or special-case a specific input just to make a test or check pass.
- Do not leave debugging output such as console.log or print in code that is not a test.
- Do not weaken types to make an error go away: no any, no casts through unknown, no ignore comments without a reason on the same line.
- Do not read an environment variable in the middle of a function. Take it as an argument, so the caller can see what the code depends on.
- Do not retry a request without a limit and a wait between tries.
- Do not write a new helper that does what a helper next to it already does.
- Do not catch an error only to throw a new one that says less than the one it caught.
