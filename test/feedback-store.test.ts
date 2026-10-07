import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FeedbackStore } from "../src/feedback-store.js";

describe("FeedbackStore", () => {
  it("persists feedback and returns the newest entries without contact details", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-feedback-store-"));
    const databasePath = path.join(tempDir, "feedback.sqlite");
    const store = new FeedbackStore(databasePath);
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
      const first = store.create({ category: "experience", rating: 5, message: "流程很清晰", contact: "tester@example.com" });
      vi.setSystemTime(new Date("2026-08-20T00:01:00.000Z"));
      const second = store.create({ category: "bug", rating: 2, message: "按钮没有反馈" });
      vi.useRealTimers();

      expect(store.list(1)).toEqual({
        items: [{ id: second.id, category: "bug", rating: 2, message: "按钮没有反馈", createdAt: "2026-08-20T00:01:00.000Z" }],
        total: 2,
      });
      expect(store.list().items).toEqual([
        { id: second.id, category: "bug", rating: 2, message: "按钮没有反馈", createdAt: "2026-08-20T00:01:00.000Z" },
        { id: first.id, category: "experience", rating: 5, message: "流程很清晰", createdAt: "2026-08-20T00:00:00.000Z" },
      ]);
    } finally {
      vi.useRealTimers();
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns feedback details and deletes a matching entry", () => {
    const store = new FeedbackStore(":memory:");
    try {
      const created = store.create({ category: "other", rating: 3, message: "希望有更多筛选", contact: "tester@example.com" });

      expect(store.get(created.id)).toEqual({
        id: created.id,
        category: "other",
        rating: 3,
        message: "希望有更多筛选",
        contact: "tester@example.com",
        createdAt: created.receivedAt,
      });
      expect(store.delete(created.id)).toBe(true);
      expect(store.get(created.id)).toBeNull();
      expect(store.delete(created.id)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("stores image attachments beside the database and removes them with feedback", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "frontend-pilot-feedback-attachments-"));
    const store = new FeedbackStore(path.join(tempDir, "feedback.sqlite"));
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    try {
      const created = store.create({
        category: "bug",
        rating: 2,
        message: "截图说明问题",
        attachments: [{ filename: "screen.png", mimeType: "image/png", data: image }],
      });
      const detail = store.get(created.id);
      expect(detail?.attachments).toEqual([{
        id: expect.any(String),
        filename: "screen.png",
        mimeType: "image/png",
        size: image.byteLength,
      }]);
      const attachment = detail?.attachments?.[0];
      expect(attachment).toBeDefined();
      const download = store.readAttachment(created.id, attachment?.id ?? "");
      expect(download).toMatchObject({ ...attachment, filePath: expect.any(String) });
      expect(readFileSync(download?.filePath ?? "")).toEqual(image);
      expect(store.delete(created.id)).toBe(true);
      expect(existsSync(download?.filePath ?? "")).toBe(false);
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
