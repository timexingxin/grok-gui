/**
 * Builds a WebView-safe URL for a locally attached image.
 *
 * Tauri owns the `asset:` protocol and performs the platform-specific path
 * encoding. Building an URL manually breaks on macOS and leaves a blank
 * attachment thumbnail behind.
 */
export function imagePreviewUrl(
  path: string,
  convert: (filePath: string) => string,
): string {
  return convert(path);
}
