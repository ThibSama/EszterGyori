"use client";

const INSTAGRAM_WEB_URL = "https://www.instagram.com/eg_maquillagepermanent/";
const INSTAGRAM_APP_URL = "instagram://user?username=eg_maquillagepermanent";

function isLikelyMobile() {
  const userAgent = navigator.userAgent || "";
  const mobileUserAgent = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(
    userAgent,
  );
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;

  return mobileUserAgent || (coarsePointer && window.innerWidth < 900);
}

interface HeroInstagramButtonProps {
  ariaLabel: string;
}

export function HeroInstagramButton({ ariaLabel }: HeroInstagramButtonProps) {
  function handleClick() {
    if (!isLikelyMobile()) {
      window.open(INSTAGRAM_WEB_URL, "_blank", "noopener,noreferrer");
      return;
    }

    window.location.href = INSTAGRAM_APP_URL;

    window.setTimeout(() => {
      if (!document.hidden) {
        window.location.href = INSTAGRAM_WEB_URL;
      }
    }, 1000);
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={handleClick}
      className="float-gentle absolute bottom-5 left-5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-white/55 text-warm-700 backdrop-blur-md border border-white/55 shadow-[0_4px_16px_rgba(0,0,0,0.05)] transition-all duration-300 ease-out hover:-translate-y-0.5 hover:bg-white/70 hover:shadow-[0_8px_24px_rgba(0,0,0,0.08)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-500">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
