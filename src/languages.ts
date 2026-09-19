/**
 * The one table of supported languages, and the one table of node types that make a unit.
 *
 * Every node type is written out here. Nothing is guessed at run time, and
 * `scripts/check-languages.mjs` loads each grammar at build time and fails when a name in
 * this file is not a node type of that grammar. The README table is checked against
 * EXTENSIONS by the same script, so code and docs cannot drift.
 */

/** A piece holds at most this many added lines. Measured: 40 worked, single units did not. */
export const MAX_ADDED_PER_PIECE = 40;

export type GrammarKey =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "kotlin"
  | "swift";

/**
 * What makes a unit, per grammar.
 *
 * fn             a function, method, constructor or accessor. Always a unit.
 * member         a class, impl, trait or interface member that is not a function.
 * memberOnlyInBody  count a member only when its parent is one of `bodies`.
 * lambda         a unit only when it is assigned at top level.
 * bodies         class, impl, trait, interface, enum and module bodies. Their direct
 *                children are the grain of the "enclosing top level statement" rule.
 * bodiesParent   restricts a body type to bodies whose parent has one of these types.
 * wrappers       when the chosen unit's parent has this type, take the parent instead, so
 *                `export`, decorators and the `const x =` of a lambda stay in the piece.
 * attachPrefix   sibling nodes just before an item that belong to it: doc comments, Rust
 *                attributes. An added line inside one moves to the item that follows.
 * stmtContainers statement lists, used to find a unit's direct child statements when a unit
 *                over 40 added lines has to be split.
 */
export interface UnitTable {
  fn: readonly string[];
  member: readonly string[];
  memberOnlyInBody: boolean;
  lambda: readonly string[];
  bodies: readonly string[];
  bodiesParent: Readonly<Record<string, readonly string[]>>;
  wrappers: readonly string[];
  attachPrefix: readonly string[];
  stmtContainers: readonly string[];
}

/** File extension to grammar. The one list code and the README both use. */
export const EXTENSIONS: Readonly<Record<string, GrammarKey>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".jsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
};

/** The name used in messages, and the wasm file name under grammars/. */
export const GRAMMAR_TITLE: Readonly<Record<GrammarKey, string>> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
};

export function grammarWasmName(key: GrammarKey): string {
  return `${key}.wasm`;
}

/** The extension of a path, lower case, including the dot. Empty when it has none. */
export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function grammarForPath(filePath: string): GrammarKey | null {
  return EXTENSIONS[extensionOf(filePath)] ?? null;
}

const TS_FN = [
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "function_signature",
  "abstract_method_signature",
  "method_signature",
  "construct_signature",
];
const TS_MEMBER = [
  "public_field_definition",
  "property_signature",
  "index_signature",
  "enum_assignment",
];
const TS_LAMBDA = ["arrow_function", "function_expression", "generator_function"];
const TS_BODIES = ["class_body", "interface_body", "object_type", "enum_body"];
const TS_WRAPPERS = [
  "export_statement",
  "ambient_declaration",
  "lexical_declaration",
  "variable_declaration",
  "expression_statement",
];
const TS_TABLE: UnitTable = {
  fn: TS_FN,
  member: TS_MEMBER,
  memberOnlyInBody: false,
  lambda: TS_LAMBDA,
  bodies: TS_BODIES,
  bodiesParent: {},
  wrappers: TS_WRAPPERS,
  attachPrefix: ["comment", "decorator"],
  stmtContainers: ["statement_block", "class_body", "program", "switch_body"],
};

/** The JavaScript grammar has no type level nodes, so its lists are shorter on purpose. */
const JS_TABLE: UnitTable = {
  fn: ["function_declaration", "generator_function_declaration", "method_definition"],
  member: ["field_definition"],
  memberOnlyInBody: false,
  lambda: TS_LAMBDA,
  bodies: ["class_body"],
  bodiesParent: {},
  wrappers: [
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
    "expression_statement",
  ],
  attachPrefix: ["comment", "decorator"],
  stmtContainers: ["statement_block", "class_body", "program", "switch_body"],
};

export const TABLES: Readonly<Record<GrammarKey, UnitTable>> = {
  typescript: TS_TABLE,
  tsx: TS_TABLE,
  javascript: JS_TABLE,

  python: {
    fn: ["function_definition"],
    member: [],
    memberOnlyInBody: false,
    lambda: ["lambda"],
    bodies: ["block"],
    bodiesParent: { block: ["class_definition"] },
    wrappers: ["decorated_definition"],
    attachPrefix: ["comment"],
    stmtContainers: ["block", "module"],
  },

  go: {
    fn: ["function_declaration", "method_declaration"],
    member: [],
    memberOnlyInBody: false,
    lambda: ["func_literal"],
    bodies: [],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["comment"],
    stmtContainers: ["block", "source_file"],
  },

  rust: {
    fn: ["function_item", "function_signature_item"],
    member: ["const_item", "static_item", "type_item", "associated_type"],
    memberOnlyInBody: true,
    lambda: ["closure_expression"],
    bodies: ["declaration_list"],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["attribute_item", "inner_attribute_item", "line_comment", "block_comment"],
    stmtContainers: [
      "block",
      "declaration_list",
      "source_file",
      "field_declaration_list",
      "enum_variant_list",
    ],
  },

  ruby: {
    fn: ["method", "singleton_method"],
    member: [],
    memberOnlyInBody: false,
    lambda: ["lambda"],
    bodies: ["body_statement"],
    bodiesParent: { body_statement: ["class", "module", "singleton_class"] },
    wrappers: [],
    attachPrefix: ["comment"],
    stmtContainers: ["body_statement", "do_block", "block", "program", "then", "else"],
  },

  java: {
    fn: [
      "method_declaration",
      "constructor_declaration",
      "compact_constructor_declaration",
      "static_initializer",
      "annotation_type_element_declaration",
    ],
    member: ["field_declaration", "enum_constant", "constant_declaration"],
    memberOnlyInBody: false,
    lambda: ["lambda_expression"],
    bodies: [
      "class_body",
      "interface_body",
      "enum_body",
      "enum_body_declarations",
      "annotation_type_body",
    ],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["line_comment", "block_comment"],
    stmtContainers: ["block", "class_body", "interface_body", "enum_body", "program"],
  },

  kotlin: {
    fn: [
      "function_declaration",
      "secondary_constructor",
      "primary_constructor",
      "anonymous_initializer",
      "getter",
      "setter",
    ],
    member: ["property_declaration", "enum_entry"],
    memberOnlyInBody: false,
    lambda: ["lambda_literal", "anonymous_function"],
    bodies: ["class_body", "enum_class_body"],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["line_comment", "block_comment"],
    stmtContainers: ["block", "class_body", "enum_class_body", "source_file", "function_body"],
  },

  swift: {
    fn: [
      "function_declaration",
      "init_declaration",
      "deinit_declaration",
      "subscript_declaration",
      "protocol_function_declaration",
      "computed_property",
    ],
    member: ["property_declaration", "protocol_property_declaration", "enum_entry"],
    memberOnlyInBody: false,
    lambda: ["lambda_literal"],
    bodies: ["class_body", "enum_class_body", "protocol_body"],
    bodiesParent: {},
    wrappers: [],
    attachPrefix: ["comment", "multiline_comment"],
    stmtContainers: ["statements", "class_body", "enum_class_body", "source_file"],
  },
};
