# Three rules

- Do not silently swallow errors. When code catches or receives an error it must rethrow it, return it to the caller, or log it with enough context to debug.
- Do not add fallback values or default branches that hide a failure the caller needs to know about.
- Do not leave stubs, placeholders, TODO implementations or fake data in code that is presented as finished.
