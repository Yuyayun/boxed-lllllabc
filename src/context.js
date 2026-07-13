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

      const chat = Array.isArray(context.chat) ? context.chat : [];
      if (!chat.length) {
        return {
          ok: false,
          reason: "当前没有可备份的聊天内容。",
          context,
        };
      }

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
