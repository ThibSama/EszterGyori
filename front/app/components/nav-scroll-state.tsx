"use client";

import { useEffect, useRef } from "react";

/**
 * Marks the enclosing `<nav>` with `data-scrolled="true"` once the page has
 * moved a little from the top (Package 10.4). The navigation itself stays a
 * server component; the stylesheet reads the attribute to densify the glass.
 */
export function NavScrollState() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const nav = ref.current?.closest("nav");
    if (!nav) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      nav.dataset.scrolled = window.scrollY > 24 ? "true" : "false";
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      delete nav.dataset.scrolled;
    };
  }, []);

  return <span ref={ref} hidden />;
}
