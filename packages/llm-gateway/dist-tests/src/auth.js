import { AuthError } from "./errors.js";
function extractApiKey(c) {
    const headerKey = c.req.header("x-api-key") ?? c.req.header("X-API-Key");
    if (headerKey)
        return headerKey;
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth)
        return undefined;
    if (!auth.toLowerCase().startsWith("bearer "))
        return undefined;
    return auth.slice(7).trim();
}
export function authMiddleware(config) {
    return async (c, next) => {
        if (config.auth.mode === "none") {
            await next();
            return;
        }
        const apiKey = extractApiKey(c);
        if (!apiKey || !config.auth.keys.includes(apiKey)) {
            throw new AuthError();
        }
        await next();
    };
}
