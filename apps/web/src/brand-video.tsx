import { useEffect, useRef, useState } from "react";

export function BrandVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const small = window.matchMedia("(max-width: 850px)");
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (reduced.matches || small.matches || connection?.saveData) return;
    const timer = window.setTimeout(() => setEnabled(true), 6000);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const update = () => {
      if (document.hidden) ref.current?.pause();
      else if (enabled) void ref.current?.play().catch(() => { /* Keep the poster if autoplay is blocked. */ });
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [enabled]);
  return <div className="brand-video">
    <video ref={ref} src={enabled ? "/brand/brand.mp4" : undefined}
      poster="/brand/poster.jpg" muted loop playsInline preload="metadata"
      aria-hidden="true"
       />
    <div className="brand-video-shade" />

  </div>;
}
