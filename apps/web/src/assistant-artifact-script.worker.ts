import releaseSync from "@jitl/quickjs-singlefile-browser-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import {
  artifactScriptAttributes,
  artifactScriptLimits as limits,
  isArtifactScriptAttribute,
  type ArtifactScriptChange,
  type ArtifactScriptRequest,
  type ArtifactScriptResponse,
} from "./assistant-artifact-script-protocol";

// Only primitive snapshots and vetted mutations cross the VM boundary.
// Browser objects, capabilities and host callbacks are never installed in it.
const bootstrap = String.raw`
(() => {
  const allowedAttributes = new Set(${JSON.stringify(artifactScriptAttributes)});
  const elements = new Map();
  const changes = new Map();
  let updateLength = 0;
  let hidden = false;
  let reducedMotion = false;
  let readyState = "loading";
  let nextFrame = 0;
  const frames = new Map();
  const parse = JSON.parse;
  const stringify = JSON.stringify;

  function eventTarget(target, allowedEvents) {
    const listeners = new Map(allowedEvents.map((name) => [name, new Map()]));
    function addEventListener(name, callback, options) {
      const group = listeners.get(name);
      if (!group || typeof callback !== "function" || group.has(callback)) return;
      if (group.size >= 32) throw RangeError("Too many preview event listeners");
      group.set(callback, Boolean(options?.once));
    }
    function removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
    }
    Object.assign(target, { addEventListener, removeEventListener });
    return (name) => {
      const group = listeners.get(name);
      if (!group) return;
      const event = Object.freeze({
        type: name, target, currentTarget: target,
        preventDefault() {}, stopPropagation() {},
      });
      for (const [callback, once] of [...group]) {
        if (!group.has(callback)) continue;
        if (once) group.delete(callback);
        callback.call(target, event);
      }
    };
  }

  function enqueue(id, attribute, value) {
    const key = stringify([id, attribute]);
    const previous = changes.get(key);
    updateLength += value.length + (previous ? -previous.value.length : key.length);
    if (updateLength > ${limits.updateLength / 2} ||
        (!previous && changes.size >= ${limits.changeCount})) {
      throw RangeError("Preview output exceeds its limit");
    }
    changes.set(key, { id, attribute, value });
  }

  function limitedString(value) {
    const result = String(value);
    if (result.length > ${limits.valueLength}) throw RangeError("Preview value is too long");
    return result;
  }

  function element(id, initial) {
    const attributes = new Map(Object.entries(initial.attributes));
    let text = initial.text;
    let value = initial.value ?? "";
    const target = {
      id,
      get textContent() { return text; },
      set textContent(next) {
        next = limitedString(next ?? "");
        if (next === text) return;
        text = next;
        enqueue(id, null, next);
      },
      get value() { return value; },
      set value(next) { value = limitedString(next); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      setAttribute(name, next) {
        name = String(name);
        if (!allowedAttributes.has(name)) return;
        next = limitedString(next);
        if (attributes.get(name) === next) return;
        attributes.set(name, next);
        enqueue(id, name, next);
      },
    };
    const fire = eventTarget(target, ["click", "input", "change"]);
    return { target, fire, setValue(next) { value = next; } };
  }

  function getElementById(id) {
    return elements.get(String(id))?.target ?? null;
  }
  const document = {
    getElementById,
    querySelector(selector) {
      return typeof selector === "string" && /^#[\w-]+$/.test(selector)
        ? getElementById(selector.slice(1)) : null;
    },
    get hidden() { return hidden; },
    get visibilityState() { return hidden ? "hidden" : "visible"; },
    get readyState() { return readyState; },
  };
  const documentEvent = eventTarget(document, ["DOMContentLoaded", "visibilitychange"]);
  const windowEvent = eventTarget(globalThis, ["DOMContentLoaded", "load"]);
  Object.assign(globalThis, {
    window: globalThis, self: globalThis, document,
    matchMedia(query) {
      const media = String(query);
      const preference = /^\s*\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)\s*$/i.exec(media);
      const matches = Boolean(preference && ((preference[1].toLowerCase() === "reduce") === reducedMotion));
      return Object.freeze({ media, matches, addEventListener() {}, removeEventListener() {} });
    },
    requestAnimationFrame(callback) {
      if (typeof callback !== "function") throw TypeError("Animation callback must be a function");
      if (frames.size >= 32) throw RangeError("Too many preview animation callbacks");
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  });

  return {
    setup(json) {
      const snapshot = parse(json);
      hidden = snapshot.hidden;
      reducedMotion = snapshot.reducedMotion;
      for (const [id, initial] of Object.entries(snapshot.elements)) {
        elements.set(id, element(id, initial));
      }
    },
    load() {
      readyState = "interactive";
      documentEvent("DOMContentLoaded");
      windowEvent("DOMContentLoaded");
      readyState = "complete";
      windowEvent("load");
    },
    event(json) {
      const event = parse(json);
      if (event.name === "visibilitychange") {
        hidden = event.hidden;
        documentEvent(event.name);
        return;
      }
      const item = elements.get(event.id);
      if (!item) return;
      if (event.value !== undefined) item.setValue(event.value);
      item.fire(event.name);
    },
    tick(now) {
      const ids = [...frames.keys()];
      for (const id of ids) {
        const callback = frames.get(id);
        frames.delete(id);
        if (callback) callback(now);
      }
    },
    flush() {
      const output = {
        needsFrame: frames.size > 0,
        changes: [...changes.values()].map(({ id, attribute, value }) =>
          attribute === null ? { id, text: value } : { id, attribute, value }),
      };
      changes.clear();
      updateLength = 0;
      return stringify(output);
    },
  };
})()
`;

