import Database from "better-sqlite3";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
export class QueueStore {
    db;
    secret;
    listeners = new Set();
    graceMinutes;
    bumpDistance;
    prepareThreshold;
    constructor(dbPath = ":memory:", secret = process.env.CAMPUSQ_QR_SECRET ?? randomBytes(32).toString("hex")) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.secret = secret;
        this.graceMinutes = Number(process.env.CAMPUSQ_GRACE_MINUTES ?? 10);
        this.bumpDistance = Number(process.env.CAMPUSQ_BUMP_DISTANCE ?? 5);
        this.prepareThreshold = Number(process.env.CAMPUSQ_PREPARE_THRESHOLD ?? 5);
        this.migrate();
        const settings = this.db.prepare("SELECT key, value FROM settings").all();
        for (const setting of settings) {
            if (setting.key === "graceMinutes")
                this.graceMinutes = Number(setting.value);
            if (setting.key === "bumpDistance")
                this.bumpDistance = Number(setting.value);
            if (setting.key === "prepareThreshold")
                this.prepareThreshold = Number(setting.value);
        }
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(event) {
        for (const listener of this.listeners)
            listener(event);
    }
    notify(ticketId, channel, message) {
        const existing = this.db.prepare(`
      SELECT id FROM notifications
      WHERE ticketId = ? AND channel = ? AND message = ?
      LIMIT 1
    `).get(ticketId, channel, message);
        if (existing)
            return;
        this.db.prepare(`
      INSERT INTO notifications (ticketId, channel, message, status, createdAt)
      VALUES (?, ?, ?, 'PENDING', ?)
    `).run(ticketId, channel, message, new Date().toISOString());
    }
    getAudit() {
        return this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 500").all();
    }
    getNotifications() {
        return this.db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 500").all();
    }
    markNotificationDelivered(notificationId) {
        const result = this.db.prepare(`
      UPDATE notifications
      SET status = 'DELIVERED', deliveredAt = ?
      WHERE id = ?
    `).run(new Date().toISOString(), notificationId);
        if (result.changes === 0)
            throw new Error("Notification not found");
        return this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(notificationId);
    }
    getStats() {
        const stateCounts = this.db.prepare(`
      SELECT state, COUNT(*) AS count FROM tickets GROUP BY state
    `).all();
        const counts = {};
        for (const row of stateCounts)
            counts[row.state] = row.count;
        return {
            waiting: (counts.WAITING ?? 0) + (counts.REQUEUED ?? 0) + (counts.BUMPED ?? 0),
            active: (counts.CALLED ?? 0) + (counts.GRACE ?? 0),
            served: counts.SERVED ?? 0,
            cancelled: counts.CANCELLED ?? 0,
        };
    }
    getSettings() {
        return { graceMinutes: this.graceMinutes, bumpDistance: this.bumpDistance, prepareThreshold: this.prepareThreshold };
    }
    updateSettings(graceMinutes, bumpDistance, prepareThreshold = this.prepareThreshold) {
        if (!Number.isInteger(graceMinutes) || graceMinutes < 1 || graceMinutes > 60)
            throw new Error("Grace period must be 1-60 minutes");
        if (!Number.isInteger(bumpDistance) || bumpDistance < 1 || bumpDistance > 20)
            throw new Error("Bump distance must be 1-20 positions");
        if (!Number.isInteger(prepareThreshold) || prepareThreshold < 1 || prepareThreshold > 20)
            throw new Error("Prepare threshold must be 1-20 positions");
        const upsert = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
        upsert.run("graceMinutes", String(graceMinutes));
        upsert.run("bumpDistance", String(bumpDistance));
        upsert.run("prepareThreshold", String(prepareThreshold));
        this.graceMinutes = graceMinutes;
        this.bumpDistance = bumpDistance;
        this.prepareThreshold = prepareThreshold;
        this.emit({ type: "SETTINGS_UPDATED", settings: this.getSettings() });
        return this.getSettings();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS windows (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        isOpen INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        studentName TEXT NOT NULL,
        state TEXT NOT NULL,
        position INTEGER NOT NULL,
        windowId INTEGER,
        calledAt TEXT,
        graceEndsAt TEXT,
        qrScannedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(windowId) REFERENCES windows(id)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticketId TEXT,
        action TEXT NOT NULL,
        fromState TEXT,
        toState TEXT,
        windowId INTEGER,
        metadata TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticketId TEXT,
        channel TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        deliveredAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ticket_number ON tickets(number);
    `);
        const ticketColumns = this.db.pragma("table_info(tickets)");
        if (!ticketColumns.some((column) => column.name === "qrScannedAt")) {
            this.db.exec("ALTER TABLE tickets ADD COLUMN qrScannedAt TEXT");
        }
        const windowCount = this.db.prepare("SELECT COUNT(*) AS count FROM windows").get();
        if (windowCount.count === 0) {
            const insert = this.db.prepare("INSERT INTO windows (id, name, isOpen) VALUES (?, ?, 1)");
            insert.run(1, "Window 1");
            insert.run(2, "Window 2");
        }
    }
    close() {
        this.db.close();
    }
    audit(ticketId, action, fromState, toState, windowId, metadata) {
        this.db.prepare(`
      INSERT INTO audit (ticketId, action, fromState, toState, windowId, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ticketId, action, fromState, toState, windowId, metadata ? JSON.stringify(metadata) : null, new Date().toISOString());
    }
    getWindows() {
        return this.db.prepare("SELECT id, name, isOpen FROM windows ORDER BY id").all();
    }
    getTickets() {
        return this.db.prepare(`
      SELECT id, number, studentName, state, position, windowId, calledAt, graceEndsAt, qrScannedAt, createdAt, updatedAt
      FROM tickets ORDER BY position ASC, createdAt ASC
    `).all();
    }
    getTicket(id) {
        return this.db.prepare(`
      SELECT id, number, studentName, state, position, windowId, calledAt, graceEndsAt, qrScannedAt, createdAt, updatedAt
      FROM tickets WHERE id = ?
    `).get(id);
    }
    issueTicket(studentName, source) {
        const run = this.db.transaction(() => {
            const current = this.db.prepare("SELECT COALESCE(MAX(number), 0) AS max FROM tickets").get();
            const number = current.max + 1;
            const id = randomUUID();
            const now = new Date();
            this.db.prepare(`
        INSERT INTO tickets (id, number, studentName, state, position, createdAt, updatedAt)
        VALUES (?, ?, ?, 'WAITING', ?, ?, ?)
      `).run(id, number, studentName.trim(), number, now.toISOString(), now.toISOString());
            this.audit(id, "ISSUE", null, "WAITING", null, { source });
            this.notify(id, "SMS", `CampusQ ticket #${number} issued.`);
            const ticket = this.getTicket(id);
            this.emit({ type: "TICKET_ISSUED", ticket });
            return ticket;
        });
        return run();
    }
    callNext(windowId) {
        const run = this.db.transaction(() => {
            const window = this.db.prepare("SELECT * FROM windows WHERE id = ? AND isOpen = 1").get(windowId);
            if (!window)
                throw new Error("Window is not available");
            const active = this.db.prepare("SELECT id FROM tickets WHERE windowId = ? AND state IN ('CALLED', 'GRACE')").get(windowId);
            if (active)
                throw new Error("Window already has an active ticket");
            const ticket = this.db.prepare("SELECT * FROM tickets WHERE state IN ('WAITING', 'REQUEUED') ORDER BY position ASC, createdAt ASC LIMIT 1").get();
            if (!ticket)
                throw new Error("Queue is empty");
            const now = new Date();
            const graceEndsAt = new Date(now.getTime() + this.graceMinutes * 60 * 1000).toISOString();
            this.db.prepare("UPDATE tickets SET state = 'CALLED', windowId = ?, calledAt = ?, graceEndsAt = ?, qrScannedAt = NULL, updatedAt = ? WHERE id = ?").run(windowId, now.toISOString(), graceEndsAt, now.toISOString(), ticket.id);
            this.audit(ticket.id, "CALL", ticket.state, "CALLED", windowId);
            this.notify(ticket.id, "BROWSER", `Ticket #${ticket.number} is ready at Window ${windowId}.`);
            this.notify(ticket.id, "SMS", `CampusQ: Ticket #${ticket.number}, proceed to Window ${windowId}.`);
            const called = this.getTicket(ticket.id);
            this.emit({ type: "TICKET_CALLED", ticket: called });
            const prepareTickets = this.db.prepare(`
        SELECT * FROM tickets
        WHERE state IN ('WAITING', 'REQUEUED')
          AND position <= ?
        ORDER BY position ASC
      `).all(ticket.position + this.prepareThreshold);
            for (const prepareTicket of prepareTickets) {
                this.notify(prepareTicket.id, "BROWSER", `Ticket #${prepareTicket.number} is approaching the front.`);
                this.notify(prepareTicket.id, "SMS", `CampusQ: Ticket #${prepareTicket.number} is nearly ready.`);
            }
            return called;
        });
        return run();
    }
    createQr(ticketId, scannerId = "scanner") {
        const ticket = this.getTicket(ticketId);
        if (!ticket)
            throw new Error("Ticket not found");
        const expiresAt = String(Date.now() + 30 * 60 * 1000);
        const body = `${ticketId}.${expiresAt}.${scannerId}`;
        const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
        return `${body}.${signature}`;
    }
    scanQr(payload, windowId, scannerId) {
        const run = this.db.transaction(() => {
            const parts = payload.split(".");
            if (parts.length !== 4)
                throw new Error("Invalid QR payload");
            const [ticketId, expiresAt, payloadScannerId, signature] = parts;
            if (!["campusq", "scanner", "scanner-1", "scanner-2"].includes(payloadScannerId))
                throw new Error("Invalid scanner QR payload");
            if (!["scanner-1", "scanner-2"].includes(scannerId))
                throw new Error("Invalid cashier scanner");
            if (Number(expiresAt) < Date.now())
                throw new Error("QR code has expired");
            const body = `${ticketId}.${expiresAt}.${payloadScannerId}`;
            const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
            if (signature !== expected)
                throw new Error("Invalid QR signature");
            const ticket = this.getTicket(ticketId);
            if (!ticket)
                throw new Error("Ticket not found");
            if (ticket.state !== "CALLED" && ticket.state !== "GRACE")
                throw new Error("Ticket is not ready for verification");
            if (ticket.windowId !== windowId)
                throw new Error("Ticket is assigned to a different window");
            if (!ticket.qrScannedAt) {
                const now = new Date().toISOString();
                this.db.prepare("UPDATE tickets SET qrScannedAt = ?, updatedAt = ? WHERE id = ?").run(now, now, ticket.id);
                this.audit(ticket.id, "QR_SCAN", ticket.state, ticket.state, windowId, { scannerId });
                const scanned = this.getTicket(ticket.id);
                this.emit({ type: "TICKET_QR_SCANNED", ticket: scanned });
                return scanned;
            }
            return ticket;
        });
        return run();
    }
    cancelTicket(ticketId) {
        const run = this.db.transaction(() => {
            const ticket = this.getTicket(ticketId);
            if (!ticket)
                throw new Error("Ticket not found");
            if (!["WAITING", "REQUEUED", "BUMPED"].includes(ticket.state))
                throw new Error("Only waiting tickets can be cancelled");
            const now = new Date().toISOString();
            this.db.prepare("UPDATE tickets SET state = 'CANCELLED', updatedAt = ? WHERE id = ?").run(now, ticketId);
            this.audit(ticketId, "CANCEL", ticket.state, "CANCELLED", ticket.windowId);
            const cancelled = this.getTicket(ticketId);
            this.emit({ type: "TICKET_CANCELLED", ticket: cancelled });
            return cancelled;
        });
        return run();
    }
    serveTicket(ticketId) {
        const run = this.db.transaction(() => {
            const ticket = this.getTicket(ticketId);
            if (!ticket)
                throw new Error("Ticket not found");
            if (!["CALLED", "GRACE"].includes(ticket.state))
                throw new Error("Ticket is not active");
            if (!ticket.qrScannedAt)
                throw new Error("Scan the ticket QR before serving");
            const now = new Date().toISOString();
            this.db.prepare("UPDATE tickets SET state = 'SERVED', updatedAt = ? WHERE id = ?").run(now, ticketId);
            this.audit(ticketId, "SERVE", ticket.state, "SERVED", ticket.windowId);
            const served = this.getTicket(ticketId);
            this.emit({ type: "TICKET_SERVED", ticket: served });
            return served;
        });
        return run();
    }
    expireGracePeriod() {
        const nowCutoff = new Date().toISOString();
        return this.db.transaction(() => {
            const missed = this.db.prepare(`
        SELECT * FROM tickets
        WHERE state = 'CALLED'
          AND COALESCE(graceEndsAt, calledAt) <= ?
      `).all(nowCutoff);
            for (const ticket of missed) {
                const now = new Date().toISOString();
                this.db.prepare("UPDATE tickets SET state = 'BUMPED', qrScannedAt = NULL, updatedAt = ? WHERE id = ?").run(now, ticket.id);
                this.audit(ticket.id, "BUMP", "CALLED", "BUMPED", ticket.windowId);
                this.db.prepare(`
          UPDATE tickets
          SET position = position + 1
          WHERE state IN ('WAITING', 'REQUEUED') AND position > ?
        `).run(ticket.position);
                this.db.prepare("UPDATE tickets SET position = position + ? WHERE id = ?").run(this.bumpDistance, ticket.id);
                this.db.prepare("UPDATE tickets SET state = 'REQUEUED', windowId = NULL, updatedAt = ? WHERE id = ?").run(now, ticket.id);
                this.audit(ticket.id, "REQUEUE", "BUMPED", "REQUEUED", null, { bumpDistance: this.bumpDistance });
                this.notify(ticket.id, "SMS", `CampusQ: Ticket #${ticket.number} was bumped back and requeued.`);
                this.emit({ type: "TICKET_REQUEUED", ticket: this.getTicket(ticket.id) });
            }
            return missed.length;
        })();
    }
}
