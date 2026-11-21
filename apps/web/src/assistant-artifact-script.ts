import {
  artifactScriptLimits,
  isArtifactScriptAttribute,
  type ArtifactScriptRequest,
  type ArtifactScriptResponse,
  type ArtifactScriptSnapshot,
} from "./assistant-artifact-script-protocol";

const controlEvents = ["click", "input", "change"] as const;

function controlValue(element: Element): string | undefined {
  if (
    element.localName === "input" &&
    ["password", "file"].includes((element as HTMLInputElement).type)
  )
    return;
  if (["input", "select", "textarea"].includes(element.localName))
    return (element as HTMLInputElement).value.slice(
      0,
      artifactScriptLimits.valueLength,
    );
}

function bridgeElements(document: Document) {
  const elements = new Map<string, Element>();
  for (const element of Document.prototype.querySelectorAll.call(
    document,
    "[id]",
  )) {
    if (
      element.id &&
      element.id.length <= artifactScriptLimits.maxIdLength &&
      !["style", "template"].includes(element.localName) &&
      !elements.has(element.id)
    ) {
      elements.set(element.id, element);
      if (elements.size > artifactScriptLimits.elementCount) return;
    }
  }
  return elements;
}

function elementSnapshots(elements: Map<string, Element>) {
  const snapshots: Record<string, ArtifactScriptSnapshot> = Object.create(null);
  let length = 0;
  for (const [id, element] of elements) {
    const snapshot: ArtifactScriptSnapshot = {
      attributes: Object.fromEntries(
        Array.from(element.attributes, (attribute) => [
          attribute.name,
          attribute.value.slice(0, artifactScriptLimits.valueLength),
        ]),
      ),
      text:
        element.textContent?.slice(0, artifactScriptLimits.valueLength) ?? "",
      value: controlValue(element),
    };
    length += JSON.stringify([id, snapshot]).length;
    if (length > artifactScriptLimits.snapshotLength) return;
    snapshots[id] = snapshot;
  }
  return snapshots;
}

export function startArtifactScript(
  document: Document,
  scripts: string[],
  setState: (state: "ready" | "error") => void,
) {
  const elements = bridgeElements(document);
  const snapshots = elements && elementSnapshots(elements);
  if (!elements || !snapshots) {
    setState("error");
    return;
  }

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("./assistant-artifact-script.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    setState("error");
    return;
  }

  const post = (message: ArtifactScriptRequest) => worker.postMessage(message);
  const onControl = (event: Event) => {
    const target = event.target as Node | null;
    if (target?.nodeType !== Node.ELEMENT_NODE) return;
    const element = (target as Element).closest("[id]");
    if (!element || elements.get(element.id) !== element) return;
    post({
      type: "event",
      id: element.id,
      name: event.type as (typeof controlEvents)[number],
      value: controlValue(element),
    });
  };
  const onVisibility = () =>
    post({ type: "event", name: "visibilitychange", hidden: document.hidden });

  const stop = () => {
    window.clearTimeout(startupTimeout);
    worker.terminate();
    for (const event of controlEvents)
      document.removeEventListener(event, onControl, true);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const fail = () => {
    stop();
    setState("error");
  };
  const startupTimeout = window.setTimeout(fail, 8_000);
  worker.onerror = (event) => {
    event.preventDefault();
    fail();
  };
  worker.onmessageerror = fail;
  worker.onmessage = ({ data }: MessageEvent<ArtifactScriptResponse>) => {
    if (data.type === "ready") {
      window.clearTimeout(startupTimeout);
      setState("ready");
      return;
    }
    if (data.type === "error") {
      fail();
      return;
    }
    for (const change of data.changes) {
      const element = elements.get(change.id);
      if (!element?.isConnected) continue;
      if ("text" in change) {
        if (change.text.length <= artifactScriptLimits.valueLength)
          element.textContent = change.text;
      } else if (
        isArtifactScriptAttribute(change.attribute) &&
        change.value.length <= artifactScriptLimits.valueLength
      ) {
        element.setAttribute(change.attribute, change.value);
      }
    }
  };
  for (const event of controlEvents)
    document.addEventListener(event, onControl, true);
  document.addEventListener("visibilitychange", onVisibility);

  post({
    type: "init",
    scripts,
    elements: snapshots,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches,
    hidden: document.hidden,
  });
  return stop;
}
