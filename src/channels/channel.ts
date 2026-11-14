/**
 * The contract every IM adapter implements. The core only knows these types;
 * platform SDKs stay inside `src/channels/<platform>/`.
 *
 * Design rules (docs/spec.md section 6):
 * - Semantics here, presentation in the adapter.
 * - Capabilities are reported per bot instance, not assumed per platform.
 * - An adapter never throws for "the platform cannot do this": it degrades and says so.
 */

export type Platform =
  | "wechat"
  | "wecom"
  | "feishu"
  | "dingtalk"
  | "qq"
  | "slack"
  | "discord"
  | "telegram"
  | "imessage"
  | "github";

export type ChatKind = "dm" | "group" | "thread";

/** What this bot instance can actually do right now, given its granted permissions. */
export interface Capabilities {
  readonly quoteReply: boolean;
  readonly reactions: boolean;
  readonly typingIndicator: boolean;
  readonly fileUpload: boolean;
  readonly fileDownload: boolean;
  readonly listMembers: boolean;
  /** Largest text body one message can carry; longer bodies are split by the core. */
  readonly maxTextLength: number;
}

// ---------------------------------------------------------------- onboarding

/** How a user connects a bot on this platform. Drives the console's connect screen. */
export type OnboardingMethod =
  /** `desktopLink`: the QR's link also works when opened in a signed-in browser on this computer. */
  | { readonly kind: "qr"; readonly desktopLink?: boolean }
  /** A code the person enters on the platform's site while signed in as the bot's account (OAuth device flow). */
  | { readonly kind: "device" }
  | {
      readonly kind: "credentials";
      readonly fields: readonly CredentialField[];
      /** Where to create the bot, prefilled where the platform allows. `__MINGLE_AGENT_NAME__` becomes the agent's name, `__MINGLE_AGENT_HANDLE__` a lowercase handle made from it. */
      readonly setupUrl?: string;
    };

export interface CredentialField {
  readonly key: string;
  /** Message-catalog key for the label, not display text. */
  readonly labelKey: string;
  readonly secret: boolean;
}

/**
 * Something on this computer the person sets up before a channel can connect (iMessage: macOS
 * permissions), checked live while the connect screen is open. Checks never prompt the person.
 */
export interface SetupCheck {
  readonly id: string;
  /**
   * ok: done. missing: not done yet. denied: refused before, so only System Settings can change it.
   * unknown: cannot tell until an earlier check passes.
   */
  readonly state: "ok" | "missing" | "denied" | "unknown";
}

export interface ChannelSetup {
  check(): Promise<{
    readonly checks: readonly SetupCheck[];
    /** The app macOS grants the permissions to, as the person sees it in System Settings ("Mingle", "Terminal"). */
    readonly app?: string;
  }>;
  /** One step the person asked for from the console: open a settings pane, or ask for a permission now. */
  act(action: string): Promise<void>;
  readonly actions: readonly string[];
}

export type OnboardingEvent =
  | { readonly kind: "qr_ready"; readonly qrContent: string; readonly expiresAt: number }
  | { readonly kind: "scanned" }
  /** Device flow: the person enters `userCode` at `verificationUri`; the adapter waits for them. */
  | {
      readonly kind: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
    }
  /** The platform wants a code typed on this computer (shown on the phone). Answer through `context.awaitCode`. */
  | { readonly kind: "needs_code"; readonly retry?: boolean }
  | { readonly kind: "awaiting_approval"; readonly detailKey?: string }
  | {
      readonly kind: "succeeded";
      readonly credentials: Credentials;
      readonly bot: BotIdentity;
      /** The person who scanned, when the platform reports it. They become the bot's owner. */
      readonly ownerId?: string;
      /** The bot exists but an admin still has to approve or enable it. */
      readonly pendingApproval?: boolean;
    }
  | { readonly kind: "failed"; readonly code: OnboardingFailure };

export interface OnboardingContext {
  /** Used to name the bot where the platform lets us suggest one. */
  readonly agentName?: string;
  /** Resolves with the code the user types in the console after a `needs_code` event. */
  readonly awaitCode?: () => Promise<string>;
  /**
   * Credentials of this platform's bots already connected on this computer, newest first. Lets a
   * platform recognize a rebind instead of treating every scan as a new client. Read only on demand.
   */
  readonly knownCredentials?: () => Promise<readonly Credentials[]>;
}

export type OnboardingFailure =
  | "expired"
  | "denied"
  | "cancelled"
  | "invalid_credentials"
  /** The credentials work but lack a permission Mingle needs (a token without the right scopes). */
  | "insufficient_scope"
  | "network"
  | "already_bound"
  /** The platform says this account's bot is already connected here, to this computer's Mingle. */
  | "already_connected"
  /** The app or system denied something only the person can grant (macOS privacy settings, for example). */
  | "permission_missing"
  /** The app the channel drives is not signed in (Messages without iMessage, for example). */
  | "not_signed_in"
  | "unknown";

/** Opaque to the core. Stored in the system keychain, never in SQLite or logs. */
export type Credentials = Readonly<Record<string, string>>;

export interface BotIdentity {
  readonly id: string;
  readonly name: string;
}

// ----------------------------------------------------------------- lifecycle

export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "awaiting_approval" }
  | { readonly kind: "error"; readonly code: "credentials_revoked" | "permission_missing" | "network" | "unknown" };

// ----------------------------------------------------------------- messaging

