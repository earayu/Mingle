/**
 * The contract every IM adapter implements. The core only knows these types;
 * platform SDKs stay inside `src/channels/<platform>/`.
 *
 * Design rules (docs/spec.md section 6):
 * - Semantics here, presentation in the adapter.
 * - Capabilities are reported per bot instance, not assumed per platform.
 * - An adapter never throws for "the platform cannot do this": it degrades and says so.
 */

export type Platform = "feishu" | "dingtalk" | "wecom" | "slack" | "discord" | "telegram";

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
  | { readonly kind: "qr" }
  | { readonly kind: "credentials"; readonly fields: readonly CredentialField[] };

export interface CredentialField {
  readonly key: string;
  /** Message-catalog key for the label, not display text. */
  readonly labelKey: string;
  readonly secret: boolean;
}

export type OnboardingEvent =
  | { readonly kind: "qr_ready"; readonly qrContent: string; readonly expiresAt: number }
  | { readonly kind: "scanned" }
  | { readonly kind: "awaiting_approval"; readonly detailKey?: string }
  | { readonly kind: "succeeded"; readonly credentials: Credentials; readonly bot: BotIdentity }
  | { readonly kind: "failed"; readonly code: OnboardingFailure };

export type OnboardingFailure = "expired" | "denied" | "cancelled" | "invalid_credentials" | "network" | "unknown";

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
    }
  /** The request left but no answer came back. Never retried automatically. */
  | { readonly kind: "uncertain" };

export type Degradation = "quote_dropped" | "files_dropped" | "markdown_flattened" | "text_split";

// ------------------------------------------------------------------- adapter

export interface ChannelEvents {
  onMessage(message: InboundMessage): void;
  onState(state: ConnectionState): void;
  /** The bot was added to or removed from a chat. */
  onMembership(change: { readonly chat: ChatRef; readonly joined: boolean }): void;
}

/** One adapter instance per platform. Stateless across bots. */
export interface Channel {
  readonly platform: Platform;
  readonly onboarding: OnboardingMethod;

  /** Start connecting a new bot. Yields progress until `succeeded` or `failed`. */
  onboard(input: Credentials | undefined, signal: AbortSignal): AsyncIterable<OnboardingEvent>;

  /** Open a live connection for one bot. */
  connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection>;
}

/** A live connection for one bot. */
export interface ChannelConnection {
  readonly bot: BotIdentity;
  capabilities(): Capabilities;

  send(message: OutboundMessage): Promise<SendResult>;
  /** Receipt shown the moment a message is stored. Best effort; never throws. */
  acknowledge(chat: ChatRef, platformMessageId: string): Promise<void>;
  /** Best effort; never throws. */
  setTyping(chat: ChatRef, typing: boolean): Promise<void>;

  download(attachment: InboundAttachment, toPath: string): Promise<void>;
  listMembers(chat: ChatRef): Promise<readonly Sender[]>;

  close(): Promise<void>;
}
