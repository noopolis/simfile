const allowedExtensions = Object.freeze([".ts", ".mjs"] as const);

const typescript = Object.freeze({
  strict: true,
  noEmit: true,
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext"
} as const);

const esbuild = Object.freeze({
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: true,
  sourcemap: false,
  legalComments: "none",
  charset: "utf8"
} as const);

/** Fixed, host-owned inputs for B11 dynamics preparation. */
export const DYNAMICS_BUILD_CONTRACT = Object.freeze({
  allowedExtensions,
  typescript,
  esbuild
} as const);

const nodeBuiltins = Object.freeze(["node:crypto"] as const);

const preparationEsbuild = Object.freeze({
  ignoreAnnotations: true,
  onLoadTranspile: Object.freeze({
    loader: "js",
    module: "ESNext",
    target: "ES2022"
  } as const)
} as const);

const preparationPackage = Object.freeze({
  manifestFileName: "package.json",
  namePattern: "^(?:@[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$",
  nodeModulesDirectory: "node_modules",
  scopePrefix: "@",
  versionPattern: "^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:(?:-(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?|(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$",
} as const);

const preparationSource = Object.freeze({
  ambiguousJavaScriptExtension: ".js",
  checkedExtensions: Object.freeze([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts"] as const),
  declarationExtensions: Object.freeze([".d.ts", ".d.mts", ".d.cts"] as const),
  javaScriptSyntaxExtensions: Object.freeze([".js", ".mjs", ".cjs"] as const),
  rejectRuntimeTypeExtensions: Object.freeze([".tsx", ".mts", ".cts"] as const),
  transformExtensions: Object.freeze([".ts", ".tsx", ".mts", ".cts", ".mjs"] as const)
} as const);

const preparationSuppression = Object.freeze({
  commentKinds: Object.freeze(["single-line"] as const),
  directivePrefix: "@ts-",
  placement: "full-line",
  fullLineDirectives: Object.freeze(["nocheck", "ignore", "expect-error"] as const)
} as const);

const preparationTypeSurface = Object.freeze({
  acceptedErasedForms: Object.freeze([
    "import-clause",
    "import-specifiers",
    "export-declaration",
    "export-specifiers",
    "namespace-export",
    "import-type",
    "import-equals"
  ] as const),
  moduleSpecifier: "simfile/dynamics",
  runtimeCallForms: Object.freeze(["dynamic-import", "require-direct", "require-call"] as const),
  runtimeExpressionUnwrap: Object.freeze([
    "parenthesized",
    "as-expression",
    "type-assertion",
    "non-null",
    "comma-right"
  ] as const),
  runtimeResolutionFailure: "dynamics build permits only erased type-only simfile/dynamics references"
} as const);

const preparationTypescript = Object.freeze({
  allowJs: true,
  checkJs: true,
  compilerOptions: Object.freeze({
    allowImportingTsExtensions: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2022"
  } as const),
  projectPackageType: "module",
  rejectDiagnosticSuppressions: true,
  runtimeNoDtsResolution: true,
  typeRootPackage: "@types/node",
  typeRootResolution: "package-parent",
  types: Object.freeze(["node"] as const)
} as const);

/**
 * B12-only preparation rules.  This is intentionally separate from the B11
 * contract above, which is consumed by the public schema and must not drift.
 */
export const DYNAMICS_BUILD_PREPARATION_POLICY = Object.freeze({
  esbuild: preparationEsbuild,
  nodeBuiltins,
  package: preparationPackage,
  source: preparationSource,
  simfileDynamics: preparationTypeSurface,
  suppression: preparationSuppression,
  typescript: preparationTypescript
} as const);
