import type { Context } from "../context.js";
import type { IsoDate, NodeId, ProjectId } from "../refs.js";
import { nodeId } from "../refs.js";
import { NotFoundError } from "../transport/errors.js";
import { paginate } from "../transport/paginate.js";
import { parseStatus } from "./parse.js";
import {
  CreateStatusUpdateDocument,
  DeleteStatusUpdateDocument,
  ProjectStatusUpdatesDocument,
  UpdateStatusUpdateDocument,
} from "./status-documents.js";

export type ProjectStatus = "INACTIVE" | "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "COMPLETE";

export interface StatusInput {
  status: ProjectStatus;
  body?: string;
  startDate?: IsoDate;
  targetDate?: IsoDate;
}

export interface StatusUpdate {
  readonly id: NodeId;
  edit(patch: Partial<StatusInput>): Promise<void>;
  delete(): Promise<void>;
}

export interface StatusUpdateData {
  id: NodeId;
  status: ProjectStatus | null;
  body: string;
  startDate: IsoDate | null;
  targetDate: IsoDate | null;
  createdAt: string;
}

export function createStatusUpdate(ctx: Context, id: NodeId): StatusUpdate {
  return {
    id,
    async edit(patch) {
      await ctx.execute(UpdateStatusUpdateDocument, {
        input: { statusUpdateId: id, ...statusFields(patch) },
      });
    },
    async delete() {
      await ctx.execute(DeleteStatusUpdateDocument, { input: { statusUpdateId: id } });
    },
  };
}

export async function postStatus(
  ctx: Context,
  projectId: ProjectId,
  input: StatusInput,
): Promise<StatusUpdate> {
  const data = await ctx.execute(CreateStatusUpdateDocument, {
    input: { projectId, ...statusFields(input) },
  });
  const created = data.createProjectV2StatusUpdate?.statusUpdate;
  if (!created) throw new NotFoundError("project", projectId);
  return createStatusUpdate(ctx, nodeId(created.id));
}

export function listStatusUpdates(
  ctx: Context,
  projectId: ProjectId,
): AsyncIterable<StatusUpdateData> {
  return mapIterable(
    paginate(async (after) => {
      const data = await ctx.execute(ProjectStatusUpdatesDocument, {
        id: projectId,
        after: after ?? null,
      });
      const node = data.node;
      if (!node || !("statusUpdates" in node)) throw new NotFoundError("project", projectId);
      return node.statusUpdates;
    }),
    parseStatus,
  );
}

function statusFields(input: Partial<StatusInput>) {
  return {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
  };
}

export async function* mapIterable<A, B>(
  source: AsyncIterable<A>,
  map: (a: A) => B,
): AsyncIterable<B> {
  for await (const a of source) yield map(a);
}
