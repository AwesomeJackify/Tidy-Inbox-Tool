// Shared mapping from CRM gateway DTOs to the local inbox.json shape.

import { htmlToText } from "./html.mjs";

export function mapMessage(m) {
    return {
        id: m.id,
        date: m.createdDate,
        sender:
            m.senderName ??
            m.createdByUserName ??
            m.participantDisplayName ??
            m.participantEmailAddress ??
            m.participantIdentifier ??
            "Unknown",
        fromSupport: m.participantId == null, // matches ChatMessageDto.IsOutgoing
        isNote: m.isNote ?? false,
        text: htmlToText(m.message ?? ""),
        hasFiles: (m.files?.length ?? 0) > 0,
    };
}

/** Strip RE:/FW:/FWD: prefixes and trim an email subject. */
function cleanSubject(s) {
    return s
        ? s
              .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "")
              .replace(/\s+/g, " ")
              .trim() || null
        : null;
}

export function mapChat(chat, messages) {
    // Chat.Title is null for almost every thread; for email threads the real
    // subject lives in message email metadata. Use the earliest available subject.
    const emailSubject = cleanSubject(messages.map((m) => m.emailMetadata?.subject).find((s) => s && s.trim()));
    return {
        id: chat.id,
        code: chat.code,
        title: (chat.title && chat.title.trim()) || emailSubject || null,
        subject: emailSubject,
        isStarred: chat.isStarred ?? false,
        partiesDescription: chat.partiesDescription ?? null,
        createdDate: chat.createdDate ?? null,
        closedDate: chat.closedDate ?? null,
        mostRecentMessageDate: chat.mostRecentMessageDate ?? null,
        assignedUsers: chat.assignedUserContainer?.assignedUsers?.map((u) => u.userName ?? u.userId) ?? [],
        isEmailThread: messages.some((m) => m.emailMetadata),
        url: `https://crm.tidyint.com/communication/inbox/all/chat/${chat.id}`,
        messages: messages.map(mapMessage),
    };
}
