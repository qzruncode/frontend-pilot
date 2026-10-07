import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TrackUserActivityBodySchema, UserActivityActionSchema } from "./contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import { browserSessionUser, requireAdminAccess, unauthorized, zodError } from "./app-route-utils.js";

const UserActivityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  user: z.string().trim().min(1).max(128).optional(),
  action: UserActivityActionSchema.optional(),
  usersPage: z.coerce.number().int().min(1).max(10_000).default(1),
  usersPageSize: z.coerce.number().int().min(1).max(100).default(20),
  recentPage: z.coerce.number().int().min(1).max(10_000).default(1),
  recentPageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export function registerUserActivityRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.post("/api/v1/user-activity", async (request, reply) => {
    const user = browserSessionUser(request, context.config, context.userStore);
    if (!user) return unauthorized(reply);
    const parsed = TrackUserActivityBodySchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    context.userActivityStore.record({ username: user.username, action: "page_view", path: parsed.data.path });
    return reply.code(201).send({ tracked: true });
  });

  app.get("/api/v1/user-activity", async (request, reply) => {
    if (!requireAdminAccess(request, reply, context.config, context.userStore)) return;
    const parsed = UserActivityQuerySchema.safeParse(request.query);
    if (!parsed.success) return zodError(reply, parsed.error);
    return reply.send(context.userActivityStore.stats(parsed.data));
  });
}
