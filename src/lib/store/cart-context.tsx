'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type AccountCartLine = {
  /** null para produto global (Todos os eventos) comprado sem nenhum evento vinculado -- vira store_orders.event_id = null. */
  eventId: string | null;
  eventName: string;
  itemId: string;
  itemName: string;
  imageUrl: string | null;
  variantId: string | null;
  variantLabel: string | null;
  unitPrice: number;
  quantity: number;
  supplyMode: 'stock' | 'made_to_order';
};

type CartState = Record<string, AccountCartLine>;

const STORAGE_PREFIX = 'militrin-store-cart:';

type StoreCartContextValue = {
  lines: AccountCartLine[];
  totalCount: number;
  addLine: (line: AccountCartLine) => void;
  removeLine: (eventId: string | null, itemId: string) => void;
  setQuantity: (eventId: string | null, itemId: string, quantity: number) => void;
  clearEvent: (eventId: string | null) => void;
};

const StoreCartContext = createContext<StoreCartContextValue | null>(null);

function lineKey(eventId: string | null, itemId: string) {
  return `${eventId ?? '__global__'}:${itemId}`;
}

export function StoreCartProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const storageKey = `${STORAGE_PREFIX}${userId}`;
  const [state, setState] = useState<CartState>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) setState(JSON.parse(raw) as CartState);
      } catch {
        // localStorage indisponível ou dados corrompidos: segue com carrinho vazio.
      } finally {
        setHydrated(true);
      }
    });
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Armazenamento indisponível (modo privado, cota excedida etc): ignora silenciosamente.
    }
  }, [state, storageKey, hydrated]);

  const addLine = useCallback((line: AccountCartLine) => {
    setState((prev) => {
      const key = lineKey(line.eventId, line.itemId);
      const existing = prev[key];
      const sameVariant = existing && existing.variantId === line.variantId;
      const quantity = sameVariant ? existing.quantity + line.quantity : line.quantity;
      return { ...prev, [key]: { ...line, quantity } };
    });
  }, []);

  const removeLine = useCallback((eventId: string | null, itemId: string) => {
    setState((prev) => {
      const next = { ...prev };
      delete next[lineKey(eventId, itemId)];
      return next;
    });
  }, []);

  const setQuantity = useCallback((eventId: string | null, itemId: string, quantity: number) => {
    setState((prev) => {
      const key = lineKey(eventId, itemId);
      const existing = prev[key];
      if (!existing) return prev;
      if (quantity <= 0) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: { ...existing, quantity } };
    });
  }, []);

  const clearEvent = useCallback((eventId: string | null) => {
    setState((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key].eventId === eventId) delete next[key];
      }
      return next;
    });
  }, []);

  const lines = useMemo(() => Object.values(state), [state]);
  const totalCount = useMemo(() => lines.reduce((sum, line) => sum + line.quantity, 0), [lines]);

  const value = useMemo<StoreCartContextValue>(
    () => ({ lines, totalCount, addLine, removeLine, setQuantity, clearEvent }),
    [lines, totalCount, addLine, removeLine, setQuantity, clearEvent]
  );

  return <StoreCartContext.Provider value={value}>{children}</StoreCartContext.Provider>;
}

export function useStoreCart() {
  const ctx = useContext(StoreCartContext);
  if (!ctx) throw new Error('useStoreCart deve ser usado dentro de StoreCartProvider');
  return ctx;
}
