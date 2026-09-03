"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { generateQrDataUrl } from "@/lib/qr/generate-qr-data-url";

type LocalQrImageProps = {
  value: string;
  alt: string;
  size?: number;
  className?: string;
};

export function LocalQrImage({ value, alt, size = 320, className }: LocalQrImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Reset state via queueMicrotask to avoid synchronous setState inside effect
    // (which triggers the react-compiler/cascading-renders lint rule).
    queueMicrotask(() => {
      if (!cancelled) {
        setFailed(false);
        setSrc(null);
      }
    });
    void generateQrDataUrl(value, size)
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    return <p className="text-sm text-rose-300">Não foi possível gerar o QR Code.</p>;
  }

  if (!src) {
    return (
      <div
        className={className ?? "flex items-center justify-center bg-white"}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return <Image src={src} alt={alt} width={size} height={size} unoptimized className={className ?? "h-auto w-full"} />;
}