let vm:
  | {
      runtime: QuickJSRuntime;
      context: QuickJSContext;
      bridge: QuickJSHandle;
    }
  | undefined;
let initialized = false;
let hidden = false;
let frameTimer: ReturnType<typeof setTimeout> | undefined;
let deadline = 0;
let knownIds = new Set<string>();

function post(message: ArtifactScriptResponse) {
  self.postMessage(message);
}

function take(result: ReturnType<QuickJSContext["evalCode"]>) {
  if (result.error) {
    result.error.dispose();
    throw Error("Preview VM execution stopped");
  }
  return result.value;
}

function call(name: string, arg?: string | number) {
  if (!vm) throw Error("Preview VM is unavailable");
  const { context, bridge } = vm;
  const callback = context.getProp(bridge, name);
  const value =
    typeof arg === "string"
      ? context.newString(arg)
      : typeof arg === "number"
        ? context.newNumber(arg)
        : undefined;
  try {
    return take(
      context.callFunction(callback, bridge, ...(value ? [value] : [])),
    );
  } finally {
    value?.dispose();
    callback.dispose();
  }
}

function validChange(change: ArtifactScriptChange) {
  if (!change || !knownIds.has(change.id)) return false;
  return "text" in change
    ? typeof change.text === "string" &&
        change.text.length <= limits.valueLength
    : typeof change.value === "string" &&
        change.value.length <= limits.valueLength &&
        isArtifactScriptAttribute(change.attribute);
}

function publish() {
  if (!vm) throw Error("Preview VM is unavailable");
  const jobs = vm.runtime.executePendingJobs(64);
  if (jobs.error) {
    jobs.error.dispose();
    throw Error("Preview VM promise stopped");
  }
  if (vm.runtime.hasPendingJob()) throw Error("Too many preview microtasks");

  const result = call("flush");
  let source: string;
  try {
    source = vm.context.getString(result);
  } finally {
    result.dispose();
  }
  if (source.length > limits.updateLength)
    throw Error("Preview update is too large");
  const batch = JSON.parse(source) as {
    needsFrame: unknown;
    changes: ArtifactScriptChange[];
  };
  if (
    !Array.isArray(batch.changes) ||
    batch.changes.length > limits.changeCount ||
    !batch.changes.every(validChange)
  )
    throw Error("Invalid preview update");
  if (batch.changes.length) post({ type: "update", changes: batch.changes });
  if (batch.needsFrame === true && !hidden && frameTimer === undefined) {
    frameTimer = setTimeout(() => {
      frameTimer = undefined;
      try {
        deadline = performance.now() + 40;
        call("tick", performance.now()).dispose();
        publish();
      } catch {
        stop();
      }
    }, 16);
  }
}

async function initialize(
  message: Extract<ArtifactScriptRequest, { type: "init" }>,
) {
  const { scripts, elements, reducedMotion, hidden: initiallyHidden } = message;
  const ids = Object.keys(elements);
  if (
    !Array.isArray(scripts) ||
    scripts.length > 32 ||
    scripts.reduce((total, script) => total + script.length, 0) >
      limits.sourceLength ||
    ids.length > limits.elementCount ||
    ids.some((id) => !id || id.length > limits.maxIdLength)
  ) {
    throw Error("Preview input is too large");
  }
  const snapshot = JSON.stringify({
    elements,
    reducedMotion,
    hidden: initiallyHidden,
  });
  if (snapshot.length > limits.snapshotLength)
    throw Error("Preview snapshot is too large");
  knownIds = new Set(ids);
  hidden = initiallyHidden;
  const quickjs = await newQuickJSWASMModuleFromVariant(releaseSync);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(24 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  deadline = performance.now() + 600;
  runtime.setInterruptHandler(() => performance.now() > deadline);
  const context = runtime.newContext();
  const bridge = take(
    context.evalCode(bootstrap, "preview-dom.js", { type: "global" }),
  );
  vm = { runtime, context, bridge };
  call("setup", snapshot).dispose();
  for (const [index, script] of scripts.entries()) {
    take(
      context.evalCode(script, "preview-" + index + ".js", { type: "global" }),
    ).dispose();
  }
  call("load").dispose();
  publish();
  post({ type: "ready" });
}

function stop() {
  clearTimeout(frameTimer);
  post({ type: "error" });
  // Closing the worker also frees a partly-constructed or interrupted VM.
  self.close();
}

self.onmessage = async ({ data }: MessageEvent<ArtifactScriptRequest>) => {
  try {
    if (data.type === "init") {
      if (initialized) return;
      initialized = true;
      await initialize(data);
      return;
    }
    if (
      !vm ||
      (data.id !== undefined && !knownIds.has(data.id)) ||
      (data.value !== undefined && data.value.length > limits.valueLength)
    )
      return;
    if (data.name === "visibilitychange") {
      hidden = Boolean(data.hidden);
      if (hidden) {
        clearTimeout(frameTimer);
        frameTimer = undefined;
      }
    }
    deadline = performance.now() + 60;
    call("event", JSON.stringify(data)).dispose();
    publish();
  } catch {
    stop();
  }
};
