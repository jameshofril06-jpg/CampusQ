import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { QueueStore } from "./queue.js";
const stores = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
describe("CampusQ API authentication", () => {
    it("rejects unauthenticated staff mutations", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const app = createApp(store);
        store.issueTicket("Ana", "web");
        await request(app).post("/api/windows/1/call").expect(401);
        await request(app).put("/api/settings").send({ graceMinutes: 12, bumpDistance: 5 }).expect(401);
    });
    it("allows cashier mutations after login", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const app = createApp(store);
        store.issueTicket("Ana", "web");
        const login = await request(app).post("/api/auth/login").send({
            username: "cashier",
            password: "pilot123",
            windowId: 1,
        }).expect(200);
        await request(app)
            .post("/api/windows/1/call")
            .set("Authorization", `Bearer ${login.body.token}`)
            .expect(200);
    });
    it("requires cashier QR verification before processing a called ticket", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const app = createApp(store);
        const issued = await request(app).post("/api/tickets").send({
            studentName: "QR Student",
            source: "web",
        }).expect(201);
        const login = await request(app).post("/api/auth/login").send({
            username: "cashier",
            password: "pilot123",
            windowId: 1,
        }).expect(200);
        const authorization = `Bearer ${login.body.token}`;
        await request(app).post("/api/windows/1/call")
            .set("Authorization", authorization)
            .expect(200);
        await request(app).post(`/api/tickets/${issued.body.id}/serve`)
            .set("Authorization", authorization)
            .expect(409)
            .expect(({ body }) => expect(body.error).toContain("Scan the ticket QR"));
        const scan = await request(app).post("/api/qr/verify")
            .set("Authorization", authorization)
            .send({
            payload: issued.body.qrPayload,
            windowId: 1,
            scannerId: "scanner-1",
        })
            .expect(200);
        expect(scan.body.state).toBe("CALLED");
        expect(scan.body.qrScannedAt).toEqual(expect.any(String));
        await request(app).post(`/api/tickets/${issued.body.id}/serve`)
            .set("Authorization", authorization)
            .expect(200)
            .expect(({ body }) => expect(body.state).toBe("SERVED"));
    });
    it("protects audit and notification operational reports", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const app = createApp(store);
        await request(app).get("/api/audit").expect(401);
        await request(app).get("/api/notifications").expect(401);
    });
    it("returns a signed QR payload when issuing a ticket", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const app = createApp(store);
        const response = await request(app).post("/api/tickets").send({
            studentName: "QR Student",
            source: "kiosk",
        }).expect(201);
        expect(response.body.qrPayload).toContain(".campusq.");
    });
    it("keeps a signed staff token valid across auth instances", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const firstApp = createApp(store);
        const login = await request(firstApp).post("/api/auth/login").send({
            username: "cashier",
            password: "pilot123",
            windowId: 1,
        }).expect(200);
        const restartedApp = createApp(store);
        await request(restartedApp)
            .post("/api/windows/1/call")
            .set("Authorization", `Bearer ${login.body.token}`)
            .send()
            .expect(409);
    });
    it("locks staff login after repeated failures", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const app = createApp(store);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await request(app).post("/api/auth/login").send({
                username: "cashier",
                password: "wrong",
                windowId: 1,
            }).expect(401);
        }
        await request(app).post("/api/auth/login").send({
            username: "cashier",
            password: "pilot123",
            windowId: 1,
        }).expect(401);
    });
    it("returns window assignment and rejects calls to another window", async () => {
        const store = new QueueStore(":memory:");
        stores.push(store);
        const app = createApp(store);
        store.issueTicket("Ana", "web");
        const login = await request(app).post("/api/auth/login").send({
            username: "cashier",
            password: "pilot123",
            windowId: 2,
        }).expect(200);
        expect(login.body.windowId).toBe(2);
        await request(app)
            .post("/api/windows/1/call")
            .set("Authorization", `Bearer ${login.body.token}`)
            .expect(403);
    });
});
