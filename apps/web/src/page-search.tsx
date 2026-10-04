import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PageSearchContext = createContext<HTMLElement | null>(null);

// Keep search state and permissions in its page while displaying the control in the shared topbar.
export function PageSearch({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const host = useContext(PageSearchContext);
  if (!active) return null;
  const control = <div className="page-top-search">{children}</div>;
  return host ? createPortal(control, host) : control;
}
