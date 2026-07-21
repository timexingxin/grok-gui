declare module "*.png" {
  const src: string;
  export default src;
}

// Compile-time product name injected by each build's Vite `define`.
declare const __APP_NAME__: string;
