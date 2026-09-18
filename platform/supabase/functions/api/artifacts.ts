import type { Config } from './config.ts';

export interface Artifacts {
  put(path: string, bytes: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>;
  signedUrl(path: string, signal?: AbortSignal): Promise<string>;
}

export class SupabaseArtifacts implements Artifacts {
  constructor(private config: Config) {}
  private async request(path: string, init: RequestInit, signal?: AbortSignal) {
    const response = await fetch(`${this.config.supabaseUrl}/storage/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.config.serviceRoleKey,
        authorization: `Bearer ${this.config.serviceRoleKey}`,
        ...init.headers,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Storage request failed: ${response.status}`);
    return response;
  }
  async put(path: string, bytes: Uint8Array, contentType: string, signal?: AbortSignal) {
    await this.request(`object/outputs/${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-upsert': 'true' },
      body: bytes as BodyInit,
    }, signal);
  }
  async signedUrl(path: string, signal?: AbortSignal) {
    const response = await this.request(`object/sign/outputs/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 }),
    }, signal);
    const data = await response.json();
    if (typeof data.signedURL !== 'string') throw new Error('Storage signing failed');
    return `${this.config.supabaseUrl}/storage/v1${data.signedURL}`;
  }
}
