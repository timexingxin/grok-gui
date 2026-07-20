const VIEWPORT_INSET = 8;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/** Clamp a fixed context menu so it never opens beyond a viewport edge. */
export function contextMenuPosition(
  point: { x: number; y: number },
  viewport: ViewportSize,
  menu: MenuSize,
): { x: number; y: number } {
  return {
    x: Math.max(VIEWPORT_INSET, Math.min(point.x, viewport.width - menu.width - VIEWPORT_INSET)),
    y: Math.max(VIEWPORT_INSET, Math.min(point.y, viewport.height - menu.height - VIEWPORT_INSET)),
  };
}
