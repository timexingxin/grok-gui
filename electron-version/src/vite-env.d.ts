/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Compile-time product name injected by electron-vite `define` ("Grok GUI").
declare const __APP_NAME__: string;
