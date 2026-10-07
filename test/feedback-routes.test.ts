import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FeedbackStore } from "../src/feedback-store.js";
import { config, service } from "./app-fixtures.js";

describe("Feedback attachment routes", () => {
  it("protects and serves a stored image attachment to administrators", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-feedback-routes-"));
    const store = new FeedbackStore(path.join(tempDir, "feedback.sqlite"));
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const created = store.create({
      category: "bug",
      rating: 1,
      message: "图片附件",
      attachments: [{ filename: "screen.png", mimeType: "image/png", data: image }],
    });
    const attachment = store.get(created.id)?.attachments?.[0];
    expect(attachment).toBeDefined();
    const app = await buildApp({ config, reviewService: service(), feedbackStore: store });
    try {
      const url = `/api/v1/feedback/${created.id}/attachments/${attachment?.id ?? ""}`;
      const unauthorized = await app.inject({ method: "GET", url });
      expect(unauthorized.statusCode).toBe(401);

      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer trigger-token" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("image/png");
      expect(response.rawPayload).toEqual(image);
    } finally {
      await app.close();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
