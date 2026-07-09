// Minimal mock of matrix-js-sdk for Jest (CJS) test environment.
// The real package is pure ESM and cannot be required() by ts-jest directly.
// Tests mock the MatrixClient as `{} as any` so no real implementation is needed here.

export class MatrixClient {
  async initRustCrypto(_opts?: unknown): Promise<void> {}
  getCrypto(): { globalBlacklistUnverifiedDevices: boolean; getVersion(): string } | undefined {
    return { globalBlacklistUnverifiedDevices: false, getVersion: () => "mock" };
  }
}
export class MatrixEvent {}
export class MemoryStore {}
export class Room {}

export const MsgType = {
  Text: "m.text",
  Image: "m.image",
  Audio: "m.audio",
  Video: "m.video",
  File: "m.file",
  Notice: "m.notice",
  Emote: "m.emote",
  Location: "m.location",
} as const;

export const EventType = {
  RoomMessage: "m.room.message",
  RoomMember: "m.room.member",
} as const;

export const KnownMembership = {
  Invite: "invite",
  Join: "join",
  Leave: "leave",
  Ban: "ban",
} as const;

export const ClientEvent = {
  Sync: "sync",
} as const;

export const RoomEvent = {
  Timeline: "Room.timeline",
  MyMembership: "Room.myMembership",
} as const;

export const SyncState = {
  Prepared: "PREPARED",
  Syncing: "SYNCING",
  Error: "ERROR",
  Stopped: "STOPPED",
} as const;

export function createClient(_opts: unknown): MatrixClient {
  return new MatrixClient();
}

export function setLogLevel(_level: string): void {}
