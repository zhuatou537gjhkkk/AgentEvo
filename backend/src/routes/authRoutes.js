import { toErrorEnvelope } from "../services/resilience.js";

function dependency(req, name) {
    const db = req.locals?.dependencies?.db || req.app?.locals?.dependencies?.db;
    const fn = db?.[name];
    if (typeof fn !== "function") {
        throw Object.assign(new Error(`missing dependency: db.${name}`), {
            code: "DEPENDENCY_UNAVAILABLE",
            statusCode: 503,
        });
    }
    return fn;
}

/** Factory-local auth write routes. Crypto/token helpers are explicit inputs. */
export function registerAuthRoutes(router, {
    createRateLimit,
    hashPassword,
    verifyPassword,
    issueAuthToken,
}) {
    if (typeof createRateLimit !== "function") throw new TypeError("createRateLimit is required");
    router.post("/auth/register", createRateLimit({ scope: "auth-register", max: 10 }), (req, res) => {
        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "");
        if (username.length < 3 || password.length < 6) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("用户名至少 3 位，密码至少 6 位"), {
                code: "AUTH_INVALID", statusCode: 400,
            }), req.requestId));
        }
        try {
            if (dependency(req, "getUserByUsername")(username)) {
                return res.status(409).json(toErrorEnvelope(Object.assign(new Error("用户名已存在"), {
                    code: "AUTH_CONFLICT", statusCode: 409,
                }), req.requestId));
            }
            const userId = dependency(req, "createUser")(username, hashPassword(password));
            const user = dependency(req, "getUserById")(userId);
            return res.json({ ok: true, token: issueAuthToken(user), user });
        } catch {
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("registration failed"), {
                code: "REQUEST_FAILED", statusCode: 500,
            }), req.requestId));
        }
    });

    router.post("/auth/login", createRateLimit({ scope: "auth-login", max: 10 }), (req, res) => {
        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "");
        if (!username || !password) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("username and password are required"), {
                code: "AUTH_INVALID", statusCode: 400,
            }), req.requestId));
        }
        try {
            const user = dependency(req, "getUserByUsername")(username);
            if (!user || !verifyPassword(password, user.password_hash)) {
                return res.status(401).json(toErrorEnvelope(Object.assign(new Error("用户名或密码错误"), {
                    code: "UNAUTHORIZED", statusCode: 401,
                }), req.requestId));
            }
            return res.json({
                ok: true,
                token: issueAuthToken(user),
                user: { id: user.id, username: user.username, created_at: user.created_at },
            });
        } catch {
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("login failed"), {
                code: "REQUEST_FAILED", statusCode: 500,
            }), req.requestId));
        }
    });
}
