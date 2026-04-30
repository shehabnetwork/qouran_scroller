import { Injectable } from '@angular/core';
import { AuthChangeEvent, Session, SupabaseClient, createClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment';

export interface DbPreferences {
    user_id: string;
    mode: string;
    from_juz: number;
    to_juz: number;
    from_surah: number;
    to_surah: number;
    ayah: number;
}

export interface DbReading {
    id: string;
    name: string;
    start_index: number;
    end_index: number;
    created_at: string;
}

interface ScopeData {
    mode: string;
    fromJuz: number;
    toJuz: number;
    fromSurah: number;
    toSurah: number;
    ayah: number;
}

@Injectable({ providedIn: 'root' })
export class SupabaseService {
    private readonly client: SupabaseClient;

    constructor() {
        this.client = createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
            auth: {
                // Zone.js (Angular) patches navigator.locks in a way that breaks Supabase's
                // lock-based session storage. Bypassing the lock is safe for a single-tab SPA.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                lock: <R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>) => fn(),
            },
        });
    }

    signUp(email: string, password: string, name?: string) {
        return this.client.auth.signUp({
            email,
            password,
            options: { data: { full_name: name || email.split('@')[0] } },
        });
    }

    signIn(email: string, password: string) {
        return this.client.auth.signInWithPassword({ email, password });
    }

    signInWithGoogle() {
        return this.client.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin },
        });
    }

    signOut() {
        return this.client.auth.signOut();
    }

    getSession() {
        return this.client.auth.getSession();
    }

    onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void) {
        return this.client.auth.onAuthStateChange(callback);
    }

    async getPreferences(userId: string): Promise<{ data: DbPreferences | null; error: unknown }> {
        const result = await this.client
            .from('user_preferences')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
        return result as { data: DbPreferences | null; error: unknown };
    }

    upsertPreferences(userId: string, prefs: ScopeData) {
        return this.client.from('user_preferences').upsert(
            {
                user_id: userId,
                mode: prefs.mode,
                from_juz: prefs.fromJuz,
                to_juz: prefs.toJuz,
                from_surah: prefs.fromSurah,
                to_surah: prefs.toSurah,
                ayah: prefs.ayah,
            },
            { onConflict: 'user_id' },
        );
    }

    async getReadingHistory(userId: string): Promise<{ data: DbReading[] | null; error: unknown }> {
        const result = await this.client
            .from('reading_history')
            .select('id, name, start_index, end_index, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        return result as { data: DbReading[] | null; error: unknown };
    }

    async saveReading(
        userId: string,
        name: string,
        startIndex: number,
        endIndex: number,
    ): Promise<{ data: DbReading | null; error: unknown }> {
        const result = await this.client
            .from('reading_history')
            .insert({ user_id: userId, name, start_index: startIndex, end_index: endIndex })
            .select('id, name, start_index, end_index, created_at')
            .single();
        return result as { data: DbReading | null; error: unknown };
    }

    deleteReading(id: string) {
        return this.client.from('reading_history').delete().eq('id', id);
    }
}
