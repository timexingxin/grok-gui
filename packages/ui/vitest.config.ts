// Tests run outside Vite's build pipeline, so the compile-time `__APP_NAME__`
// constant (injected via `define` in vite.config.ts) would be undefined here
// and throw at module load. Provide the default product name for tests.
// Plain object export (vitest 4 does not re-export `defineConfig` from its
// package entry, and this config file is not type-checked by tsc/eslint).
export default {
  define: {
    __APP_NAME__: JSON.stringify("Grok GUI"),
  },
};
