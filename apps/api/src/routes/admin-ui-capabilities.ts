import type { RequestHandler, Router } from "express";
import { adminUiCapabilitiesController } from "../controllers/v2/admin-ui-capabilities";
import { wrap } from "./shared";

export function registerAdminUiCapabilitiesRoute(
  router: Pick<Router, "get">,
  authenticateViewer: RequestHandler,
) {
  router.get(
    "/admin-ui-capabilities",
    authenticateViewer,
    wrap(adminUiCapabilitiesController),
  );
}
