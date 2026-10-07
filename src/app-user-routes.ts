import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreateUserInputSchema, UpdateUserInputSchema } from "./contracts.js";
import type { AppRouteContext } from "./app-route-context.js";
import { browserSessionUser, parseIdParam, unauthorized, zodError } from "./app-route-utils.js";
import { UserStoreError } from "./user-store.js";

function requireAdmin(context: AppRouteContext, request: FastifyRequest, reply: FastifyReply) {
  const user = browserSessionUser(request, context.config, context.userStore);
  if (!user) {
    unauthorized(reply);
    return null;
  }
  if (user.role !== "admin") {
    reply.code(403).send({ error: "admin_required", details: "只有管理员可以管理用户" });
    return null;
  }
  return user;
}

export function registerUserRoutes(app: FastifyInstance, context: AppRouteContext): void {
  app.get("/api/v1/users", async (request, reply) => {
    if (!requireAdmin(context, request, reply)) return;
    return reply.send({ users: context.userStore.list(), total: context.userStore.countUsers() });
  });

  app.post("/api/v1/users", async (request, reply) => {
    if (!requireAdmin(context, request, reply)) return;
    const parsed = CreateUserInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    try {
      return reply.code(201).send({ user: context.userStore.create(parsed.data) });
    } catch (error) {
      if (error instanceof UserStoreError && error.code === "username_taken") {
        return reply.code(409).send({ error: "username_taken", details: "用户名已存在" });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/v1/users/:id", async (request, reply) => {
    const admin = requireAdmin(context, request, reply);
    if (!admin) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    const parsed = UpdateUserInputSchema.safeParse(request.body);
    if (!parsed.success) return zodError(reply, parsed.error);
    const target = context.userStore.findById(id);
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    if (target.id === admin.id && parsed.data.username !== undefined && parsed.data.username !== admin.username) {
      return reply.code(400).send({ error: "cannot_rename_current_user", details: "不能修改当前登录的管理员用户名" });
    }
    if (target.id === admin.id && parsed.data.enabled === false) {
      return reply.code(400).send({ error: "cannot_disable_current_user", details: "不能停用当前登录的管理员账号" });
    }
    if (target.role === "admin" && parsed.data.enabled === false && context.userStore.countEnabledAdmins() <= 1) {
      return reply.code(400).send({ error: "last_admin_required", details: "至少需要保留一个启用中的管理员账号" });
    }
    try {
      const user = context.userStore.update(id, parsed.data);
      return user ? reply.send({ user }) : reply.code(404).send({ error: "user_not_found" });
    } catch (error) {
      if (error instanceof UserStoreError && error.code === "username_taken") {
        return reply.code(409).send({ error: "username_taken", details: "用户名已存在" });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/users/:id", async (request, reply) => {
    const admin = requireAdmin(context, request, reply);
    if (!admin) return;
    const id = parseIdParam(request, reply);
    if (!id) return;
    const target = context.userStore.findById(id);
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    if (target.id === admin.id) {
      return reply.code(400).send({ error: "cannot_delete_current_user", details: "不能删除当前登录的管理员账号" });
    }
    if (target.role === "admin" && context.userStore.countAdmins() <= 1) {
      return reply.code(400).send({ error: "last_admin_required", details: "至少需要保留一个管理员账号" });
    }
    return reply.send({ deleted: context.userStore.delete(id) });
  });
}
