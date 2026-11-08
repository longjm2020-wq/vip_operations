/** Embedded ERP supplies accounting; standalone engine tests keep native fetch. */
export function modelFetch(config, feature, url, options) {
  return config.aiFetch ? config.aiFetch(feature, url, options) : fetch(url, options);
}
export async function modelReceipt(config, feature, url, model, payload) {
  // Accounting must not discard a paid result when the database is unavailable.
  await config.recordAiReceipt?.(feature, new URL(url).hostname, model, payload).catch(() => {});
}
export function inferenceFetch(config, feature, isInference) {
  return (url, options) => isInference(new URL(url).pathname, options)
    ? modelFetch(config, feature, url, options) : fetch(url, options);
}
