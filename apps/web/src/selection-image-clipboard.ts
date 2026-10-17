/** Clipboard file items and FileList usually describe the same images. Prefer
 * items, and use FileList only when the browser cannot expose image items. */
export function selectionClipboardImages(clipboard: {
  items?: ArrayLike<Pick<DataTransferItem, "type" | "getAsFile">>;
  files?: ArrayLike<File>;
}): File[] {
  const items = Array.from(clipboard.items || [])
    .filter(item => item.type.startsWith("image/"))
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file);
  return items.length ? items : Array.from(clipboard.files || []).filter(file => file.type.startsWith("image/"));
}

export function selectionTextPasteTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (!!target.closest("input, textarea") || target.isContentEditable);
}
