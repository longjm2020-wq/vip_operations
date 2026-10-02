import type { CSSProperties } from "react";

export function WorkspaceMenuIcon({
  workspace,
  selected,
  className = "",
  style,
}: {
  workspace: string;
  selected: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  let shape;
  switch (workspace) {
    case "/operations":
      shape = selected ? (
        <path
          fillRule="evenodd"
          d="M6 2.5h12a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2ZM7 6v2h2V6H7Zm4 0v2h6V6h-6Zm-4 5v2h2v-2H7Zm4 0v2h6v-2h-6Zm-4 5v2h2v-2H7Zm4 0v2h6v-2h-6Z"
        />
      ) : (
        <>
          <rect x="4" y="2.5" width="16" height="19" rx="2" />
          <path d="M7 7h1m3 0h6M7 12h1m3 0h6M7 17h1m3 0h6" />
        </>
      );
      break;
    case "/erp":
      shape = (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </>
      );
      break;
    case "/settings":
      shape = selected ? (
        <path
          fillRule="evenodd"
          d="m9.5 2 .6 2.3a8 8 0 0 1 3.8 0l.6-2.3 3.8 2.2-1.7 1.7a8 8 0 0 1 1.9 3.3l2.5-.6v4.8l-2.5-.6a8 8 0 0 1-1.9 3.3l1.7 1.7-3.8 2.2-.6-2.3a8 8 0 0 1-3.8 0l-.6 2.3-3.8-2.2 1.7-1.7a8 8 0 0 1-1.9-3.3l-2.5.6V8.6l2.5.6a8 8 0 0 1 1.9-3.3L5.7 4.2 9.5 2ZM12 7.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
        />
      ) : (
        <>
          <path d="m9.5 2 .6 2.3a8 8 0 0 1 3.8 0l.6-2.3 3.8 2.2-1.7 1.7a8 8 0 0 1 1.9 3.3l2.5-.6v4.8l-2.5-.6a8 8 0 0 1-1.9 3.3l1.7 1.7-3.8 2.2-.6-2.3a8 8 0 0 1-3.8 0l-.6 2.3-3.8-2.2 1.7-1.7a8 8 0 0 1-1.9-3.3l-2.5.6V8.6l2.5.6a8 8 0 0 1 1.9-3.3L5.7 4.2 9.5 2Z" />
          <circle cx="12" cy="11" r="3.5" />
        </>
      );
      break;
    default:
      shape = selected ? (
        <>
          <circle cx="17" cy="7.5" r="2.5" />
          <path d="M18 12.5c2.5.6 3.5 2.5 3.5 5.5v2h-4v-2c0-2-.5-3.7-1.5-5Z" />
          <circle cx="9" cy="7" r="3" />
          <path d="M2.5 20v-2a6.5 6.5 0 0 1 13 0v2Z" />
        </>
      ) : (
        <>
          <circle cx="9" cy="7" r="3" />
          <path d="M2.5 20v-2a6.5 6.5 0 0 1 13 0v2Z" />
          <path d="M17 4.5a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3.5 5v2" />
        </>
      );
  }
  return (
    <span
      className={`workspace-menu-icon ${className}`}
      style={style}
      aria-hidden="true"
      data-selected={selected}
    >
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        focusable="false"
        fill={selected ? "currentColor" : "none"}
        stroke={selected ? "none" : "currentColor"}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g transform={workspace === "/settings" ? "translate(0 1)" : undefined}>
          {shape}
        </g>
      </svg>
    </span>
  );
}
