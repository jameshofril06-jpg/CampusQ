import express from "express";
import { z } from "zod";
import { QueueStore } from "./queue.js";
import { StaffAuth } from "./auth.js";
export function createApp(store = new QueueStore(process.env.CAMPUSQ_DB ?? ":memory:")) {
    const app = express();
    const auth = new StaffAuth();
    app.use(express.json());
    app.post("/api/auth/login", (req, res) => {
        const parsed = z.object({
            username: z.string().trim().min(1),
            password: z.string().min(1),
            windowId: z.union([z.literal(1), z.literal(2)]),
        }).safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: "Username and password are required" });
        try {
            res.json(auth.login(parsed.data.username, parsed.data.password, parsed.data.windowId));
        }
        catch (error) {
            res.status(401).json({ error: error instanceof Error ? error.message : "Login failed" });
        }
    });
    app.get("/api/health", (_req, res) => res.json({
        status: "ok",
        database: store.db.open ? "connected" : "closed",
        stats: store.getStats(),
    }));
    app.get("/api/stats", (_req, res) => res.json(store.getStats()));
    app.get("/api/audit", auth.middleware, (_req, res) => res.json(store.getAudit()));
    app.get("/api/notifications", auth.middleware, (_req, res) => res.json(store.getNotifications()));
    app.post("/api/notifications/:id/deliver", auth.middleware, (req, res) => {
        try {
            res.json(store.markNotificationDelivered(Number(req.params.id)));
        }
        catch (error) {
            res.status(404).json({ error: error instanceof Error ? error.message : "Notification not found" });
        }
    });
    app.get("/api/windows", (_req, res) => res.json(store.getWindows()));
    app.get("/api/tickets", (_req, res) => res.json(store.getTickets()));
    app.get("/api/settings", (_req, res) => res.json(store.getSettings()));
    app.put("/api/settings", auth.middleware, (req, res) => {
        const parsed = z.object({
            graceMinutes: z.number().int().min(1).max(60),
            bumpDistance: z.number().int().min(1).max(20),
            prepareThreshold: z.number().int().min(1).max(20).default(5),
        }).safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: "Invalid queue settings" });
        try {
            res.json(store.updateSettings(parsed.data.graceMinutes, parsed.data.bumpDistance, parsed.data.prepareThreshold));
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not update settings" });
        }
    });
    app.get("/api/events", (req, res) => {
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: "CONNECTED" })}\n\n`);
        const unsubscribe = store.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
        req.on("close", unsubscribe);
    });
    app.get("/api/tickets/:id", (req, res) => {
        const ticket = store.getTicket(req.params.id);
        if (!ticket)
            return res.status(404).json({ error: "Ticket not found" });
        res.json(ticket);
    });
    app.post("/api/tickets", (req, res) => {
        const parsed = z.object({
            studentName: z.string().trim().min(1).max(100),
            source: z.enum(["web", "kiosk", "cashier"]).default("web"),
        }).safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: "Student name is required" });
        try {
            const ticket = store.issueTicket(parsed.data.studentName, parsed.data.source);
            res.status(201).json({
                ...ticket,
                qrPayload: store.createQr(ticket.id, "campusq"),
            });
        }
        catch (error) {
            res.status(409).json({ error: error instanceof Error ? error.message : "Could not issue ticket" });
        }
    });
    app.post("/api/windows/:id/call", auth.middleware, (req, res) => {
        try {
            const windowId = Number(req.params.id);
            const staff = req.staff;
            if (staff?.windowId !== windowId)
                return res.status(403).json({ error: "You are assigned to a different window" });
            res.json(store.callNext(windowId));
        }
        catch (error) {
            res.status(409).json({ error: error instanceof Error ? error.message : "Could not call ticket" });
        }
    });
    app.post("/api/tickets/:id/cancel", auth.middleware, (req, res) => {
        try {
            res.json(store.cancelTicket(String(req.params.id)));
        }
        catch (error) {
            res.status(409).json({ error: error instanceof Error ? error.message : "Could not cancel ticket" });
        }
    });
    app.post("/api/tickets/:id/serve", auth.middleware, (req, res) => {
        try {
            const ticket = store.getTicket(String(req.params.id));
            const staff = req.staff;
            if (!ticket)
                return res.status(404).json({ error: "Ticket not found" });
            if (ticket.windowId !== staff?.windowId)
                return res.status(403).json({ error: "Ticket belongs to a different window" });
            res.json(store.serveTicket(ticket.id));
        }
        catch (error) {
            res.status(409).json({ error: error instanceof Error ? error.message : "Could not serve ticket" });
        }
    });
    app.post("/api/tickets/:id/qr", auth.middleware, (req, res) => {
        try {
            res.json({ payload: store.createQr(String(req.params.id), String(req.body?.scannerId ?? "scanner")) });
        }
        catch (error) {
            res.status(404).json({ error: error instanceof Error ? error.message : "Could not create QR" });
        }
    });
    app.post("/api/qr/verify", auth.middleware, (req, res) => {
        const parsed = z.object({
            payload: z.string().min(1),
            windowId: z.number().int().positive(),
            scannerId: z.string().min(1),
        }).safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: "Invalid verification request" });
        try {
            const staff = req.staff;
            if (staff?.windowId !== parsed.data.windowId)
                return res.status(403).json({ error: "Scanner window does not match your assignment" });
            res.json(store.scanQr(parsed.data.payload, parsed.data.windowId, parsed.data.scannerId));
        }
        catch (error) {
            res.status(409).json({ error: error instanceof Error ? error.message : "Verification failed" });
        }
    });
    app.post("/api/grace/expire", auth.middleware, (_req, res) => {
        res.json({ bumped: store.expireGracePeriod() });
    });
    return app;
}
