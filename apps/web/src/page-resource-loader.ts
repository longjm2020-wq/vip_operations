import { lazy } from "react";

const moduleFetchFailure =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .+ failed/i;
export function isPageResourceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    moduleFetchFailure.test(message) ||
    /Unable to preload CSS|Loading CSS chunk/i.test(message)
  );
}

/** Retry a transient module fetch once; never replay application code errors or reload a page. */
export async function loadPageResource<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!moduleFetchFailure.test(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 350));
    return load();
  }
}

export const lazyPage: typeof lazy = (load) =>
  lazy(() => loadPageResource(load));
