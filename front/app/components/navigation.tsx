"use client";

import type { NavigationContent } from "../types/site-content";
import { MobileNav } from "./mobile-nav";

interface NavigationProps {
  content: NavigationContent;
}

export function Navigation({ content }: NavigationProps) {
  return (
    <nav className="site-section-navigation fixed top-4 left-4 right-4 z-40 mx-auto max-w-6xl">
      <div className="glass-card bg-white/50 backdrop-blur-2xl border border-white/60 rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_4px_24px_rgba(0,0,0,0.05)] px-4 md:px-6 h-14 flex items-center justify-between">
        <a
          href="#"
          className="font-display text-lg md:text-xl tracking-tight text-warm-800">
          {content.brandLabel}
        </a>
        <div className="hidden md:flex items-center gap-8">
          {content.links.map((link, index) => (
            <a
              key={link.id}
              href={link.href}
              className={
                index === content.links.length - 1
                  ? "text-sm font-medium px-5 py-2 bg-warm-800 text-porcelain rounded-full hover:bg-warm-700 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(44,43,40,0.2)]"
                  : "text-sm text-warm-500 hover:text-warm-800 transition-colors duration-300"
              }>
              {link.label}
            </a>
          ))}
        </div>
        <MobileNav content={content} />
      </div>
    </nav>
  );
}
