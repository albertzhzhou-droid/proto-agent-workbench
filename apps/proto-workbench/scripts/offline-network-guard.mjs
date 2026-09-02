import dns from "node:dns";
import net from "node:net";

const originalSocketConnect = net.Socket.prototype.connect;
const originalLookup = dns.lookup;

function normalizedHost(options) {
  if (typeof options === "string") return options;
  if (Array.isArray(options)) {
    const [first, second] = options;
    // Socket.connect(path[, listener]) is local IPC (a Unix socket or Windows
    // named pipe), not a TCP hostname.
    if (typeof first === "string") return "";
    // Socket.connect(port[, host][, listener]) keeps the host in the second
    // positional argument. A missing host uses Node's loopback default.
    if (typeof first === "number") return typeof second === "string" ? second : "localhost";
    return normalizedHost(first);
  }
  if (!options || typeof options !== "object") return "";
  return String(options.host ?? options.hostname ?? "");
}

function isLoopback(host) {
  const value = String(host).trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = normalizedHost(args);
  if (host && !isLoopback(host)) {
    throw new Error("OFFLINE_VERIFICATION_EXTERNAL_NETWORK_BLOCKED");
  }
  return originalSocketConnect.apply(this, args);
};

dns.lookup = function guardedLookup(hostname, ...args) {
  if (!isLoopback(hostname)) {
    const callback = args.findLast((value) => typeof value === "function");
    const error = Object.assign(new Error("OFFLINE_VERIFICATION_EXTERNAL_DNS_BLOCKED"), { code: "ENETUNREACH" });
    if (callback) {
      queueMicrotask(() => callback(error));
      return;
    }
    throw error;
  }
  return originalLookup.call(this, hostname, ...args);
};
