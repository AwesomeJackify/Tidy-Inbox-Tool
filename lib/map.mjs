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
        date: m.createdDate ?? m.date,
        sender:
            m.senderName ??
            m.createdByUserName ??
            m.participantDisplayName ??
            m.participantEmailAddress ??
            m.participantIdentifier ??
            m.sender ??
            "Unknown",
        fromSupport,
        isNote: m.isNote ?? false,
        text: m.text ?? htmlToText(m.message ?? ""),
        hasFiles: m.hasFiles ?? (m.files?.length ?? 0) > 0,
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

// Deliberately explicit, temporary authority for identifying Tidy senders.
// The CRM's `fromSupport` flag is unreliable for some customer messages, so
// unknown names must be treated as customers rather than inferred as staff.
const TIDY_STAFF_IDENTIFIERS = new Set(
    [
        "Aaron Worsnop", "Alex Smorodin", "Alice Holloway", "Alicia Lie", "Amelia Douglas", "Aqeel Munif",
        "Edmund Lu", "Emma Kay", "Gary Smith", "Gavin Bishop", "Gavin Mackintosh", "Graham Mackintosh",
        "Harriet Almond", "Harry Qu", "Jack Gong", "Jack Xing", "Jiazhi Zhou", "John Hayes", "John Keating",
        "Jonas Olesen", "Juhee Son", "Kade Young", "Karen Li", "Kartik Malik", "Kathy Chadwick", "Kevin Mann",
        "Lewis Azzopardi", "Lina Yuan", "Louis Sinclair", "Louis Wilks", "Manuel Bello-Cano", "Mark Robotham",
        "Mathew Nicholls", "Michelle Nicol", "Monica Shepherd", "Nathan Travis", "Peter Clapcott", "Phillip Dong",
        "Raquel Rodrigues", "Richmond Walker", "Stephen Pariñas", "Tarunisha Sharma", "Terence Qu", "Theepika Arunachalam",
        "Vasundhara Bisht", "Vishva Dave", "William Chong", "Ying Shen",
    ].map(normalizeName),
);

export function isKnownTidyStaff(value) {
    return TIDY_STAFF_IDENTIFIERS.has(normalizeName(value));
}

function participantIsCustomer(participant) {
    const identities = [
        participant.participantDisplayName,
        participant.participantEmailAddress,
        participant.participantIdentifier,
        // Retain compatibility with older/alternate participant DTO shapes.
        participant.displayName,
        participant.name,
        participant.userName,
        participant.emailAddress,
    ]
        .map(normalizeName)
        .filter(Boolean);
    return identities.some((identity) => !isKnownTidyStaff(identity));
}

export function mapChat(chat, messages) {
    // Chat.Title is null for almost every thread; for email threads the real
    // subject lives in message email metadata. Use the earliest available subject.
    const emailSubject = cleanSubject(messages.map((m) => m.emailMetadata?.subject).find((s) => s && s.trim()));
    const mappedMessages = messages.map(mapMessage);

    // "Left on read": last message is from a known Tidy sender and at least
    // one non-Tidy participant has read up to that exact message. Unknown
    // senders are deliberately customers, regardless of CRM's fromSupport flag.
    const mappedLast = mappedMessages.at(-1);
    const lastIsFromStaff = mappedLast && !mappedLast.isNote && isKnownTidyStaff(mappedLast.sender);
    const mostRecentId = (chat.mostRecentMessageId ?? "").toLowerCase();
    const participants = chat.chatParticipants ?? [];
    const participantRead = !chat.closedDate && lastIsFromStaff && mostRecentId && participants.some((p) => participantIsCustomer(p) && (p.lastReadChatMessageId ?? "").toLowerCase() === mostRecentId);

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
