"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { NavigationContent } from "../types/site-content";

interface MobileNavProps {
  content: NavigationContent;
}

export function MobileNav({ content }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  const menuId = "mobile-navigation-menu";

  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstLinkRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function closeAndRestoreFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div className="md:hidden">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        aria-label={open ? content.menuCloseLabel : content.menuOpenLabel}
        aria-expanded={open}
        aria-controls={menuId}
        className="relative z-50 flex flex-col justify-center items-center w-10 h-10 gap-[5px]">
        <span
          className={`block w-5 h-[1.5px] bg-warm-800 transition-all duration-300 origin-center ${
            open ? "rotate-45 translate-y-[6.5px]" : ""
          }`}
        />
        <span
          className={`block w-5 h-[1.5px] bg-warm-800 transition-all duration-300 ${
            open ? "opacity-0 scale-x-0" : ""
          }`}
        />
        <span
          className={`block w-5 h-[1.5px] bg-warm-800 transition-all duration-300 origin-center ${
            open ? "-rotate-45 -translate-y-[6.5px]" : ""
          }`}
        />
      </button>

      {mounted &&
        open &&
        createPortal(
          <>
            <div
              aria-hidden="true"
              className="fixed inset-0 z-30 cursor-default bg-warm-800/20 backdrop-blur-sm"
              onClick={closeAndRestoreFocus}
            />

            <div
              id={menuId}
              className="fixed top-20 left-4 right-4 z-40 transition-all duration-300 opacity-100 translate-y-0 pointer-events-auto">
              <div className="glass-card bg-white/80 backdrop-blur-2xl border border-white/60 rounded-2xl shadow-[0_16px_48px_rgba(0,0,0,0.12)] p-6">
                <nav className="flex flex-col gap-1" aria-label="Navigation mobile">
                  {content.links.map((link, index) =>
                    index === content.links.length - 1 ? (
                      <a
                        key={link.id}
                        ref={index === 0 ? firstLinkRef : undefined}
                        href={link.href}
                        onClick={closeAndRestoreFocus}
                        className="mt-3 text-center text-sm font-medium px-5 py-3 bg-warm-800 text-porcelain rounded-full hover:bg-warm-700 transition-all duration-300">
                        {link.label}
                      </a>
                    ) : (
                      <a
                        key={link.id}
                        ref={index === 0 ? firstLinkRef : undefined}
                        href={link.href}
                        onClick={closeAndRestoreFocus}
                        className="text-base text-warm-600 hover:text-warm-800 transition-colors duration-300 py-3 px-2 rounded-lg hover:bg-white/50">
                        {link.label}
                      </a>
                    ),
                  )}
                </nav>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
