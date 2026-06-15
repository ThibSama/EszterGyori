type TextInputType = "text" | "url" | "email";

export function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  help,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: TextInputType;
  help?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-warm-800">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-warm-300/70 bg-white/80 px-3 py-2 text-sm text-warm-800 shadow-sm outline-none transition placeholder:text-warm-400 focus:border-sage-500 focus:ring-2 focus:ring-sage-300/50"
      />
      {help && <p className="text-xs leading-relaxed text-warm-500">{help}</p>}
    </div>
  );
}

export function TextArea({
  id,
  label,
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-warm-800">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-xl border border-warm-300/70 bg-white/80 px-3 py-2 text-sm leading-relaxed text-warm-800 shadow-sm outline-none transition placeholder:text-warm-400 focus:border-sage-500 focus:ring-2 focus:ring-sage-300/50"
      />
    </div>
  );
}

export function ReadOnlyId({ label, value }: { label: string; value: string }) {
  return (
    <div className="break-all rounded-lg bg-warm-100/70 px-3 py-2 text-xs text-warm-500">
      <span className="font-medium text-warm-600">{label} :</span> {value}
    </div>
  );
}

export function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="rounded-xl border border-warm-200/80 bg-white/65 p-3">
      <label htmlFor={id} className="block text-sm font-medium text-warm-800">
        {label}
      </label>
      <div className="mt-2 flex items-center gap-3">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-14 cursor-pointer rounded-lg border border-warm-300 bg-white p-1 focus:outline-none focus:ring-2 focus:ring-sage-300"
        />
        <span
          className="h-8 w-8 rounded-full border border-warm-300 shadow-sm"
          style={{ backgroundColor: value }}
          aria-hidden="true"
        />
        <code className="break-all rounded-md bg-warm-100 px-2 py-1 text-xs text-warm-600">
          {value}
        </code>
      </div>
    </div>
  );
}
