type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
};

export function SearchInput({ value, onChange, placeholder, disabled }: SearchInputProps) {
  return (
    <label className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
      <span className="text-slate-500">⌕</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full bg-transparent outline-none"
      />
    </label>
  );
}
