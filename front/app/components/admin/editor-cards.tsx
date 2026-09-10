import { ReadOnlyId } from "./editor-fields";

export function SectionCard({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="admin-panel scroll-mt-28 rounded-2xl p-4 sm:p-5">
      <div className="mb-4 space-y-1">
        <h2 className="admin-text font-display text-2xl font-normal">
          {title}
        </h2>
        {description && (
          <p className="admin-text-muted text-sm leading-relaxed">
            {description}
          </p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
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
    <div className="admin-sunken space-y-4 rounded-xl p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="admin-text text-base font-medium">{title}</h3>
        <ReadOnlyId label="ID technique" value={id} />
      </div>
      {children}
    </div>
  );
}
