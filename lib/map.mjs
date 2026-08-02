// Shared mapping from CRM gateway DTOs to the local inbox.json shape.

import { htmlToText } from "./html.mjs";

export function mapMessage(m) {
    const hasParticipantIdentity = m.participantId != null || m.participantDisplayName || m.participantEmailAddress || m.participantIdentifier;
    const fromSupport =
        typeof m.fromSupport === "boolean"
            ? m.fromSupport
            : typeof m.isOutgoing === "boolean"
              ? m.isOutgoing
              : hasParticipantIdentity
                ? false
                : m.participantId == null;
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
        fromSupport,
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

function normalizeName(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function isCustomerSender(sender, chat) {
    const who = normalizeName(sender);
    if (!who || who === "unknown") return false;
    const participants = chat.chatParticipants ?? [];
    const participantNames = participants
        .flatMap((p) => [p.displayName, p.name, p.userName, p.emailAddress, p.participantIdentifier])
        .map(normalizeName)
        .filter(Boolean);
    if (participantNames.includes(who)) return true;
    const parties = String(chat.partiesDescription ?? "");
    const partyParts = parties
        .split(",")
        .map(normalizeName)
        .filter(Boolean);
    return partyParts.includes(who);
}

export function mapChat(chat, messages) {
    // Chat.Title is null for almost every thread; for email threads the real
    // subject lives in message email metadata. Use the earliest available subject.
    const emailSubject = cleanSubject(messages.map((m) => m.emailMetadata?.subject).find((s) => s && s.trim()));
    const mappedMessages = messages.map(mapMessage);

    // "Left on read": last message was from Tidy staff and at least one
    // participant (customer) has read up to that message.
    const mappedLast = mappedMessages.at(-1);
    const lastIsFromStaff = mappedLast && !mappedLast.isNote && mappedLast.fromSupport && !isCustomerSender(mappedLast.sender, chat);
    const mostRecentId = (chat.mostRecentMessageId ?? "").toLowerCase();
    const participants = chat.chatParticipants ?? [];
    const participantRead = !chat.closedDate && lastIsFromStaff && mostRecentId && participants.some((p) => (p.lastReadChatMessageId ?? "").toLowerCase() === mostRecentId);

    return {
        id: chat.id,
        code: chat.code,
        title: (chat.title && chat.title.trim()) || emailSubject || null,
        subject: emailSubject,
        isStarred: chat.isStarred ?? false,
        leftOnRead: participantRead ?? false,
        partiesDescription: chat.partiesDescription ?? null,
        createdDate: chat.createdDate ?? null,
        closedDate: chat.closedDate ?? null,
        mostRecentMessageDate: chat.mostRecentMessageDate ?? null,
        assignedUsers: chat.assignedUserContainer?.assignedUsers?.map((u) => u.userName ?? u.userId) ?? [],
        isEmailThread: messages.some((m) => m.emailMetadata),
        url: `https://crm.tidyint.com/communication/inbox/all/chat/${chat.id}`,
        messages: mappedMessages,
    };
}
