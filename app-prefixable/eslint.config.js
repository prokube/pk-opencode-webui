import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // Disallow any type (warn for gradual adoption)
      "@typescript-eslint/no-explicit-any": "warn",

      // No console.log in production code (warn for now)
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // No unused variables (warn with underscore prefix exception)
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }],

      // Prefer const over let
      "prefer-const": "warn",

      // No var declarations
      "no-var": "error",

      // Allow @ts-ignore (used in existing code)
      "@typescript-eslint/ban-ts-comment": "off",

      // Allow control characters in regex (used for terminal handling)
      "no-control-regex": "off"
    }
  },
  {
    files: ["src/**/*.tsx"],
    rules: {
      // Solid assigns variable refs through JSX, which this core rule cannot detect.
      "no-unassigned-vars": "off"
    }
  },
  {
    ignores: ["dist/**", "node_modules/**", "*.config.js", "src/sdk/**"]
  }
)