export interface ChatRef {
  /** Platform chat id; for a thread or topic, the adapter encodes both ids here. */
  readonly platformId: string;
  readonly kind: ChatKind;
  readonly name?: string;
  /**
   * For a thread: the group it belongs to, where the adapter stores the messages around it
   * that were not addressed to the bot. The agent reads them there (docs/spec.md 4.2).
   */
  readonly parent?: { readonly platformId: string; readonly name?: string };
}

export interface Sender {
  readonly id: string;
  readonly name: string;
  readonly isBot: boolean;
}

export interface InboundAttachment {
  /** Handle the adapter can later resolve to bytes. */
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly mime?: string;
}

export interface InboundMessage {
  readonly platformId: string;
  readonly chat: ChatRef;
  readonly sender: Sender;
  /** Plain text with the bot's own mention removed and other mentions rendered as @name. */
  readonly text: string;
  readonly attachments: readonly InboundAttachment[];
  /** Platform id of the message this one quotes or replies to. */
  readonly replyTo?: string;
  /** True when the bot was @-mentioned, or the message replies to one the bot sent. */
  readonly addressedToBot: boolean;
  readonly sentAt: number;
}

export interface OutboundMessage {
  readonly chat: ChatRef;
  /** Markdown. The adapter renders it the platform's way. */
  readonly text: string;
  /** Platform id of the message to quote. Ignored, and reported, where unsupported. */
  readonly replyTo?: string;
  readonly files?: readonly { readonly path: string; readonly name?: string }[];
}

export type SendResult =
  | { readonly kind: "sent"; readonly platformId: string; readonly degraded?: readonly Degradation[] }
  /** The platform refused. `retryable` says whether trying again can help. */
  | {
      readonly kind: "failed";
      readonly code: "rate_limited" | "forbidden" | "too_large" | "chat_gone" | "network" | "unknown";
      readonly retryable: boolean;
      /** The platform's own error code, for the agent and the owner to act on. Never a secret. */
      readonly detail?: string;
      /**
       * The text is out and only the files failed. A retry must send the files alone, or the
       * person sees the text twice. `platformId` is the text's message.
       */
      readonly textSent?: { readonly platformId: string };
    }
  /** The request left but no answer came back. Never retried automatically. */
  | { readonly kind: "uncertain" };

/** A failure after the text went out: mark it so retries send the files alone. */
export function withTextSent(result: SendResult, textPlatformId: string): SendResult {
  return textPlatformId && result.kind === "failed" ? { ...result, textSent: { platformId: textPlatformId } } : result;
}

export type Degradation = "quote_dropped" | "files_dropped" | "markdown_flattened" | "text_split";

// ------------------------------------------------------------------- adapter

export interface ChannelEvents {
  onMessage(message: InboundMessage): void;
  onState(state: ConnectionState): void;
  /** The bot was added to or removed from a chat. */
  onMembership(change: { readonly chat: ChatRef; readonly joined: boolean }): void;
}

export type ReactionState = "processing" | "done" | "error" | "none";

export interface LiveOptions {
  /** Platform ID of the message being answered. */
  readonly replyTo: string;
  /** Platform user ID to @-mention in the final answer (groups). */
  readonly mention?: string;
  /** First content, shown at once. Markdown. */
  readonly initial: string;
}

export interface LiveReply {
  /** Replace the progress content. Markdown. Best effort. */
  update(markdown: string): Promise<void>;
  /** Replace the content with the final answer and close the reply. */
  finish(markdown: string): Promise<SendResult>;
}

/** One adapter instance per platform. Stateless across bots. */
export interface Channel {
  readonly platform: Platform;
  readonly onboarding: OnboardingMethod;
  /** For QR platforms: fields for binding an existing app by hand instead of scanning. */
  readonly manualFields?: readonly CredentialField[];
  /** Where to create the app for `manualFields` on the platform's developer site. */
  readonly manualSetupUrl?: string;
  /** Local prerequisites the console checks live before connecting. */
  readonly setup?: ChannelSetup;
  /** Where the owner adds a connected bot to a server or group, for platforms where that is a separate step. */
  inviteUrl?(bot: BotIdentity): string;

  /** Start connecting a new bot. Yields progress until `succeeded` or `failed`. */
  onboard(
    input: Credentials | undefined,
    signal: AbortSignal,
    context?: OnboardingContext,
  ): AsyncIterable<OnboardingEvent>;

  /** Open a live connection for one bot. */
  connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection>;
}

/** A live connection for one bot. */
export interface ChannelConnection {
  readonly bot: BotIdentity;
  /** Talks only in the owner's own chat (iMessage self-chat): no groups, nobody else. */
  readonly ownerOnly?: boolean;
  capabilities(): Capabilities;

  send(message: OutboundMessage): Promise<SendResult>;
  /**
   * The reaction on the person's message: processing while the agent works, done once
   * it answers, error if the turn failed, none to clear it. Best effort; never throws.
   */
  react(chat: ChatRef, platformMessageId: string, state: ReactionState): Promise<void>;
  /**
   * Open a reply that can be rewritten in place (a streaming card, or a message edited
   * as progress comes in). Absent where the platform cannot edit what it sent.
   */
  startLive?(chat: ChatRef, options: LiveOptions): Promise<LiveReply>;
  /** Best effort; never throws. */
  setTyping(chat: ChatRef, typing: boolean): Promise<void>;

  download(attachment: InboundAttachment, toPath: string): Promise<void>;
  /** Open a direct conversation with a user by sending the first message. Where the platform allows it. */
  messageUser?(userId: string, text: string): Promise<void>;
  listMembers(chat: ChatRef): Promise<readonly Sender[]>;

  close(): Promise<void>;
}
