import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export class StaffAuth {
    username = process.env.CAMPUSQ_STAFF_USER ?? "cashier";
    password = process.env.CAMPUSQ_STAFF_PASSWORD ?? "pilot123";
    secret = process.env.CAMPUSQ_AUTH_SECRET ?? createHash("sha256").update(`campusq:${this.password}`).digest("hex");
    failedAttempts = 0;
    lockedUntil = 0;
    login(username, password, windowId = 1) {
        if (this.lockedUntil > Date.now())
            throw new Error("Too many login attempts");
        const expectedUser = createHash("sha256").update(this.username).digest();
        const suppliedUser = createHash("sha256").update(username).digest();
        const expectedPassword = createHash("sha256").update(this.password).digest();
        const suppliedPassword = createHash("sha256").update(password).digest();
        if (!timingSafeEqual(expectedUser, suppliedUser) || !timingSafeEqual(expectedPassword, suppliedPassword)) {
            this.failedAttempts += 1;
            if (this.failedAttempts >= 5)
                this.lockedUntil = Date.now() + 15 * 60 * 1000;
            throw new Error("Invalid username or password");
        }
        this.failedAttempts = 0;
        const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
        const role = username === "supervisor" ? "supervisor" : "cashier";
        const body = Buffer.from(JSON.stringify({ username, role, windowId, expiresAt })).toString("base64url");
        const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
        return { token: `${body}.${signature}`, username, role, windowId, expiresAt };
    }
    middleware = (req, res, next) => {
        const header = req.header("authorization");
        const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
        const parts = token.split(".");
        if (parts.length !== 2) {
            return res.status(401).json({ error: "Staff login required" });
        }
        const [body, signature] = parts;
        const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
        const signatureBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expected);
        if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
            return res.status(401).json({ error: "Staff login required" });
        }
        let session;
        try {
            const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
            session = { ...payload, token };
        }
        catch {
            return res.status(401).json({ error: "Staff login required" });
        }
        if (session.expiresAt < Date.now())
            return res.status(401).json({ error: "Staff login required" });
        req.staff = session;
        next();
    };
}
