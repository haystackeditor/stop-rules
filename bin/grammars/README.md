# Vendored tree-sitter files

These files are committed on purpose, so a clone of this repository can run the checker with
no install and no build. `stop-rules init` copies `tree-sitter.wasm` and only the grammars
a repository needs into that repository's `.stop-rules/` folder.

`npm run verify:bin` fails when any file here is not byte for byte the file in
`node_modules`, so what is committed is always what the build produced.

## The parser

| File | Package | Version | Licence |
|---|---|---|---|
| `tree-sitter.wasm` | web-tree-sitter | 0.25.10 | MIT |

## The grammars

| File | Language | Package it came from | Grammar | Licence |
|---|---|---|---|---|
| `typescript.wasm` | TypeScript | tree-sitter-wasms@0.1.13 | tree-sitter-typescript | MIT |
| `tsx.wasm` | TSX | tree-sitter-wasms@0.1.13 | tree-sitter-typescript (tsx) | MIT |
| `javascript.wasm` | JavaScript | tree-sitter-wasms@0.1.13 | tree-sitter-javascript | MIT |
| `python.wasm` | Python | tree-sitter-python@0.25.0 | tree-sitter-python | MIT |
| `go.wasm` | Go | tree-sitter-wasms@0.1.13 | tree-sitter-go | MIT |
| `rust.wasm` | Rust | tree-sitter-wasms@0.1.13 | tree-sitter-rust | MIT |
| `ruby.wasm` | Ruby | tree-sitter-wasms@0.1.13 | tree-sitter-ruby | MIT |
| `java.wasm` | Java | tree-sitter-wasms@0.1.13 | tree-sitter-java | MIT |
| `kotlin.wasm` | Kotlin | @tree-sitter-grammars/tree-sitter-kotlin@1.1.0 | tree-sitter-kotlin | MIT |
| `swift.wasm` | Swift | tree-sitter-wasms@0.1.13 | tree-sitter-swift | MIT |

Every licence above is the one that package publishes. MIT and the Unlicense both allow
redistribution, which is what lets these files be committed here and copied into your
repository. `tree-sitter-wasms` itself is released under the Unlicense; each wasm file it
builds carries the licence of the grammar it was built from, so the grammar is what the last
column names.
