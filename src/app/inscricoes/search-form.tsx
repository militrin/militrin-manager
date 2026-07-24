"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { SearchInput } from "@/components/mvp/SearchInput";

export function ParticipantsSearchForm({ initialSearch }: { initialSearch: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(initialSearch);

  function submit(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", "1");
    if (value.trim()) {
      params.set("search", value.trim());
    } else {
      params.delete("search");
    }
    router.push(`/inscricoes?${params.toString()}`);
  }

  return (
    <form
      className="w-full md:max-w-md"
      onSubmit={(event) => {
        event.preventDefault();
        submit(search);
      }}
    >
      <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome, CPF, telefone ou nº" />
    </form>
  );
}
