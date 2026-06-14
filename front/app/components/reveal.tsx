"use client";

import { useRef, useEffect, type ReactNode } from "react";

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
    if (!el) return;
    if (disabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.style.opacity = "1";
      el.style.transform = "none";
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.85) {
      el.style.opacity = "0";
      el.style.transform = "translateY(28px)";
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          const d = delay;
          setTimeout(() => {
            el.style.transition =
              "opacity 0.9s cubic-bezier(0.22,1,0.36,1), transform 0.9s cubic-bezier(0.22,1,0.36,1)";
            el.style.opacity = "1";
            el.style.transform = "translateY(0)";
          }, d);
          observer.unobserve(el);
        }
      },
      { threshold: 0.08 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delay, disabled]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
