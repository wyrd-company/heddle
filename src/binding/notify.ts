// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { blueprintContext } from "../blueprints/flowcraft.js";
import type { Data, EngineNode } from "../engine/types.js";

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

function template(value: unknown, context: Data, name: string): string {
  const inline =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Data)["inline"] === "string"
      ? String((value as Data)["inline"])
      : value;
  if (typeof inline !== "string")
    throw new Error(`notify requires a ${name} template`);
  return inline.replaceAll(
    /\{\{\s*([A-Za-z][\w-]*)\s*\}\}/gu,
    (_match, key: string) => {
      const result = context[key];
      if (result === undefined)
        throw new Error(`notify template value is unavailable: ${key}`);
      return typeof result === "string" ? result : JSON.stringify(result);
    },
  );
}

export function notifyNode(delivery: NotificationDelivery): EngineNode {
  return async (context) => {
    const values = {
      ...context.context,
      blueprint: blueprintContext(context.run.blueprint),
    };
    const title = template(context.params["title"], values, "title");
    const message = template(
      context.params["message"] ?? { inline: "" },
      values,
      "message",
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
