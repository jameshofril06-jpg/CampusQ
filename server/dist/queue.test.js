import { afterEach, describe, expect, it } from "vitest";
import { QueueStore } from "./queue.js";
const stores = [];
function store() {
    const value = new QueueStore(":memory:");
    stores.push(value);
    return value;
}
afterEach(() => stores.splice(0).forEach((value) => value.close()));
describe("QueueStore", () => {
    it("issues tickets in first-come-first-served order", () => {
        const queue = store();
        const first = queue.issueTicket("Ana", "web");
        const second = queue.issueTicket("Ben", "kiosk");
        expect(first.number).toBe(1);
        expect(second.number).toBe(2);
        expect(queue.callNext(1).id).toBe(first.id);
    });
    it("does not call a second ticket while a window has an active ticket", () => {
        const queue = store();
        queue.issueTicket("Ana", "web");
        queue.issueTicket("Ben", "kiosk");
        queue.callNext(1);
        expect(() => queue.callNext(1)).toThrow("Window already has an active ticket");
        expect(queue.callNext(2).studentName).toBe("Ben");
    });
    it("bumps a missed ticket and requeues it", () => {
        const queue = store();
        const first = queue.issueTicket("Ana", "web");
        queue.issueTicket("Ben", "kiosk");
        queue.issueTicket("Cy", "cashier");
        queue.callNext(1);
        const db = queue.db;
        db.prepare(`
      UPDATE tickets
      SET calledAt = '2000-01-01T00:00:00.000Z',
          graceEndsAt = '2000-01-01T00:10:00.000Z'
      WHERE id = ?
    `).run(first.id);
        expect(queue.expireGracePeriod()).toBe(1);
        expect(queue.getTicket(first.id)?.state).toBe("REQUEUED");
    });
    it("requires a signed QR scan before serving a called ticket", () => {
        const queue = store();
        const ticket = queue.issueTicket("Ana", "web");
        const called = queue.callNext(1);
        const qr = queue.createQr(called.id, "scanner-1");
        expect(() => queue.serveTicket(ticket.id)).toThrow("Scan the ticket QR before serving");
        expect(queue.scanQr(qr, 1, "scanner-1")).toMatchObject({
            state: "CALLED",
            qrScannedAt: expect.any(String),
        });
        expect(queue.serveTicket(ticket.id).state).toBe("SERVED");
        expect(() => queue.scanQr(qr, 1, "scanner-1")).toThrow("Ticket is not ready for verification");
    });
    it("serves and cancels tickets through valid transitions", () => {
        const queue = store();
        const ticket = queue.issueTicket("Ana", "cashier");
        queue.callNext(1);
        queue.scanQr(queue.createQr(ticket.id, "scanner-1"), 1, "scanner-1");
        expect(queue.serveTicket(ticket.id).state).toBe("SERVED");
        expect(() => queue.cancelTicket(ticket.id)).toThrow("Only waiting tickets");
    });
    it("updates and persists configurable grace and bump settings", () => {
        const queue = store();
        expect(queue.updateSettings(15, 3, 4)).toEqual({ graceMinutes: 15, bumpDistance: 3, prepareThreshold: 4 });
        expect(queue.getSettings()).toEqual({ graceMinutes: 15, bumpDistance: 3, prepareThreshold: 4 });
        expect(() => queue.updateSettings(0, 3)).toThrow("1-60 minutes");
    });
    it("marks an existing notification as delivered", () => {
        const queue = store();
        const ticket = queue.issueTicket("Ana", "cashier");
        const notification = queue.getNotifications()[0];
        expect(queue.markNotificationDelivered(notification.id)).toMatchObject({
            ticketId: ticket.id,
            status: "DELIVERED",
        });
    });
    it("verifies a ticket-issued campusq QR without serving it", () => {
        const queue = store();
        const ticket = queue.issueTicket("QR Student", "kiosk");
        const called = queue.callNext(2);
        expect(called.id).toBe(ticket.id);
        const qr = queue.createQr(ticket.id, "campusq");
        expect(queue.scanQr(qr, 2, "scanner-2")).toMatchObject({
            state: "CALLED",
            qrScannedAt: expect.any(String),
        });
    });
    it("queues prepare notifications for tickets near the front", () => {
        const queue = store();
        queue.updateSettings(10, 5, 2);
        queue.issueTicket("First", "web");
        queue.issueTicket("Second", "web");
        queue.issueTicket("Third", "web");
        queue.callNext(1);
        const messages = queue.getNotifications().map((row) => row);
        expect(messages.some((row) => row.message.includes("nearly ready"))).toBe(true);
    });
    it("does not duplicate an identical notification", () => {
        const queue = store();
        queue.issueTicket("Ana", "web");
        queue.issueTicket("Ben", "web");
        queue.callNext(1);
        queue.callNext(2);
        const notifications = queue.getNotifications();
        const duplicateKeys = new Set(notifications.map((row) => {
            const value = row;
            return `${value.ticketId}:${value.channel}:${value.message}`;
        }));
        expect(duplicateKeys.size).toBe(notifications.length);
    });
});
