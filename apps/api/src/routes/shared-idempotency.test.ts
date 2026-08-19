import type { NextFunction, Request, Response } from "express";

const { validateIdempotencyKeyMock, createIdempotencyKeyMock } = vi.hoisted(
  () => ({
    validateIdempotencyKeyMock: vi.fn(),
    createIdempotencyKeyMock: vi.fn(),
  }),
);

vi.mock("../services/idempotency/validate", () => ({
  validateIdempotencyKey: validateIdempotencyKeyMock,
}));

vi.mock("../services/idempotency/create", () => ({
  createIdempotencyKey: createIdempotencyKeyMock,
}));

import { idempotencyMiddleware } from "./idempotency-middleware";

describe("idempotencyMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateIdempotencyKeyMock.mockResolvedValue(true);
  });

  it("does not continue until the idempotency key is durably stored", async () => {
    let finishStore!: () => void;
    createIdempotencyKeyMock.mockReturnValue(
      new Promise<string>(resolve => {
        finishStore = () => resolve("stored-key");
      }),
    );
    const req = {
      headers: { "x-idempotency-key": crypto.randomUUID() },
    } as unknown as Request;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;

    idempotencyMiddleware(req, res, next);
    await Promise.resolve();
    await Promise.resolve();

    expect(next).not.toHaveBeenCalled();

    finishStore();
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith());
  });
});
