import type { Channel, Platform } from "./channel.ts";

/** Every built adapter. Loaded on demand so agent CLI calls do not pay for platform SDKs. */
export async function loadChannels(): Promise<Partial<Record<Platform, Channel>>> {
  const [{ telegramChannel }, { feishuChannel }, { wechatChannel }, { wecomChannel }, { dingtalkChannel }] =
    await Promise.all([
      import("./telegram/telegram.ts"),
      import("./feishu/feishu.ts"),
      import("./wechat/wechat.ts"),
      import("./wecom/wecom.ts"),
      import("./dingtalk/dingtalk.ts"),
    ]);
  return {
    telegram: telegramChannel(),
    feishu: feishuChannel(),
    wechat: wechatChannel(),
    wecom: wecomChannel(),
    dingtalk: dingtalkChannel(),
  };
}
