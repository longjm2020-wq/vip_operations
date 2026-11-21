import type { AgentFile } from "../../../packages/contracts/src/assistant-agent";

export const maxAgentArtifactPreviewBytes = 512 * 1024;

type AgentArtifactAnalysis = {
  kind: "html" | "svg" | "text";
  code: string;
};

const previewMimes = new Set(["text/html", "image/svg+xml", "text/plain"]);

function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function canPreviewAgentArtifact(file: AgentFile): boolean {
  if (!(file.size > 0 && file.size <= maxAgentArtifactPreviewBytes))
    return false;

  const mime = baseMime(file.mime);
  return (
    previewMimes.has(mime) ||
    (mime === "application/octet-stream" &&
      /\.(?:html?|svg|txt)$/i.test(file.name))
  );
}

function markupKind(
  code: string,
  allowHtmlFragment = false,
): "html" | "svg" | undefined {
  const start = code
    .trimStart()
    .replace(/^(?:\s*(?:<\?xml\b[^?]*\?>|<!--[\s\S]*?-->))+/i, "")
    .trimStart();
  if (/^<svg[\s/>]/i.test(start)) return "svg";
  if (/^<!doctype\s+html[\s>]/i.test(start)) return "html";
  if (
    /^<html[\s>]/i.test(start) &&
    /<(?:head|body)[\s>]|<\/html\s*>/i.test(start)
  )
    return "html";
  const leadingTag = allowHtmlFragment
    ? /^<([a-z][a-z0-9]*)[\s/>]/i.exec(start)?.[1].toLowerCase()
    : undefined;
  if (
    leadingTag &&
    (htmlTags.has(leadingTag) || ["html", "head", "body"].includes(leadingTag))
  )
    return "html";
}

