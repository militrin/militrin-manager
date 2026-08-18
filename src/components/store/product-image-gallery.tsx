"use client";

import { useEffect, useRef, useState, type PointerEvent, type TouchEvent } from "react";

export type GalleryImage = { id?: string; url: string };

const ZOOM_SCALE = 2.2;
const SWIPE_THRESHOLD_PX = 40;

function useHoverCapable() {
  const [hoverCapable, setHoverCapable] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const handleChange = (event: MediaQueryListEvent) => setHoverCapable(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);
  return hoverCapable;
}

/**
 * Imagem principal + navegacao da galeria de um produto.
 * Desktop: zoom acompanha o cursor ao passar o mouse (so quando o
 * dispositivo tem hover real, para nao conflitar com o swipe no touch).
 * Mobile: troca de imagem por swipe horizontal, sem depender de hover.
 * Com 0 ou 1 imagem, nenhum controle de navegacao e exibido.
 */
export function ProductImageGallery({ images, alt }: { images: GalleryImage[]; alt: string }) {
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const hoverCapable = useHoverCapable();

  const hasImages = images.length > 0;
  const hasMultiple = images.length > 1;
  const current = hasImages ? images[Math.min(index, images.length - 1)] : null;

  function updateOrigin(clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    setOrigin({ x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) });
  }

  function handlePointerEnter(e: PointerEvent<HTMLDivElement>) {
    if (!hoverCapable || e.pointerType === "touch") return;
    updateOrigin(e.clientX, e.clientY);
    setZoomed(true);
  }
  function handlePointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!hoverCapable || e.pointerType === "touch" || !zoomed) return;
    updateOrigin(e.clientX, e.clientY);
  }
  function handlePointerLeave() {
    setZoomed(false);
  }

  function goTo(next: number) {
    setIndex(((next % images.length) + images.length) % images.length);
  }

  function handleTouchStart(e: TouchEvent<HTMLDivElement>) {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function handleTouchEnd(e: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
      goTo(index + (dx < 0 ? 1 : -1));
    }
  }

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="relative aspect-square w-full touch-pan-y select-none overflow-hidden rounded-2xl bg-slate-800"
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onTouchStart={hasMultiple ? handleTouchStart : undefined}
        onTouchEnd={hasMultiple ? handleTouchEnd : undefined}
      >
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.url}
            alt={alt}
            draggable={false}
            className="h-full w-full object-cover transition-transform duration-150 ease-out"
            style={zoomed ? { transform: `scale(${ZOOM_SCALE})`, transformOrigin: `${origin.x}% ${origin.y}%` } : undefined}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">Sem imagem</div>
        )}

        {hasMultiple ? (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              aria-label="Imagem anterior"
              className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-slate-950/70 p-2 text-slate-100 sm:flex"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              aria-label="Próxima imagem"
              className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-slate-950/70 p-2 text-slate-100 sm:flex"
            >
              ›
            </button>
            <span className="absolute bottom-2 right-2 rounded-full bg-slate-950/70 px-2 py-0.5 text-[10px] text-slate-200">
              {index + 1}/{images.length}
            </span>
          </>
        ) : null}
      </div>

      {hasMultiple ? (
        <div className="flex justify-center gap-1.5">
          {images.map((image, i) => (
            <button
              key={image.id ?? `${image.url}-${i}`}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Ver imagem ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${i === index ? "w-5 bg-emerald-400" : "w-1.5 bg-slate-600"}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
