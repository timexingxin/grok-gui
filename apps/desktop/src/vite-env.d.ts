/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Compile-time product name injected by Vite `define` ("Grok GUI Lite").
declare const __APP_NAME__: string;
