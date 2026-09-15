type TextInputType = "text" | "url" | "email" | "number";

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
      <label htmlFor={id} className="admin-text block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="admin-input w-full rounded-xl px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-sage-300/50"
      />
      {help && (
        <p className="admin-text-muted text-sm leading-relaxed">{help}</p>
      )}
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
      <label htmlFor={id} className="admin-text block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="admin-input w-full resize-y rounded-xl px-3 py-2 text-sm leading-relaxed outline-none transition focus:ring-2 focus:ring-sage-300/50"
      />
    </div>
  );
}

export function ReadOnlyId({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-sunken admin-text-subtle break-all rounded-lg px-3 py-2 text-xs">
      <span className="admin-text-muted font-medium">{label} :</span> {value}
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
    <div className="admin-panel rounded-xl p-3">
      <label htmlFor={id} className="admin-text block text-sm font-medium">
        {label}
      </label>
      <div className="mt-2 flex items-center gap-3">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="admin-input h-11 w-14 cursor-pointer rounded-lg p-1 focus:outline-none focus:ring-2 focus:ring-sage-300"
        />
        <span
          className="admin-border-strong h-8 w-8 rounded-full border"
          style={{ backgroundColor: value }}
          aria-hidden="true"
        />
        <code className="admin-sunken break-all rounded-md px-2 py-1 text-xs">
          {value}
        </code>
      </div>
    </div>
  );
}
