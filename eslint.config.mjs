import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/target/**",
      "**/gen/**",
      "**/*.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // ACP payloads are intentionally untyped at the event boundary. They
      // are normalized in the core store before application use.
      "@typescript-eslint/no-explicit-any": "off",
      // TypeScript checks global names against the configured DOM/Node libs;
      // duplicating that in ESLint produces false positives in Tauri code.
      "no-undef": "off",
    },
  },
);
