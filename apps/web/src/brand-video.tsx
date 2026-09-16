import { useEffect, useRef, useState } from "react";

export function BrandVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const small = window.matchMedia("(max-width: 850px)");
    if (!reduced.matches && !small.matches) setEnabled(true);
  }, []);
  useEffect(() => {
    if (enabled) void ref.current?.play().catch(() => { /* Autoplay blocked: keep the poster visible. */ });
  }, [enabled]);
  return <div className="brand-video">
    <video ref={ref} src={enabled ? "/brand/brand.mp4" : undefined}
      poster="/brand/poster.jpg" muted loop playsInline preload="metadata"
      aria-hidden="true"
       />
    <div className="brand-video-shade" />

  </div>;
}
