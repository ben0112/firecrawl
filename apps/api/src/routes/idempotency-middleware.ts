import type { NextFunction, Request, Response } from "express";
import { createIdempotencyKey } from "../services/idempotency/create";
import { validateIdempotencyKey } from "../services/idempotency/validate";

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  (async () => {
    if (req.headers["x-idempotency-key"]) {
      const isIdempotencyValid = await validateIdempotencyKey(req);
      if (!isIdempotencyValid && !res.headersSent) {
        return res
          .status(409)
          .json({ success: false, error: "Idempotency key already used" });
      }
      await createIdempotencyKey(req);
    }
    next();
  })().catch(err => next(err));
}
