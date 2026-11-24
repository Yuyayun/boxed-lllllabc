import { buildChatIdentity } from "./identity.js";

export function createContextReader({ getContext }) {
  return {
    readRawContext() {
      try {
        const context = getContext();
        return context && typeof context === "object" ? context : {};
      } catch (error) {
        return {
          __boxedLllllabcError: error,
        };
      }
    },

    readCurrentChat() {
      const context = this.readRawContext();
      if (context.__boxedLllllabcError) {
        return {
          ok: false,
          reason: "无法读取 SillyTavern 上下文。",
          error: context.__boxedLllllabcError,
          context,
        };
      }

      if (!Array.isArray(context.chat)) {
        return {
          ok: false,
          reason: "当前聊天内容尚未就绪。",
          context,
        };
      }
      const chat = context.chat;

      const identity = buildChatIdentity(context);
      if (!identity.ok) {
        return {
          ok: false,
          reason: identity.reason,
          context,
          identity,
        };
      }

      return {
        ok: true,
        context,
        chat,
        identity,
      };
    },
  };
}
