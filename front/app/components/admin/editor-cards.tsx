import { ReadOnlyId } from "./editor-fields";

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/70 bg-white/55 p-4 shadow-[0_8px_28px_rgba(44,43,40,0.06)] backdrop-blur-xl sm:p-6">
      <div className="mb-5 space-y-1">
        <h2 className="font-display text-2xl font-normal text-warm-800">
          {title}
        </h2>
        {description && (
          <p className="text-sm leading-relaxed text-warm-500">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

export function ItemCard({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-warm-200/80 bg-white/65 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-base font-medium text-warm-800">{title}</h3>
        <ReadOnlyId label="ID technique" value={id} />
      </div>
      {children}
    </div>
  );
}
