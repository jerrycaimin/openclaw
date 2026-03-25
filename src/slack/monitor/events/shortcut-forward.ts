import { dispatchInboundMessageWithDispatcher } from "../../../auto-reply/dispatch.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { danger } from "../../../globals.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import type { SlackAttachment, SlackFile } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackAttachmentContent, resolveSlackMedia } from "../media.js";

const MAX_THREAD_MESSAGES = 30;

/**
 * Extract plain text from all attachments (link previews, quoted messages, etc.).
 * Unlike resolveSlackAttachmentContent which only handles forwarded messages,
 * this covers all attachment types present in the shortcut payload.
 */
function extractAttachmentText(attachments: SlackAttachment[]): string {
  const parts: string[] = [];
  for (const att of attachments) {
    const lines: string[] = [];
    if (att.author_name) {
      lines.push(`[来自 ${att.author_name}${att.channel_name ? ` in #${att.channel_name}` : ""}]`);
    } else if (att.channel_name) {
      lines.push(`[来自 #${att.channel_name}]`);
    }
    const body = att.text?.trim() || att.fallback?.trim() || att.pretext?.trim();
    if (body) {
      lines.push(body);
    }
    if (att.from_url) {
      lines.push(`链接：${att.from_url}`);
    }
    if (lines.length > 0) {
      parts.push(lines.join("\n"));
    }
  }
  return parts.join("\n\n");
}

/**
 * Handles the openclaw:forward_message message shortcut.
 *
 * Uses the full message object Slack includes in the shortcut payload (text, files,
 * attachments, thread context), resolves any media, builds a MsgContext that asks
 * the AI to analyse the forwarded content, and delivers the AI reply to the user's DM.
 */
export async function dispatchForwardMessageShortcut(params: {
  ctx: SlackMonitorContext;
  userId: string;
  channelId: string | undefined;
  messageTs: string | undefined;
  threadTs: string | undefined;
  payloadMessage:
    | {
        ts?: string;
        thread_ts?: string;
        text?: string;
        user?: string;
        username?: string;
        files?: SlackFile[];
        attachments?: SlackAttachment[];
        blocks?: unknown[];
      }
    | undefined;
}): Promise<void> {
  const { ctx, userId, channelId, messageTs, threadTs, payloadMessage } = params;

  // --- 1. Use shortcut payload message directly (Slack sends the full message object) ---
  // Fall back to conversations.history only if payload is missing content.
  let messageText = payloadMessage?.text ?? "";
  let files: SlackFile[] = payloadMessage?.files ?? [];
  let attachments: SlackAttachment[] = payloadMessage?.attachments ?? [];

  const payloadHasContent = messageText || files.length > 0 || attachments.length > 0;
  if (!payloadHasContent && channelId && messageTs) {
    try {
      const histResult = await ctx.app.client.conversations.history({
        channel: channelId,
        latest: messageTs,
        oldest: messageTs,
        inclusive: true,
        limit: 1,
        token: ctx.botToken,
      });
      const rawMsg = histResult.messages?.[0] as Record<string, unknown> | undefined;
      if (rawMsg) {
        messageText = typeof rawMsg.text === "string" ? rawMsg.text : "";
        files = Array.isArray(rawMsg.files) ? (rawMsg.files as SlackFile[]) : [];
        attachments = Array.isArray(rawMsg.attachments)
          ? (rawMsg.attachments as SlackAttachment[])
          : [];
      }
    } catch (err) {
      ctx.runtime.log?.(
        `slack:shortcut forward_message history fallback failed: ${String(err)}`,
      );
    }
  }

  // --- 2. Fetch thread context ---
  let threadContextText = "";
  const isThreadReply = threadTs && threadTs !== messageTs;

  if (isThreadReply && channelId) {
    // Case A: forwarded message is a reply — fetch the whole thread (root + siblings)
    try {
      const threadResult = await ctx.app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: MAX_THREAD_MESSAGES,
        token: ctx.botToken,
      });
      const messages = (threadResult.messages ?? []) as Array<Record<string, unknown>>;
      if (messages.length > 0) {
        const formatted = messages
          .map((m) => {
            const sender = typeof m.user === "string" ? `<@${m.user}>` : (typeof m.username === "string" ? m.username : "unknown");
            const body = typeof m.text === "string" ? m.text.trim() : "";
            const marker = m.ts === messageTs ? " ← 转发的消息" : "";
            return body ? `${sender}${marker}: ${body}` : null;
          })
          .filter(Boolean)
          .join("\n");
        if (formatted) {
          threadContextText = `[消息所在 Thread]\n${formatted}`;
        }
      }
    } catch (err) {
      ctx.runtime.log?.(
        `slack:shortcut forward_message thread fetch failed: ${String(err)}`,
      );
    }
  } else if (channelId && messageTs) {
    // Case B: forwarded message may be a thread root — try to fetch its replies
    try {
      const repliesResult = await ctx.app.client.conversations.replies({
        channel: channelId,
        ts: messageTs,
        limit: MAX_THREAD_MESSAGES,
        token: ctx.botToken,
      });
      const replies = (repliesResult.messages ?? []) as Array<Record<string, unknown>>;
      // Skip the root message itself, keep only replies
      const replyMessages = replies.filter((m) => m.ts !== messageTs);
      if (replyMessages.length > 0) {
        const formatted = replyMessages
          .map((m) => {
            const sender = typeof m.user === "string" ? `<@${m.user}>` : (typeof m.username === "string" ? m.username : "unknown");
            const body = typeof m.text === "string" ? m.text.trim() : "";
            return body ? `${sender}: ${body}` : null;
          })
          .filter(Boolean)
          .join("\n");
        if (formatted) {
          threadContextText = `[该消息的 Thread 回复]\n${formatted}`;
        }
      }
    } catch {
      // thread_not_found = this message has no thread/replies, ignore silently
    }
  }

  // --- 3. Resolve media (images, files) from the message ---
  const [media, fwdAttachmentContent] = await Promise.all([
    resolveSlackMedia({ files, token: ctx.botToken, maxBytes: ctx.mediaMaxBytes }),
    resolveSlackAttachmentContent({
      attachments,
      token: ctx.botToken,
      maxBytes: ctx.mediaMaxBytes,
    }),
  ]);

  const mergedMedia = [...(media ?? []), ...(fwdAttachmentContent?.media ?? [])];

  // --- 4. Build the body for the AI ---
  const contentParts: string[] = [
    "用户通过 Slack 消息快捷方式转发了以下消息，请读取消息以及内部的消息列里所有信息，整理要点并以中文回复：",
    "",
  ];

  if (channelId) {
    const effectiveThreadTs = isThreadReply ? threadTs : undefined;
    const header = `[转发自频道 ${channelId}${messageTs ? `，时间戳 ${messageTs}` : ""}${effectiveThreadTs ? `，Thread 根消息时间戳 ${effectiveThreadTs}` : ""}]`;
    contentParts.push(header);
  }

  if (messageText) {
    contentParts.push(messageText);
  }

  // Forwarded/quoted attachment text (rich content from resolveSlackAttachmentContent)
  if (fwdAttachmentContent?.text) {
    contentParts.push(fwdAttachmentContent.text);
  }

  // All other attachment text (link previews, shared messages not caught above)
  const allAttachmentText = extractAttachmentText(attachments);
  if (allAttachmentText && allAttachmentText !== fwdAttachmentContent?.text) {
    contentParts.push(allAttachmentText);
  }

  // Thread context
  if (threadContextText) {
    contentParts.push("", threadContextText);
  }

  if (mergedMedia.length > 0) {
    contentParts.push(`[附件/图片共 ${mergedMedia.length} 个，已附上供分析]`);
  }

  const bodyForAgent = contentParts.join("\n").trim();

  if (!bodyForAgent) {
    ctx.runtime.log?.(
      `slack:shortcut forward_message nothing to forward user=${userId} channel=${channelId}`,
    );
    return;
  }

  // --- 5. Open the user's DM channel ---
  let dmChannelId: string | undefined;
  try {
    const dmResult = await ctx.app.client.conversations.open({
      users: userId,
      token: ctx.botToken,
    });
    dmChannelId = typeof dmResult.channel?.id === "string" ? dmResult.channel.id : undefined;
  } catch (err) {
    ctx.runtime.log?.(
      `slack:shortcut forward_message open DM failed user=${userId}: ${String(err)}`,
    );
    return;
  }

  if (!dmChannelId) {
    ctx.runtime.log?.(`slack:shortcut forward_message no DM channel for user=${userId}`);
    return;
  }

  // --- 6. Resolve agent route for this user's DM ---
  const route = resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "slack",
    accountId: ctx.accountId,
    teamId: ctx.teamId,
    peer: { kind: "direct", id: userId },
  });

  // 为转发消息创建独立的临时 session key，避免加载 DM 历史对话
  // 每次转发都使用新的 session key，这样 AI 只会看到本次转发的 thread 内容
  const forwardSessionKey = `slack:forward:${userId}:${Date.now()}`;

  // --- 7. Build MsgContext ---
  const firstMedia = mergedMedia[0];
  const msgCtx: MsgContext = {
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: messageText || bodyForAgent,
    CommandBody: bodyForAgent,
    BodyForCommands: bodyForAgent,
    From: `slack:${dmChannelId}`,
    To: `user:${userId}`,
    SessionKey: forwardSessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    Provider: "slack",
    Surface: "slack",
    OriginatingChannel: "slack",
    OriginatingTo: `user:${userId}`,
    SenderId: userId,
    CommandAuthorized: false,
    ...(firstMedia
      ? {
          MediaPath: firstMedia.path,
          MediaType: firstMedia.contentType,
          MediaUrl: firstMedia.path,
        }
      : {}),
    ...(mergedMedia.length > 0
      ? {
          MediaPaths: mergedMedia.map((m) => m.path),
          MediaUrls: mergedMedia.map((m) => m.path),
          MediaTypes: mergedMedia.map((m) => m.contentType ?? ""),
        }
      : {}),
  };

  // --- 8. Dispatch to AI and deliver reply to the DM ---
  ctx.runtime.log?.(
    `slack:shortcut forward_message dispatching to AI dm=${dmChannelId} session=${forwardSessionKey}`,
  );

  const dmChannelIdFinal = dmChannelId;
  const botToken = ctx.botToken;

  await dispatchInboundMessageWithDispatcher({
    ctx: msgCtx,
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = payload.text?.trim();
        if (!text) return;
        await ctx.app.client.chat.postMessage({
          channel: dmChannelIdFinal,
          text,
          token: botToken,
        });
      },
      onError: (err) => {
        ctx.runtime.error?.(
          danger(`slack:shortcut forward_message reply failed: ${String(err)}`),
        );
      },
    },
  });
}
