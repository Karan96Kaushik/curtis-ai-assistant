export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MessageRole = 'user' | 'assistant' | 'error';

export type ScheduledJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ScheduledJobRunStatus = 'running' | 'succeeded' | 'failed';

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
          cancel_turn_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          title?: string;
          agent_history?: Json;
          pending_action?: Json | null;
          cancel_turn_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          title?: string;
          agent_history?: Json;
          pending_action?: Json | null;
          cancel_turn_id?: string | null;
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
      notifications: {
        Row: {
          id: number;
          user_id: string;
          local_id: number | null;
          device_id: string | null;
          package_name: string | null;
          app_name: string | null;
          title: string | null;
          text: string | null;
          sub_text: string | null;
          big_text: string | null;
          category: string | null;
          posted_at: number | string | null;
          created_at: number | string | null;
        };
        Insert: {
          user_id: string;
          local_id?: number | null;
          device_id?: string | null;
          package_name?: string | null;
          app_name?: string | null;
          title?: string | null;
          text?: string | null;
          sub_text?: string | null;
          big_text?: string | null;
          category?: string | null;
          posted_at?: number | string | null;
          created_at?: number | string | null;
        };
        Update: {
          local_id?: number | null;
          device_id?: string | null;
          package_name?: string | null;
          app_name?: string | null;
          title?: string | null;
          text?: string | null;
          sub_text?: string | null;
          big_text?: string | null;
          category?: string | null;
          posted_at?: number | string | null;
          created_at?: number | string | null;
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
      scheduled_jobs: {
        Row: {
          id: string;
          user_id: string;
          conversation_id: string;
          prompt: string;
          run_at: string;
          cron: string | null;
          timezone: string;
          model: string | null;
          status: ScheduledJobStatus;
          last_error: string | null;
          locked_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          conversation_id: string;
          prompt: string;
          run_at: string;
          cron?: string | null;
          timezone?: string;
          model?: string | null;
          status?: ScheduledJobStatus;
          last_error?: string | null;
          locked_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          status?: 'cancelled';
          updated_at?: string;
        };
        Relationships: [];
      };
      scheduled_job_runs: {
        Row: {
          id: string;
          job_id: string;
          user_id: string;
          status: ScheduledJobRunStatus;
          started_at: string;
          finished_at: string | null;
          reply: string | null;
          error: string | null;
          push_sent: number;
          push_failed: number;
        };
        Insert: {
          id?: string;
          job_id: string;
          user_id: string;
          status: ScheduledJobRunStatus;
          started_at?: string;
          finished_at?: string | null;
          reply?: string | null;
          error?: string | null;
          push_sent?: number;
          push_failed?: number;
        };
        Update: never;
        Relationships: [];
      };
      device_tokens: {
        Row: {
          user_id: string;
          token: string;
          platform: 'android' | 'ios' | 'web';
          device_id: string | null;
          updated_at: string;
        };
        Insert: {
          user_id?: string;
          token: string;
          platform?: 'android' | 'ios' | 'web';
          device_id?: string | null;
          updated_at?: string;
        };
        Update: {
          platform?: 'android' | 'ios' | 'web';
          device_id?: string | null;
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
export type DeviceTokenRow = Tables['device_tokens']['Row'];
export type ScheduledJobRow = Tables['scheduled_jobs']['Row'];
export type ScheduledJobRunRow = Tables['scheduled_job_runs']['Row'];

