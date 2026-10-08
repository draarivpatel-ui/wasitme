/** Worker-thread entry of the calibration harness: runs one `Job` per message (see run.ts `JobPool`). */
import { parentPort } from "node:worker_threads";
import { runJob, type Job } from "./jobs.js";

const port = parentPort;
if (port !== null) {
  port.on("message", (msg: { id: number; job: Job }) => {
    try {
      port.postMessage({ id: msg.id, result: runJob(msg.job) });
    } catch (e) {
      port.postMessage({ id: msg.id, error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
    }
  });
}
