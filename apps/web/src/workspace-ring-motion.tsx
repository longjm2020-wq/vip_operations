import { useEffect, useState } from "react";
import "./workspace-ring-motion.css";

type RingMotionPreference = "system" | "enabled" | "disabled";
function readPreference(key: string): RingMotionPreference {
  try {
    const value = localStorage.getItem(key);
    return value === "enabled" || value === "disabled" ? value : "system";
  } catch {
    return "system";
  }
}

/** A local, account-scoped opt-in changes only the workspace's decorative rings. */
export function useWorkspaceRingMotion(userId: string | number) {
  const key = `xuti-workspace-ring-motion:${userId}`;
  const [saved, setSaved] = useState(() => ({
    key,
    value: readPreference(key),
  }));
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const preference = saved.key === key ? saved.value : readPreference(key);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null)
        setSaved({ key, value: readPreference(key) });
    };
    change();
    media.addEventListener("change", change);
    window.addEventListener("storage", storage);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("storage", storage);
    };
  }, [key]);
  const select = (value: RingMotionPreference) => {
    setSaved({ key, value });
    try {
      if (value === "system") localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* The current page still follows the explicit choice. */
    }
  };
  return {
    preference,
    select,
    enabled: preference === "enabled" || (preference === "system" && !reduced),
  };
}

export function WorkspaceRingMotionControl({
  motion,
}: {
  motion: ReturnType<typeof useWorkspaceRingMotion>;
}) {
  return (
    <label
      className="workspace-ring-motion-control"
      title="只调整工作台圆环与分支流光；跟随系统会尊重减少动态效果设置"
    >
      <span>圆环动效</span>
      <select
        aria-label="圆环动效"
        value={motion.preference}
        onChange={(event) =>
          motion.select(event.target.value as RingMotionPreference)
        }
      >
        <option value="system">跟随系统</option>
        <option value="enabled">开启</option>
        <option value="disabled">关闭</option>
      </select>
    </label>
  );
}
