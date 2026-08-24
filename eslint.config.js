// @ts-check

import stylisticPlugin from "@stylistic/eslint-plugin";
import importPlugin from "eslint-plugin-import-x";
import nodePlugin from "eslint-plugin-n";
import globals from "globals";
import tseslint from "typescript-eslint";
import boundariesPlugin from "eslint-plugin-boundaries";

/**
 * Mirrors the shared TanStack ESLint config used by the note-canva frontend,
 * adapted for a backend: node globals instead of browser globals.
 */

const javascriptRules = {
    "for-direction": "error",
    "no-async-promise-executor": "error",
    "no-case-declarations": "error",
    "no-class-assign": "error",
    "no-compare-neg-zero": "error",
    "no-cond-assign": "error",
    "no-constant-binary-expression": "error",
    "no-constant-condition": "error",
    "no-control-regex": "error",
    "no-debugger": "error",
    "no-delete-var": "error",
    "no-dupe-else-if": "error",
    "no-duplicate-case": "error",
    "no-empty-character-class": "error",
    "no-empty-pattern": "error",
    "no-empty-static-block": "error",
    "no-ex-assign": "error",
    "no-extra-boolean-cast": "error",
    "no-fallthrough": "error",
    "no-global-assign": "error",
    "no-invalid-regexp": "error",
    "no-irregular-whitespace": "error",
    "no-loss-of-precision": "error",
    "no-misleading-character-class": "error",
    "no-nonoctal-decimal-escape": "error",
    "no-octal": "error",
    "no-regex-spaces": "error",
    "no-self-assign": "error",
    "no-shadow": "warn",
    "no-shadow-restricted-names": "error",
    "no-sparse-arrays": "error",
    "no-unsafe-finally": "error",
    "no-unsafe-optional-chaining": "error",
    "no-unused-labels": "error",
    "no-unused-private-class-members": "error",
    "no-useless-backreference": "error",
    "no-useless-catch": "error",
    "no-useless-escape": "error",
    "no-var": "error",
    "no-with": "error",
    "prefer-const": "error",
    "require-yield": "error",
    "sort-imports": ["error", { ignoreDeclarationSort: true }],
    "use-isnan": "error",
    "valid-typeof": "error"
};

const typescriptRules = {
    "@typescript-eslint/array-type": ["error", {
        default: "generic",
        readonly: "generic"
    }],
    "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-expect-error": false,
        "ts-ignore": "allow-with-description"
    }],
    "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    "@typescript-eslint/method-signature-style": ["error", "property"],
    "@typescript-eslint/naming-convention": ["error", {
        selector: "typeParameter",
        format: ["PascalCase"],
        leadingUnderscore: "forbid",
        trailingUnderscore: "forbid",
        custom: {
            regex: "^(T|T[A-Z][A-Za-z]+)$",
            match: true
        }
    }],
    "@typescript-eslint/no-duplicate-enum-values": "error",
    "@typescript-eslint/no-extra-non-null-assertion": "error",
    "@typescript-eslint/no-for-in-array": "error",
    "@typescript-eslint/no-inferrable-types": ["error", { ignoreParameters: true }],
    "@typescript-eslint/no-misused-new": "error",
    "@typescript-eslint/no-namespace": "error",
    "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
    "@typescript-eslint/no-unnecessary-condition": "error",
    "@typescript-eslint/no-unnecessary-type-assertion": "error",
    "@typescript-eslint/no-unsafe-function-type": "error",
    "@typescript-eslint/no-wrapper-object-types": "error",
    "@typescript-eslint/prefer-as-const": "error",
    "@typescript-eslint/prefer-for-of": "warn",
    "@typescript-eslint/require-await": "warn",
    "@typescript-eslint/triple-slash-reference": "error"
};

const importRules = {
    "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
    "import/first": "error",
    "import/newline-after-import": "error",
    "import/no-commonjs": "error",
    "import/no-duplicates": "error",
    "import/order": ["error", { groups: [
        "builtin",
        "external",
        "internal",
        "parent",
        "sibling",
        "index",
        "object",
        "type"
    ] }]
};

const moduleNames = [
    "auth",
    "billing",
    "boards",
    "collaboration",
    "previews",
    "realtime",
    "users",
    "workspaces"
];

