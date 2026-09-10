"use client";

import { useEffect } from "react";

// Depois do GET, o token já está no form (campo hidden). Tira token_hash
// da barra de endereço para não vazar em Referer, histórico compartilhado
// ou analytics. Esta página não confirma o OTP.
export function StripConfirmQuery() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.search) return;
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return null;
}
