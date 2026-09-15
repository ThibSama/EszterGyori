"use client";

import { useRef, useEffect, type CSSProperties, type ReactNode } from "react";

/**
 * The one scroll-reveal treatment of the public landing (Package 10.4).
 *
 * The element is rendered visible and stays visible unless this effect stages
 * it: only content that starts below the first viewport receives
 * `data-reveal="hidden"`, and an IntersectionObserver flips it to `"visible"`
 * once, after which it is never observed again. The motion itself lives in
 * `globals.css` (`.site-preview [data-reveal]`), where the default styling of
 * every revealed element *is* its final state — so with no JavaScript, with
 * `disabled`, or under `prefers-reduced-motion` nothing is ever hidden.
 *
 * `delay` becomes `--reveal-delay`, which the stylesheet reads as the
 * transition delay; it is how sibling cards stagger by a few tens of ms.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    // Anything already on screen stays as painted; staging it would flash.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.85) return;

    el.dataset.reveal = "hidden";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.dataset.reveal = "visible";
        observer.disconnect();
      },
      { threshold: 0.08, rootMargin: "0px 0px -5% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [disabled]);

  return (
    <div
      ref={ref}
      className={className}
      style={
        delay > 0
          ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties)
          : undefined
      }>
      {children}
    </div>
  );
}
