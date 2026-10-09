export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MessageRole = 'user' | 'assistant' | 'error';

export interface Database {
  public: {
    Tables: {
      conversations: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          agent_history: Json;
          pending_action: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          title?: string;
          agent_history?: Json;
          pending_action?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          title?: string;
          agent_history?: Json;
          pending_action?: Json | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          user_id: string;
          role: MessageRole;
          content: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          user_id?: string;
          role: MessageRole;
          content: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_files: {
        Row: {
          user_id: string;
          path: string;
          content: string;
          updated_at: string;
        };
        Insert: {
          user_id?: string;
          path: string;
          content: string;
          updated_at?: string;
        };
        Update: {
          content?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      contexts: {
        Row: {
          user_id: string;
          slug: string;
          title: string;
          kind: 'reference' | 'behavior';
          content: string;
          updated_at: string;
        };
        Insert: {
          user_id?: string;
          slug: string;
          title: string;
          kind: 'reference' | 'behavior';
          content?: string;
          updated_at?: string;
        };
        Update: {
          title?: string;
          kind?: 'reference' | 'behavior';
          content?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}

type Tables = Database['public']['Tables'];

export type ConversationRow = Tables['conversations']['Row'];
export type ConversationSummary = Pick<ConversationRow, 'id' | 'title' | 'updated_at'>;
export type MessageRow = Tables['messages']['Row'];
export type ChatMessage = Pick<MessageRow, 'id' | 'conversation_id' | 'role' | 'content' | 'created_at'>;
export type AgentFileRow = Tables['agent_files']['Row'];
export type ContextRow = Tables['contexts']['Row'];
