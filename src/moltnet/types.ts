export interface MoltnetRoomMessage {
  id: string;
  network_id?: string;
  origin?: { network_id: string; message_id: string };
  target?: {
    kind: string;
    room_id?: string;
    thread_id?: string;
    parent_message_id?: string;
    dm_id?: string;
    participant_ids?: string[];
  };
  from: { id: string; type?: string; name?: string; network_id?: string; fqid?: string };
  parts: { kind: string; text?: string; url?: string; data?: unknown; filename?: string; media_type?: string }[];
  mentions?: string[];
  created_at?: string;
}
