export const MOLTNET_MACHINE_VERSION = "moltnet.machine.v1";
/** SHA-256 of Moltnet 4231bb0's canonical machine-contract artifact. */
export const MOLTNET_MACHINE_CONTRACT_SHA256 = "1ed6bdc3a9600fd5fc55052d4ba20d1c3d13a7e37daf0465b4543ff5bc5cc64d";
export const MOLTNET_MACHINE_MAX_LINE_BYTES = 16_384;
export const MOLTNET_MACHINE_MAX_ACTIVE_REQUESTS = 512;

export type MoltnetMachineOperation = "send_nudge" | "read" | "cancel";
export type MoltnetMachineTarget = Readonly<{ kind: "room" | "dm"; id: string }>;

export type MoltnetMachineSendNudge = Readonly<{
  delivery_id: string;
  target: MoltnetMachineTarget;
  body: string;
  origin_message_id?: string;
  cause_event_ids?: readonly string[];
}>;
export type MoltnetMachineRead = Readonly<{
  target: MoltnetMachineTarget;
  limit: number;
  before?: string;
  after?: string;
}>;
export type MoltnetMachineCancel = Readonly<{ target_correlation_id: string }>;

export type MoltnetMachineRequest = Readonly<{
  version: typeof MOLTNET_MACHINE_VERSION;
  correlation_id: string;
  operation: MoltnetMachineOperation;
  send_nudge?: MoltnetMachineSendNudge;
  read?: MoltnetMachineRead;
  cancel?: MoltnetMachineCancel;
}>;

export type MoltnetMachineErrorCode =
  | "invalid_request" | "duplicate_request" | "unsupported" | "not_found"
  | "conflict" | "capacity" | "transport" | "canceled";
export type MoltnetMachineTerminal = Readonly<{
  version: typeof MOLTNET_MACHINE_VERSION;
  correlation_id: string;
  operation: MoltnetMachineOperation;
  send_nudge?: Readonly<Record<string, unknown>>;
  read?: Readonly<Record<string, unknown>>;
  cancel?: Readonly<Record<string, unknown>>;
  error?: Readonly<{ code: MoltnetMachineErrorCode }>;
}>;

export class MoltnetMachineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MoltnetMachineError";
  }
}
