export interface MessageRow {
  rowid: number;
  messageIdHeader: string | null;
  subject: string | null;
  sender: string | null;
  mailboxUrl: string;
  dateReceived: number;
  dateSent: number | null;
  read: boolean;
  flagged: boolean;
  size: number;
  conversationId: number;
  attachmentCount: number;
}

export interface MailboxRow {
  rowid: number;
  url: string;
  accountId: string;
  name: string;
  totalCount: number;
  unreadCount: number;
}

export interface SearchFilter {
  mailboxUrl?: string;
  from?: string;
  recipient?: string;
  subject?: string;
  since?: number;
  until?: number;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  hasAttachments?: boolean;
  limit?: number;
}
