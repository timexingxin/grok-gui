import { useEffect } from "react";
import { X } from "lucide-react";

interface ImageLightboxProps {
  src: string | null;
  alt: string;
  closeLabel: string;
  onClose: () => void;
}

/** A local-only full-size image viewer for composer and message attachments. */
export function ImageLightbox({ src, alt, closeLabel, onClose }: ImageLightboxProps) {
  useEffect(() => {
    if (!src) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [src, onClose]);

  if (!src) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div className="relative flex max-h-full max-w-full items-center justify-center" onMouseDown={(event) => event.stopPropagation()}>
        <img src={src} alt={alt} className="max-h-[88vh] max-w-[92vw] rounded-xl object-contain shadow-2xl" />
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-background/90 text-foreground shadow-lg transition-colors hover:bg-background"
        >
          <X size={17} />
        </button>
      </div>
    </div>
  );
}
