"use client";

import { useState, useEffect } from "react";

const links = [
  { href: "#prestations", label: "Prestations" },
  { href: "#parcours", label: "Parcours" },
  { href: "#realisations", label: "Réalisations" },
  { href: "#a-propos", label: "À propos" },
  { href: "#contact", label: "Prendre contact", cta: true },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(!open)}
        aria-label={open ? "Fermer le menu" : "Ouvrir le menu"}
        aria-expanded={open}
        className="relative z-50 flex flex-col justify-center items-center w-10 h-10 gap-[5px]"
      >
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

      {open && (
        <div
          className="fixed inset-0 z-40 bg-warm-800/20 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      <div
        className={`fixed top-20 left-4 right-4 z-40 transition-all duration-300 ${
          open
            ? "opacity-100 translate-y-0 pointer-events-auto"
            : "opacity-0 -translate-y-4 pointer-events-none"
        }`}
      >
        <div className="glass-card bg-white/80 backdrop-blur-2xl border border-white/60 rounded-2xl shadow-[0_16px_48px_rgba(0,0,0,0.12)] p-6">
          <nav className="flex flex-col gap-1">
            {links.map((link) =>
              link.cta ? (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="mt-3 text-center text-sm font-medium px-5 py-3 bg-warm-800 text-porcelain rounded-full hover:bg-warm-700 transition-all duration-300"
                >
                  {link.label}
                </a>
              ) : (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="text-base text-warm-600 hover:text-warm-800 transition-colors duration-300 py-3 px-2 rounded-lg hover:bg-white/50"
                >
                  {link.label}
                </a>
              ),
            )}
          </nav>
        </div>
      </div>
    </div>
  );
}
