const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_SAFE_LIMIT = 1900;

function splitDiscordText(value, requestedLimit = DEFAULT_SAFE_LIMIT) {
    const limit = Math.max(1, Math.min(DISCORD_MESSAGE_LIMIT, Math.floor(requestedLimit)));
    const text = String(value ?? '');
    if (!text) return [' '];

    const chunks = [];
    let current = '';

    const flush = () => {
        if (current) chunks.push(current);
        current = '';
    };

    for (const originalLine of text.split('\n')) {
        let line = originalLine;
        while (line.length > limit) {
            if (current) flush();
            let cutAt = line.lastIndexOf(' ', limit);
            if (cutAt < Math.floor(limit * 0.6)) cutAt = limit;
            const piece = line.slice(0, cutAt).trimEnd();
            chunks.push(piece || line.slice(0, limit));
            line = line.slice(cutAt).trimStart();
        }

        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length > limit) {
            flush();
            current = line;
        } else {
            current = candidate;
        }
    }

    flush();
    return chunks.length ? chunks : [' '];
}

function limitDiscordContent(value, maxLength = DEFAULT_SAFE_LIMIT) {
    const text = String(value ?? '');
    const limit = Math.max(1, Math.min(DISCORD_MESSAGE_LIMIT, Math.floor(maxLength)));
    if (text.length <= limit) return text || ' ';

    const suffix = '\n… (اختُصر النص لتوافق حد Discord)';
    const contentLimit = Math.max(0, limit - suffix.length);
    let cutAt = text.lastIndexOf('\n', contentLimit);
    if (cutAt < Math.floor(contentLimit * 0.6)) cutAt = contentLimit;
    return `${text.slice(0, cutAt).trimEnd()}${suffix}`;
}

module.exports = {
    DISCORD_MESSAGE_LIMIT,
    DEFAULT_SAFE_LIMIT,
    splitDiscordText,
    limitDiscordContent
};
