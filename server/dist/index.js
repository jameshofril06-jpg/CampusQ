import "dotenv/config";
import { mkdirSync } from "node:fs";
import { createApp } from "./app.js";
import { QueueStore } from "./queue.js";
const port = Number(process.env.PORT ?? 3001);
mkdirSync("data", { recursive: true });
const store = new QueueStore(process.env.CAMPUSQ_DB ?? "data/campusq.db");
const app = createApp(store);
setInterval(() => {
    try {
        store.expireGracePeriod();
    }
    catch (error) {
        console.error("Grace-period processing failed", error);
    }
}, 1000).unref();
app.listen(port, () => {
    console.log(`CampusQ API listening on http://localhost:${port}`);
});
