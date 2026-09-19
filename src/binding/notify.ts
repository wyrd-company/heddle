// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import {
  blueprintContext,
  type HeddleFlowcraftNode,
} from "../blueprints/flowcraft.js";
import { renderTemplate, type TemplateSource } from "../templates/index.js";
import type { EngineNode } from "../engine/types.js";

export interface Notification {
  title: string;
  message: string;
  url?: string;
}
export interface NotificationDelivery {
  send(notification: Notification): Promise<unknown>;
}
export interface PushoverOptions {
  token: string;
  user: string;
  endpoint?: string;
  fetch?: typeof fetch;
}

export class PushoverDelivery implements NotificationDelivery {
  constructor(private readonly options: PushoverOptions) {}
  async send(notification: Notification): Promise<unknown> {
    const body = new URLSearchParams({
      token: this.options.token,
      user: this.options.user,
      title: notification.title,
      message: notification.message,
      ...(notification.url === undefined ? {} : { url: notification.url }),
    });
    const response = await (this.options.fetch ?? fetch)(
      this.options.endpoint ?? "https://api.pushover.net/1/messages.json",
      { method: "POST", body },
    );
    if (!response.ok)
      throw new Error(
        `Pushover notification failed with ${String(response.status)}`,
      );
    return response.json();
  }
}

export function notifyNode(
  delivery: NotificationDelivery,
  templates?: TemplateSource,
): EngineNode {
  return async (context) => {
    const definition = context.run.blueprint.nodes.find(
      (node) => node.id === context.nodeId,
    ) as HeddleFlowcraftNode | undefined;
    const values = {
      ...context.context,
      blueprint: blueprintContext(context.run.blueprint),
      metadata: definition?.metadata ?? {},
      node: definition ?? {},
      input: context.input,
    };
    const site = (label: string) => ({
      commit: context.run.commit,
      blueprintId: context.run.blueprintId,
      label,
      source: templates,
    });
    const title = await renderTemplate(
      context.params["title"],
      values,
      site("Notify title"),
    );
    const message = await renderTemplate(
      context.params["message"] ?? { inline: "" },
      values,
      site("Notify message"),
    );
    const url = context.params["url"];
    if (url !== undefined && typeof url !== "string")
      throw new Error("notify url must resolve to a string");
    return delivery.send({
      title,
      message,
      ...(url === undefined ? {} : { url }),
    });
  };
}