export function analyzeAgentArtifact(
  source: string,
  mime = "",
): AgentArtifactAnalysis {
  const kind = markupKind(source, baseMime(mime) === "text/html");
  if (kind) return { kind, code: source };

  // Legacy document jobs prepend the section heading to generated source.
  const documentStart = source.search(
    /(?:^|\n)[\t ]*(?:<!doctype\s+html\b|<html[\s>]|<svg[\s>])/i,
  );
  const documentSource =
    documentStart < 0 ? "" : source.slice(documentStart).trim();
  const documentKind = markupKind(documentSource);
  if (
    documentKind &&
    (documentKind === "svg" ? /<\/svg\s*>$/i : /<\/html\s*>$/i).test(
      documentSource,
    )
  )
    return { kind: documentKind, code: documentSource };

  const lines = source.split(/\r?\n/);
  const fencePattern = /^[\t ]*(```|~~~)[\t ]*(html?|svg)[\t ]*$/i;
  const opening = lines.findIndex((line) => fencePattern.test(line));
  if (opening >= 0) {
    const [, fence, language] = lines[opening].match(fencePattern)!;
    const closing = lines.findIndex(
      (line, i) => i > opening && line.trim() === fence,
    );
    if (closing > opening) {
      const code = lines.slice(opening + 1, closing).join("\n");
      const kind = markupKind(code, /^html?$/i.test(language));
      if (kind) return { kind, code };
    }
  }

  return { kind: "text", code: source };
}

const htmlNamespace = "http://www.w3.org/1999/xhtml";
const svgNamespace = "http://www.w3.org/2000/svg";
const htmlTags = new Set(
  (
    "a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup " +
    "dd del details dfn dialog div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 " +
    "header hgroup hr i img input ins kbd label legend li main mark meter nav ol optgroup option " +
    "p picture pre progress q rp rt ruby s samp section select small span strong style sub summary sup " +
    "table tbody td textarea tfoot th thead time tr u ul var wbr"
  ).split(" "),
);
const svgTags = new Set(
  (
    "a animate animatemotion animatetransform circle clippath defs desc ellipse feblend fecolormatrix " +
    "fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap fedistantlight " +
    "fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage femerge femergenode " +
    "femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence filter g image " +
    "line lineargradient marker mask mpath path pattern polygon polyline radialgradient rect set stop style " +
    "svg switch symbol text textpath title tspan use view"
  ).split(" "),
);
const htmlAttributes = new Set(
  (
    "alt checked class cols colspan datetime dir disabled for height hidden id lang max maxlength min minlength " +
    "multiple name open placeholder readonly role rows rowspan scope selected start step style tabindex title type value width"
  ).split(" "),
);
const wrapperAttributes = ["class", "dir", "id", "lang", "style", "title"];
const svgReferenceTags = new Set(
  "animate animatemotion animatetransform feimage image lineargradient mpath pattern radialgradient set textpath use".split(
    " ",
  ),
);
const svgAnimatedAttributes = new Set(
  (
    "alignment-baseline color cx cy d dx dy display fill fill-opacity font-size fx fy gradienttransform height " +
    "marker-height marker-width offset opacity pathlength points r rotate rx ry scale stop-color stop-opacity " +
    "stroke stroke-dasharray stroke-dashoffset stroke-opacity stroke-width text-anchor transform viewbox visibility " +
    "width x x1 x2 y y1 y2"
  ).split(" "),
);
const svgBlockedAttributes = new Set(
  "action autofocus background download formaction is nonce ping poster src srcdoc srcset target xml:base".split(
    " ",
  ),
);
const localFragment = /^#[^\s"'<>#]+$/;
const embeddedImage =
  /^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp)(?:;[^,]*)?,/i;

function allowedAttribute(
  element: Element,
  tag: string,
  attribute: Attr,
): boolean {
  const name = attribute.name.toLowerCase();
  if (name.startsWith("on")) return false;
  if (element.namespaceURI === htmlNamespace) {
    if (name === "src")
      return tag === "img" && embeddedImage.test(attribute.value);
    if (
      name === "type" &&
      tag === "input" &&
      attribute.value.toLowerCase() === "file"
    )
      return false;
    return (
      htmlAttributes.has(name) ||
      name.startsWith("aria-") ||
      name.startsWith("data-")
    );
  }

  if (name === "href" || name === "xlink:href")
    return (
      svgReferenceTags.has(tag) &&
      (localFragment.test(attribute.value) ||
        (["feimage", "image"].includes(tag) &&
          embeddedImage.test(attribute.value)))
    );
  return !svgBlockedAttributes.has(name);
}

function sanitizeMarkup(template: HTMLTemplateElement): void {
  for (const element of template.content.querySelectorAll("*")) {
    const tag = element.localName.toLowerCase();
    const namespace = element.namespaceURI;
    const tags = namespace === htmlNamespace ? htmlTags : svgTags;
    if (
      (namespace !== htmlNamespace && namespace !== svgNamespace) ||
      !tags.has(tag)
    ) {
      element.remove();
      continue;
    }

    if (
      namespace === svgNamespace &&
      (tag.startsWith("animate") || tag === "set")
    ) {
      const attribute = element.getAttribute("attributeName")?.toLowerCase();
      if (
        tag === "animatemotion"
          ? attribute !== undefined
          : tag === "animatetransform"
            ? attribute !== "transform"
            : !attribute || !svgAnimatedAttributes.has(attribute)
      ) {
        element.remove();
        continue;
      }
    }

    for (const attribute of Array.from(element.attributes)) {
      if (!allowedAttribute(element, tag, attribute))
        element.removeAttributeNode(attribute);
    }
  }
}

function retainWrapperAttributes(
  template: HTMLTemplateElement,
  code: string,
  wrapper: HTMLElement,
): void {
  const name = wrapper.localName;
  const start = code.match(
    new RegExp(`<${name}(?=\\s|>)((?:[^"'><]|"[^"]*"|'[^']*')*)>`, "i"),
  );
  if (!start?.[1]) return;
  template.innerHTML = `<div${start[1]}></div>`;
  const parsed = template.content.firstElementChild;
  for (const attribute of wrapperAttributes) {
    const value = parsed?.getAttribute(attribute);
    if (value != null) wrapper.setAttribute(attribute, value);
  }
}

// The caller loads this document in an iframe sandbox without allow-scripts.
export function agentArtifactFrameHtml(
  analysis: AgentArtifactAnalysis,
): string {
  if (analysis.kind === "text") return "";

  const template = document.createElement("template");
  template.innerHTML = analysis.code;
  sanitizeMarkup(template);

  // Assemble the output in the template's inert document as well.
  const inertDocument = template.content.ownerDocument;
  const html = inertDocument.createElement("html");
  const head = inertDocument.createElement("head");
  const body = inertDocument.createElement("body");
  head.innerHTML =
    '<meta charset="utf-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">" +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    (analysis.kind === "svg"
      ? "<style>body > svg:only-child { max-width: 100%; height: auto }</style>"
      : "");
  body.append(template.content);
  if (analysis.kind === "html") {
    retainWrapperAttributes(template, analysis.code, html);
    retainWrapperAttributes(template, analysis.code, body);
  }
  html.append(head, body);
  return `<!doctype html>${html.outerHTML}`;
}
