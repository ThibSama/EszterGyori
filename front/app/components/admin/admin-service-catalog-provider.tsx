"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAdminSession } from "./admin-session-provider";
import type { AdminApiFailure, AdminBookableService } from "../../lib/admin-api";
import { adoptStoredService } from "../../lib/admin-services";

/**
 * The service catalog, read once per admin visit and shared (ESZ-149).
 *
 * Three surfaces need it: the `Prestations` page edits it, and the calendar
 * and the operations summary name each booking's service from it. Before
 * ESZ-149 those two carried a hard-coded key→label map that could only ever
 * drift from the database; now the catalog — archived rows included, because
 * a historical booking may name an archived service — is the single source of
 * a service's name, and a key the catalog does not know renders as itself
 * rather than as an invented label.
 *
 * ## What it does not own
 *
 * No write goes through here. The `Prestations` page sends every mutation to
 * the admin API and hands the stored row back through `adopt`, so this cache
 * only ever holds what the server returned.
 */

export type AdminServiceCatalogStatus = "loading" | "ready" | "error";

interface AdminServiceCatalogValue {
  readonly status: AdminServiceCatalogStatus;
  readonly services: AdminBookableService[];
  readonly failure: AdminApiFailure | null;
  /** Re-reads the whole catalog from the server. */
  readonly reload: () => Promise<void>;
  /** Replaces or appends one row the server just stored. */
  readonly adopt: (stored: AdminBookableService) => void;
  /** The catalog name of a key, or the key itself when the catalog has no row for it. */
  readonly labelOf: (key: string) => string;
}

const AdminServiceCatalogContext = createContext<AdminServiceCatalogValue | null>(null);

export function useAdminServiceCatalog(): AdminServiceCatalogValue {
  const value = useContext(AdminServiceCatalogContext);
  if (value === null) {
    throw new Error("useAdminServiceCatalog must be used inside <AdminServiceCatalogProvider>.");
  }
  return value;
}

/**
 * The label lookup alone, tolerant of a missing provider: a component
 * rendered outside the protected layout (a preview, a story) shows keys.
 */
export function useServiceLabel(): (key: string) => string {
  const value = useContext(AdminServiceCatalogContext);
  return value?.labelOf ?? ((key: string) => key);
}

export function AdminServiceCatalogProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { api, markExpired } = useAdminSession();
  const [status, setStatus] = useState<AdminServiceCatalogStatus>("loading");
  const [services, setServices] = useState<AdminBookableService[]>([]);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Applies one catalog read's outcome; every setState here follows a response. */
  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof api.listServices>>) => {
      if (!mountedRef.current) return;
      if (!result.ok) {
        if (result.failure.kind === "unauthenticated") {
          markExpired();
          return;
        }
        setFailure(result.failure);
        setStatus("error");
        return;
      }
      setServices(result.value);
      setFailure(null);
      setStatus("ready");
    },
    [markExpired],
  );

  const reload = useCallback(async () => {
    setStatus("loading");
    applyResult(await api.listServices());
  }, [api, applyResult]);

  useEffect(() => {
    // The initial state is already "loading": the mount read only ever sets
    // state from inside the response callback.
    let active = true;
    void api.listServices().then((result) => {
      if (active) applyResult(result);
    });
    return () => {
      active = false;
    };
  }, [api, applyResult]);

  const adopt = useCallback((stored: AdminBookableService) => {
    setServices((current) => adoptStoredService(current, stored));
  }, []);

  const value = useMemo<AdminServiceCatalogValue>(() => {
    const labels = new Map(services.map((service) => [service.key, service.label]));
    return {
      status,
      services,
      failure,
      reload,
      adopt,
      labelOf: (key: string) => labels.get(key) ?? key,
    };
  }, [status, services, failure, reload, adopt]);

  return (
    <AdminServiceCatalogContext.Provider value={value}>
      {children}
    </AdminServiceCatalogContext.Provider>
  );
}
