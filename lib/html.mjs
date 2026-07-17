// Crude but effective HTML -> plain text for email bodies.

const ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
};

export function htmlToText(html) {
    if (!html) return "";
    if (!/[<>]|&\w+;/.test(html)) return html.trim();

    let text = html
        // drop invisible content entirely
        .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        // structural tags become newlines
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        // everything else vanishes
        .replace(/<[^>]+>/g, "");

    text = text
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&(\w+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);

    return text
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
}