const boundariesRules = {
    "boundaries/dependencies": ["error", {
        default: "disallow",
        policies: [
            {
                // Any element may import external packages and node builtins.
                allow: { to: { module: { origin: "external" } } }
            },
            {
                // shared depends only on itself.
                from: { element: { type: "shared" } },
                allow: { to: { element: { type: "shared" } } }
            },
            {
                // platform may depend on shared and platform.
                from: { element: { type: "platform" } },
                allow: { to: { element: { types: { anyOf: ["shared", "platform"] } } } }
            },
            {
                // Modules may depend on shared, platform, and other modules
                // (entry-point discipline is enforced separately below).
                from: { element: { type: "module" } },
                allow: { to: { element: { types: { anyOf: ["shared", "platform", "module"] } } } }
            },
            {
                // The composition root (app) may depend on everything.
                from: { element: { type: "app" } },
                allow: { to: { element: { types: { anyOf: ["app", "shared", "platform", "module"] } } } }
            }
        ]
    }]
};

// Public-surface rule: outside of module X, imports must come from
// `@/modules/X/index.js`, never from X's internal files.
// One lint block per importer context so flat-config cascading never
// drops another module's restriction for the same file.
function surfacePatterns(exceptModuleName) {
    return moduleNames
        .filter((moduleName) => moduleName !== exceptModuleName)
        .map((moduleName) => ({
            group: [
                `@/modules/${moduleName}/*`,
                `@/modules/${moduleName}/*/**`,
                `!@/modules/${moduleName}/index.js`
            ],
            message: `use the public surface @/modules/${moduleName}/index.js`
        }));
}

const publicSurfaceBlocks = [
    ...moduleNames.map((moduleName) => ({
        name: `backend/module-surface/${moduleName}`,
        files: [`src/modules/${moduleName}/**`],
        rules: {
            "no-restricted-imports": ["error", { patterns: surfacePatterns(moduleName) }]
        }
    })),
    {
        name: "backend/module-surface/composition-root",
        files: ["src/app/**", "src/shared/**", "src/platform/**", "src/apps/**"],
        rules: {
            "no-restricted-imports": ["error", { patterns: surfacePatterns(null) }]
        }
    }
];

const nodeRules = { "node/prefer-node-protocol": "error" };

const stylisticRules = { "@stylistic/spaced-comment": "error" };

export default [
    {
        name: "backend/ignores",
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/coverage/**",
            "drizzle/**",
            "docs/**",
            "docs_old/**",
            "nginx/**"
        ]
    },
    {
        name: "backend/architecture",
        files: ["src/**/*.{js,ts}"],
        plugins: {
            "boundaries": boundariesPlugin
        },
        settings: {
            "boundaries/include": ["src/**/*"],
            "boundaries/exclude": ["src/**/*.test.ts"],
            "import/resolver": {
                typescript: {
                    alwaysTryTypes: true,
                    project: "./tsconfig.json"
                }
            },
            "boundaries/elements": [
                { type: "app", pattern: ["src/app/**", "src/apps/**"] },
                { type: "module", pattern: "src/modules/*/**" },
                { type: "platform", pattern: "src/platform/**" },
                { type: "shared", pattern: "src/shared/**" }
            ]
        },
        rules: {
            ...boundariesRules
        }
    },
    ...publicSurfaceBlocks,
    {
        name: "backend/javascript",
        files: ["**/*.{js,ts}"],
        languageOptions: {
            sourceType: "module",
            ecmaVersion: 2022,
            parser: tseslint.parser,
            parserOptions: {
                project: "./tsconfig.eslint.json",
                tsconfigRootDir: import.meta.dirname
            },
            globals: { ...globals.node }
        },
        plugins: {
            "@stylistic": stylisticPlugin,
            "@typescript-eslint": tseslint.plugin,
            "import": importPlugin,
            "node": nodePlugin
        },
        rules: {
            ...javascriptRules,
            ...typescriptRules,
            ...importRules,
            ...nodeRules,
            ...stylisticRules,
            "indent": ["error", 4, { "SwitchCase": 1 }],
            "@typescript-eslint/array-type": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/consistent-type-imports": "off",
            "semi": ["error", "always"]
        }
    }
];
