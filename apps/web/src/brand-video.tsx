import { useEffect, useRef, useState } from "react";

export function BrandVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const small = window.matchMedia("(max-width: 850px)");
    if (!reduced.matches && !small.matches) setEnabled(true);
  }, []);
  useEffect(() => {
    if (enabled) void ref.current?.play().catch(() => setPlaying(false));
  }, [enabled]);
  return <div className="brand-video">
    <video ref={ref} src={enabled ? "/brand/brand.mp4" : undefined}
      poster="/brand/poster.jpg" muted loop playsInline preload="metadata"
      aria-hidden="true" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onError={() => setPlaying(false)} />
    <div className="brand-video-shade" />
    <button type="button" className="brand-video-toggle" onClick={() => {
      if (!enabled) setEnabled(true);
      else if (playing) ref.current?.pause();
      else void ref.current?.play().catch(() => setPlaying(false));
    }}>{playing ? "暂停背景" : "播放背景"}</button>
  </div>;
}
