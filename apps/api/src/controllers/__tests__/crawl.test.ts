import type { Mock } from "vitest";
import { crawlController } from "../v0/crawl";
import { config } from "../../config";
import { Request, Response } from "express";
import { createIdempotencyKey } from "../../services/idempotency/create";
import { validateIdempotencyKey } from "../../services/idempotency/validate";
import { v7 as uuidv7 } from "uuid";

vi.mock("../auth", () => ({
  authenticateUser: vi.fn().mockResolvedValue({
    success: true,
    team_id: "team123",
    error: null,
    status: 200,
  }),
  reduce: vi.fn(),
}));
vi.mock("../../services/idempotency/validate");
vi.mock("../../services/idempotency/create");
vi.mock("../../services/redis", () => ({
  redisEvictConnection: {
    sadd: vi.fn().mockResolvedValue(1),
  },
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: vi.fn(),
}));

describe("crawlController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createIdempotencyKey as Mock).mockResolvedValue("stored-key");
  });

  it("should prevent duplicate requests using the same idempotency key", async () => {
    const req = {
      headers: {
        "x-idempotency-key": await uuidv7(),
        Authorization: `Bearer ${config.TEST_API_KEY}`,
      },
      body: {
        url: "https://mendable.ai",
      },
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    // Mock the idempotency key validation to return false for the second call
    (validateIdempotencyKey as Mock).mockResolvedValueOnce(false);

    await crawlController(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Idempotency key already used",
    });
  });

  it("returns 500 when the idempotency key cannot be stored", async () => {
    const req = {
      headers: {
        "x-idempotency-key": await uuidv7(),
        Authorization: `Bearer ${config.TEST_API_KEY}`,
      },
      body: {
        url: "https://mendable.ai",
      },
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    (validateIdempotencyKey as Mock).mockResolvedValueOnce(true);
    (createIdempotencyKey as Mock).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await crawlController(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Failed to store idempotency key",
    });
  });
});
