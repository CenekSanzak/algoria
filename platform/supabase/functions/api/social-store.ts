import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import type { Job } from './store.ts';
export type StoredMedia = {
  path: string;
  content_type: string;
  file_size: number;
  duration?: number;
  width?: number;
  height?: number;
};
export type SocialStep = {
  job_id: string;
  name: string;
  state: 'pending' | 'submitting' | 'queued' | 'succeeded' | 'failed' | 'uncertain';
  provider_id: string | null;
  output: StoredMedia | null;
};
export class SocialStore {
  private client;
  constructor(url: string, key: string) {
    this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  start(id: string): Promise<Job> {
    return this.rpc('social_start', { job_id: id });
  }
  async steps(id: string): Promise<SocialStep[]> {
    const { data, error } = await this.client.from('social_steps').select('*').eq('job_id', id).order('name');
    if (error) throw new Error(error.message);
    return data as SocialStep[];
  }
  async parent(providerId: string): Promise<string | undefined> {
    const { data, error } = await this.client.from('social_steps').select('job_id').eq(
      'provider_id',
      providerId,
    ).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.job_id;
  }
  write(
    id: string,
    lease: string,
    name: string,
    state: SocialStep['state'],
    providerId?: string,
    output?: StoredMedia,
  ): Promise<boolean> {
    return this.rpc('social_step_write', {
      job_id: id,
      lease_token: lease,
      step_name: name,
      next_state: state,
      provider_id: providerId ?? null,
      output: output ?? null,
    });
  }
  async active(): Promise<Job[]> {
    const { data, error } = await this.client.from('jobs').select('*').eq('service_id', 'video.social').in(
      'status',
      ['paid', 'queued', 'running', 'saving'],
    ).order('updated_at').limit(2);
    if (error) throw new Error(error.message);
    return data as Job[];
  }
  reserveReference(id: string, tokenHash: string, contentHash: string, path: string) {
    return this.rpc('social_reference_reserve', {
      ref_id: id,
      token_hash: tokenHash,
      content_hash: contentHash,
      path,
    });
  }
  async referencePath(path: string): Promise<boolean> {
    const { data, error } = await this.client.from('social_references').select('id').eq('path', path)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }
}
