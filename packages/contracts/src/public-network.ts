import { BlockList, isIP } from "node:net";

const blocked4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(address, prefix, "ipv4");
const public6 = new BlockList(), blocked6 = new BlockList();
public6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked6.addSubnet(address, prefix, "ipv6");

export function browserPublicAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  return family === 4 ? !blocked4.check(address, "ipv4")
    : family === 6 && public6.check(address, "ipv6") && !blocked6.check(address, "ipv6");
}

export function publicBrowserUrl(input: string): URL {
  if (input.length > 8192) throw Error("BROWSER_URL_BLOCKED");
  let url: URL;
  try { url = new URL(input); } catch { throw Error("BROWSER_URL_BLOCKED"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
    !host || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid)$/i.test(host) ||
    (isIP(host) && !browserPublicAddress(host))) throw Error("BROWSER_URL_BLOCKED");
  return url;
}
