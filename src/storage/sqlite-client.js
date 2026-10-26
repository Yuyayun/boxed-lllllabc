import { STORAGE_PROTOCOL, STORAGE_OPERATIONS, encodeStorageValue, decodeStorageValue } from "./protocol.js";

export function createSqliteStorage({ fetchImpl = globalThis.fetch, getRequestHeaders = () => ({}), timeoutMs = 15000 } = {}) {
  const base = "/api/plugins/boxed-lllllabc";
  async function request(route, body, signal) {
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    if (signal?.aborted) timeout.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(`${base}/${route}`, {
        method: body ? "POST" : "GET", credentials: "same-origin", signal: timeout.signal,
        headers: { ...getRequestHeaders(), "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404) return { ok: false, code: "unavailable", reason: "SQLite 插件未安装、未启用或不可连接。" };
      let data;
      try { data = await response.json(); }
      catch {
        throw Object.assign(new Error(response.status === 403
          ? "酒馆拒绝了 SQLite 请求，请检查登录状态与 CSRF 保护。"
          : "SQLite 插件未返回兼容的协议响应，请检查安装及版本。"), { code: response.status === 403 ? "permission-denied" : "unavailable" });
      }
      if (data.protocol !== STORAGE_PROTOCOL) throw Object.assign(new Error("SQLite 插件协议不兼容，请检查前后端版本。"), { code: "protocol-incompatible" });
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.reason || "SQLite 操作失败。"), { code: data.code || "database-error" });
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async function status() {
    try { return await request("status"); }
    catch (error) { return { ok: false, code: error.code || "unavailable", reason: error.message }; }
  }
  return Object.freeze({
    mode: "sqlite", status,
    async checkCapacity(manifest) {
      const health = await status();
      if (!health.ok) throw new Error(health.reason);
      const free = health.database?.availableBytes;
      if (Number.isFinite(free) && free < manifest.bytes * 2 + health.database.bytes) throw new Error("服务器可用空间不足以保留暂存和回滚副本，未替换目标数据。");
    },
    async transfer(action, args) {
      const result = await request("transfer", { protocol: STORAGE_PROTOCOL, action, args: encodeStorageValue(args) });
      if (!result.ok) throw Object.assign(new Error(result.reason), { code: result.code });
      return decodeStorageValue(result.value);
    },
    async open() {
      const health = await status();
      if (!health.ok) throw Object.assign(new Error(health.reason), { code: health.code });
      let closed = false;
      const session = { close() { closed = true; } };
      for (const operation of STORAGE_OPERATIONS) {
        session[operation] = async (...args) => {
          if (closed) throw new Error("存储会话已经关闭。");
          let signal;
          if (operation === "deletePendingChangesIfUnchanged") {
            const options = args[1] ?? {};
            if (options.shouldDelete && !options.shouldDelete()) return [];
            signal = options.signal;
            if (options.shouldDelete && !signal) throw new Error("SQLite 条件删除缺少取消信号，已保留 pending。");
            args = [args[0]];
          }
          const result = await request("operation", { protocol: STORAGE_PROTOCOL, operation, args: encodeStorageValue(args) }, signal);
          if (!result.ok) throw Object.assign(new Error(result.reason), { code: result.code });
          return decodeStorageValue(result.value);
        };
      }
      return Object.freeze(session);
    },
  });
}
