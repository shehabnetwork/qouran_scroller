import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JUZ_BOUNDARIES, QURAN_SOURCE, QURAN_VERSES, QuranVerse, SURAHS, SurahInfo } from './data/quran-data';

type ScopeMode = 'all' | 'juz' | 'surah' | 'ayah';
type AppScreen = 'reader' | 'login' | 'register' | 'range' | 'save' | 'history';
type ReaderPanel = 'jump' | 'range' | null;

interface ScopePreference {
  mode: ScopeMode;
  fromJuz: number;
  toJuz: number;
  fromSurah: number;
  toSurah: number;
  ayah: number;
}

interface AuthUser {
  id: string;
  name: string;
  email: string;
}

interface AuthResponse {
  token: string;
  user: AuthUser;
}

interface PublicConfig {
  googleClientId: string;
  googleRedirectEnabled: boolean;
}

interface GoogleCredentialResponse {
  credential: string;
  select_by?: string;
}

interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize: (configuration: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
        use_fedcm_for_button?: boolean;
        button_auto_select?: boolean;
      }) => void;
      renderButton: (parent: HTMLElement, options: Record<string, string | number | boolean>) => void;
      disableAutoSelect: () => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

interface ReadingHistory {
  id: string;
  name: string;
  startIndex: number;
  endIndex: number;
  createdAt: string;
}

interface VersePanel {
  id: string;
  surah: SurahInfo | undefined;
  juz: number;
  quarter: number;
  startsAtOpening: boolean;
  verses: QuranVerse[];
}

const DEFAULT_SCOPE: ScopePreference = {
  mode: 'all',
  fromJuz: 1,
  toJuz: 30,
  fromSurah: 1,
  toSurah: 114,
  ayah: 1,
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly apiBase = 'http://localhost:5037/api';
  private readonly pageSize = 5;

  protected readonly source = QURAN_SOURCE;
  protected readonly surahs = SURAHS;
  protected readonly verses = QURAN_VERSES;
  protected readonly juzs = Array.from({ length: 30 }, (_, index) => index + 1);
  protected readonly currentScreen = signal<AppScreen>('reader');
  protected readonly menuOpen = signal(false);
  protected readonly authMode = signal<'login' | 'register'>('login');
  protected readonly user = signal<AuthUser | null>(null);
  protected readonly histories = signal<ReadingHistory[]>([]);
  protected readonly scope = signal<ScopePreference>({ ...DEFAULT_SCOPE });
  protected readonly startIndex = signal(0);
  protected readonly visibleCount = signal(this.pageSize);
  protected readonly selectedVerseIndex = signal<number | null>(null);
  protected readonly selectedRangeStartIndex = signal(0);
  protected readonly selectedRangeEndIndex = signal(this.pageSize - 1);
  protected readonly busy = signal(false);
  protected readonly authMessage = signal('');
  protected readonly saveMessage = signal('');
  protected readonly googleClientId = signal('');
  protected readonly googleRedirectEnabled = signal(false);
  protected readonly googleMessage = signal('');
  protected readonly readerPanel = signal<ReaderPanel>(null);

  protected authForm = {
    name: '',
    email: '',
    password: '',
  };

  protected jumpForm = {
    surah: 1,
    ayah: 1,
  };

  protected historyName = '';
  private googleInitialized = false;
  private rangeEndPinned = false;
  private sessionStarted = false;
  private loadingPrevious = false;
  private readerScrollY = 0;

  protected readonly visibleVerses = computed(() => {
    const start = this.startIndex();
    return QURAN_VERSES.slice(start, Math.min(start + this.visibleCount(), QURAN_VERSES.length));
  });

  protected readonly versePanels = computed<VersePanel[]>(() => {
    const panels: VersePanel[] = [];

    for (const verse of this.visibleVerses()) {
      const previousPanel = panels.at(-1);
      const previousVerse = previousPanel?.verses.at(-1);
      const startsPanel =
        !previousPanel || !previousVerse || previousVerse.surah !== verse.surah || previousVerse.quarter !== verse.quarter;

      if (startsPanel) {
        panels.push({
          id: `${verse.surah}-${verse.ayah}-${verse.quarter}`,
          surah: this.findSurah(verse.surah),
          juz: verse.juz,
          quarter: verse.quarter,
          startsAtOpening: verse.index === this.startIndex(),
          verses: [verse],
        });
        continue;
      }

      previousPanel.verses.push(verse);
    }

    return panels;
  });

  protected readonly openingVerse = computed(() => QURAN_VERSES[this.startIndex()]);
  protected readonly latestVerse = computed(() => this.visibleVerses().at(-1) ?? this.openingVerse());
  protected readonly rangeStartVerse = computed(() => QURAN_VERSES[this.selectedRangeStartIndex()]);
  protected readonly rangeEndVerse = computed(() => QURAN_VERSES[this.selectedRangeEndIndex()]);

  protected readonly selectedSurah = computed(() => this.findSurah(this.scope().fromSurah));
  protected readonly maxAyahForSelectedSurah = computed(() => this.selectedSurah()?.ayahCount ?? 1);

  ngOnInit(): void {
    if (this.handleRedirectLoginResult()) {
      return;
    }

    this.loadPublicConfig();

    const token = this.token;
    if (!token) {
      this.openRandomVerse();
      return;
    }

    this.fetchMe();
    this.loadPreferencesAndHistory();
  }

  @HostListener('window:scroll')
  protected onScroll(): void {
    if (this.currentScreen() !== 'reader') {
      return;
    }

    const nearTop = window.scrollY < 300;
    if (nearTop) {
      this.loadPrevious(true);
    }

    const nearBottom = window.innerHeight + window.scrollY > document.body.offsetHeight - 900;
    if (nearBottom) {
      this.loadMore();
    }
  }

  protected submitAuth(): void {
    this.busy.set(true);
    this.authMessage.set('');

    const endpoint = this.authMode() === 'login' ? 'login' : 'register';
    this.http.post<AuthResponse>(`${this.apiBase}/auth/${endpoint}`, this.authForm).subscribe({
      next: (response) => {
        localStorage.setItem('quran-scroll-token', response.token);
        this.user.set(response.user);
        this.authForm.password = '';
        this.authMessage.set('تم تسجيل الدخول.');
        this.closeMenu();
        this.showReader();
        this.loadPreferencesAndHistory();
      },
      error: () => {
        this.authMessage.set('تعذر تسجيل الدخول. تحقق من البريد وكلمة المرور.');
        this.busy.set(false);
      },
      complete: () => this.busy.set(false),
    });
  }

  protected signInWithGoogleCredential(credential: string): void {
    this.busy.set(true);
    this.googleMessage.set('');

    this.http.post<AuthResponse>(`${this.apiBase}/auth/google`, { credential }).subscribe({
      next: (response) => {
        localStorage.setItem('quran-scroll-token', response.token);
        this.user.set(response.user);
        this.authForm.password = '';
        this.googleMessage.set('تم تسجيل الدخول بحساب Google.');
        this.closeMenu();
        this.showReader();
        this.loadPreferencesAndHistory();
      },
      error: () => {
        this.googleMessage.set('تعذر تسجيل الدخول بحساب Google.');
        this.busy.set(false);
      },
      complete: () => this.busy.set(false),
    });
  }

  protected startGoogleRedirect(): void {
    window.location.href = `${this.apiBase}/auth/google/start`;
  }

  protected logout(): void {
    localStorage.removeItem('quran-scroll-token');
    this.user.set(null);
    this.histories.set([]);
    this.authMessage.set('');
    this.currentScreen.set('reader');
    this.closeMenu();
  }

  protected updateScope<K extends keyof ScopePreference>(key: K, value: ScopePreference[K]): void {
    const next = { ...this.scope(), [key]: value };

    if (key === 'fromSurah' && next.toSurah < next.fromSurah) {
      next.toSurah = next.fromSurah;
    }

    if (key === 'fromJuz' && next.toJuz < next.fromJuz) {
      next.toJuz = next.fromJuz;
    }

    if (key === 'fromSurah') {
      next.ayah = Math.min(next.ayah, this.findSurah(next.fromSurah)?.ayahCount ?? 1);
    }

    this.scope.set(this.normalizeScope(next));
  }

  protected openRandomVerse(savePreference = false): void {
    const index = this.randomIndexForScope(this.scope());
    this.openAt(index);
    this.currentScreen.set('reader');
    this.closeMenu();

    if (savePreference && this.user()) {
      this.savePreferences();
    }
  }

  protected loadMore(): void {
    const oldLatest = this.latestVerse();
    const remaining = QURAN_VERSES.length - this.startIndex() - this.visibleCount();
    if (remaining <= 0) {
      return;
    }

    this.visibleCount.set(this.visibleCount() + Math.min(this.pageSize, remaining));
    if (!this.rangeEndPinned && this.selectedRangeEndIndex() === oldLatest.index) {
      this.selectedRangeEndIndex.set(this.latestVerse().index);
    }
  }

  protected loadPrevious(preserveScroll = false): void {
    const currentStart = this.startIndex();
    if (currentStart <= 0 || this.loadingPrevious) {
      return;
    }

    this.loadingPrevious = true;
    const added = Math.min(this.pageSize, currentStart);
    const oldHeight = document.body.scrollHeight;

    this.startIndex.set(currentStart - added);
    this.visibleCount.set(this.visibleCount() + added);

    queueMicrotask(() => {
      if (preserveScroll) {
        window.scrollTo({ top: window.scrollY + document.body.scrollHeight - oldHeight, behavior: 'auto' });
      }
      this.loadingPrevious = false;
    });
  }

  protected updateJumpSurah(surah: number): void {
    this.jumpForm.surah = this.clamp(Number(surah) || 1, 1, 114);
    this.jumpForm.ayah = this.clamp(this.jumpForm.ayah, 1, this.maxAyahForJumpSurah());
  }

  protected updateJumpAyah(ayah: number): void {
    this.jumpForm.ayah = this.clamp(Number(ayah) || 1, 1, this.maxAyahForJumpSurah());
  }

  protected maxAyahForJumpSurah(): number {
    return this.findSurah(this.jumpForm.surah)?.ayahCount ?? 1;
  }

  protected goToJumpVerse(): void {
    this.openAt(this.indexForSurahAyah(this.jumpForm.surah, this.jumpForm.ayah));
    this.currentScreen.set('reader');
    this.readerPanel.set(null);
    this.closeMenu();
  }

  protected selectVerse(verse: QuranVerse): void {
    this.selectedVerseIndex.set(verse.index);
  }

  protected setRangeStartHere(verse: QuranVerse, event?: MouseEvent): void {
    event?.stopPropagation();
    this.selectedRangeStartIndex.set(verse.index);
    if (this.selectedRangeEndIndex() < verse.index) {
      this.selectedRangeEndIndex.set(verse.index);
      this.rangeEndPinned = true;
    }
    this.selectedVerseIndex.set(verse.index);
  }

  protected setRangeEndHere(verse: QuranVerse, event?: MouseEvent): void {
    event?.stopPropagation();
    if (verse.index < this.selectedRangeStartIndex()) {
      this.selectedRangeStartIndex.set(verse.index);
    }
    this.selectedRangeEndIndex.set(verse.index);
    this.rangeEndPinned = true;
    this.selectedVerseIndex.set(verse.index);
  }

  protected isRangeStart(verse: QuranVerse): boolean {
    return verse.index === this.selectedRangeStartIndex();
  }

  protected isRangeEnd(verse: QuranVerse): boolean {
    return verse.index === this.selectedRangeEndIndex();
  }

  protected isInsideSelectedRange(verse: QuranVerse): boolean {
    return verse.index >= this.selectedRangeStartIndex() && verse.index <= this.selectedRangeEndIndex();
  }

  protected rangeBoundarySurah(boundary: 'start' | 'end'): number {
    return this.rangeBoundaryVerse(boundary)?.surah ?? 1;
  }

  protected rangeBoundaryAyah(boundary: 'start' | 'end'): number {
    return this.rangeBoundaryVerse(boundary)?.ayah ?? 1;
  }

  protected maxAyahForBoundary(boundary: 'start' | 'end'): number {
    return this.findSurah(this.rangeBoundarySurah(boundary))?.ayahCount ?? 1;
  }

  protected updateRangeBoundary(boundary: 'start' | 'end', field: 'surah' | 'ayah', value: number): void {
    const current = this.rangeBoundaryVerse(boundary);
    const surah = field === 'surah' ? Number(value) : current?.surah ?? 1;
    const ayah = field === 'ayah' ? Number(value) : current?.ayah ?? 1;
    const nextIndex = this.indexForSurahAyah(surah, ayah);

    if (boundary === 'start') {
      this.selectedRangeStartIndex.set(nextIndex);
      if (this.selectedRangeEndIndex() < nextIndex) {
        this.selectedRangeEndIndex.set(nextIndex);
      }
      return;
    }

    if (nextIndex < this.selectedRangeStartIndex()) {
      this.selectedRangeStartIndex.set(nextIndex);
    }
    this.selectedRangeEndIndex.set(nextIndex);
    this.rangeEndPinned = true;
  }

  protected saveCurrentReading(): void {
    if (!this.user()) {
      this.saveMessage.set('سجل الدخول أولا لحفظ الجلسة.');
      return;
    }

    const opening = this.rangeStartVerse();
    const latest = this.rangeEndVerse();
    const fallbackName = `${this.referenceFor(opening)} إلى ${this.referenceFor(latest)}`;
    const name = this.historyName.trim() || fallbackName;

    this.http
      .post<ReadingHistory>(
        `${this.apiBase}/readings`,
        { name, startIndex: opening.index, endIndex: latest.index },
        { headers: this.authHeaders() },
      )
      .subscribe({
        next: (history) => {
          this.histories.set([history, ...this.histories()]);
          this.historyName = '';
          this.saveMessage.set('تم حفظ الجلسة.');
          this.readerPanel.set(null);
          this.showReader();
        },
        error: () => this.saveMessage.set('تعذر حفظ الجلسة الآن.'),
      });
  }

  protected resumeHistory(history: ReadingHistory): void {
    this.openAt(history.startIndex, history.endIndex - history.startIndex + 1);
    this.rangeEndPinned = true;
    this.currentScreen.set('reader');
    this.closeMenu();
  }

  protected deleteHistory(history: ReadingHistory, event: MouseEvent): void {
    event.stopPropagation();
    this.http.delete(`${this.apiBase}/readings/${history.id}`, { headers: this.authHeaders() }).subscribe({
      next: () => this.histories.set(this.histories().filter((item) => item.id !== history.id)),
    });
  }

  protected referenceFor(verse: QuranVerse | undefined): string {
    if (!verse) {
      return '';
    }

    const surah = this.findSurah(verse.surah);
    return `${surah?.name ?? verse.surah} ${verse.ayah}`;
  }

  protected surahFor(verse: QuranVerse): SurahInfo | undefined {
    return this.findSurah(verse.surah);
  }

  protected trackVerse(_: number, verse: QuranVerse): number {
    return verse.index;
  }

  protected trackPanel(_: number, panel: VersePanel): string {
    return panel.id;
  }

  protected setAuthMode(mode: 'login' | 'register'): void {
    if (this.currentScreen() === 'reader') {
      this.readerScrollY = window.scrollY;
    }
    this.authMode.set(mode);
    this.currentScreen.set(mode);
    this.authMessage.set('');
    this.closeMenu();
    this.scheduleGoogleButtonRender();
  }

  protected openScreen(screen: AppScreen): void {
    if ((screen === 'range' || screen === 'save' || screen === 'history') && !this.user()) {
      this.setAuthMode('login');
      return;
    }

    if (this.currentScreen() === 'reader' && screen !== 'reader') {
      this.readerScrollY = window.scrollY;
    }

    this.currentScreen.set(screen);
    this.closeMenu();
    if (screen === 'reader') {
      this.restoreReaderScroll();
    } else {
      queueMicrotask(() => window.scrollTo({ top: 0, behavior: 'auto' }));
    }
    this.scheduleGoogleButtonRender();
  }

  protected backToReader(): void {
    this.showReader();
    this.closeMenu();
  }

  protected toggleReaderPanel(panel: Exclude<ReaderPanel, null>): void {
    this.readerPanel.set(this.readerPanel() === panel ? null : panel);
  }

  protected toggleMenu(): void {
    this.menuOpen.set(!this.menuOpen());
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  private fetchMe(): void {
    this.http.get<AuthUser>(`${this.apiBase}/me`, { headers: this.authHeaders() }).subscribe({
      next: (user) => this.user.set(user),
      error: () => this.logout(),
    });
  }

  private loadPublicConfig(): void {
    this.http.get<PublicConfig>(`${this.apiBase}/config`).subscribe({
      next: (config) => {
        this.googleClientId.set(config.googleClientId);
        this.googleRedirectEnabled.set(config.googleRedirectEnabled);
        if (config.googleClientId) {
          this.loadGoogleScript();
        }
      },
    });
  }

  private loadGoogleScript(): void {
    if (window.google) {
      this.initializeGoogle();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => this.initializeGoogle(), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => this.initializeGoogle();
    script.onerror = () => this.googleMessage.set('تعذر تحميل خدمة تسجيل الدخول من Google.');
    document.head.appendChild(script);
  }

  private handleRedirectLoginResult(): boolean {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hash) {
      return false;
    }

    const params = new URLSearchParams(hash);
    const token = params.get('token');
    const googleError = params.get('googleError');
    if (!token && !googleError) {
      return false;
    }

    history.replaceState(null, '', window.location.pathname);
    if (token) {
      localStorage.setItem('quran-scroll-token', token);
      this.fetchMe();
      this.loadPreferencesAndHistory();
      this.currentScreen.set('reader');
      return true;
    }

    this.currentScreen.set('login');
    this.googleMessage.set('تعذر إكمال تسجيل الدخول عبر Google.');
    this.loadPublicConfig();
    this.openRandomVerse();
    return true;
  }

  private initializeGoogle(): void {
    if (!window.google || !this.googleClientId()) {
      return;
    }

    if (!this.googleInitialized) {
      window.google.accounts.id.initialize({
        client_id: this.googleClientId(),
        callback: (response) => this.signInWithGoogleCredential(response.credential),
        use_fedcm_for_button: true,
        button_auto_select: false,
      });
      this.googleInitialized = true;
    }

    this.scheduleGoogleButtonRender();
  }

  private scheduleGoogleButtonRender(): void {
    setTimeout(() => this.renderGoogleButton(), 0);
  }

  private renderGoogleButton(): void {
    const screen = this.currentScreen();
    if (!window.google || !this.googleClientId() || (screen !== 'login' && screen !== 'register')) {
      return;
    }

    const buttonContainer = document.getElementById('google-signin-button');
    if (!buttonContainer) {
      return;
    }

    buttonContainer.replaceChildren();
    window.google.accounts.id.renderButton(buttonContainer, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: screen === 'register' ? 'signup_with' : 'signin_with',
      shape: 'rectangular',
      logo_alignment: 'left',
      width: 320,
      locale: 'ar',
    });
  }

  private loadPreferencesAndHistory(): void {
    this.http.get<ScopePreference>(`${this.apiBase}/preferences`, { headers: this.authHeaders() }).subscribe({
      next: (preference) => {
        this.scope.set(this.normalizeScope(preference));
        if (!this.sessionStarted) {
          this.openRandomVerse();
        }
      },
      error: () => {
        if (!this.sessionStarted) {
          this.openRandomVerse();
        }
      },
    });

    this.http.get<ReadingHistory[]>(`${this.apiBase}/readings`, { headers: this.authHeaders() }).subscribe({
      next: (histories) => this.histories.set(histories),
    });
  }

  private savePreferences(): void {
    this.http
      .put<ScopePreference>(`${this.apiBase}/preferences`, this.scope(), { headers: this.authHeaders() })
      .subscribe({
        next: (preference) => this.scope.set(this.normalizeScope(preference)),
      });
  }

  private openAt(index: number, count = this.pageSize): void {
    const normalizedIndex = Math.max(0, Math.min(index, QURAN_VERSES.length - 1));
    const normalizedCount = Math.max(this.pageSize, count);
    const normalizedEndIndex = Math.min(normalizedIndex + normalizedCount - 1, QURAN_VERSES.length - 1);

    this.sessionStarted = true;
    this.readerScrollY = 0;
    this.startIndex.set(normalizedIndex);
    this.visibleCount.set(normalizedCount);
    this.selectedRangeStartIndex.set(normalizedIndex);
    this.selectedRangeEndIndex.set(normalizedEndIndex);
    this.selectedVerseIndex.set(null);
    this.rangeEndPinned = false;
    this.syncJumpFormToVerse(QURAN_VERSES[normalizedIndex]);
    queueMicrotask(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  private showReader(): void {
    this.currentScreen.set('reader');
    this.restoreReaderScroll();
  }

  private restoreReaderScroll(): void {
    queueMicrotask(() => {
      const rangeStart = document.querySelector('.range-start');
      if (rangeStart) {
        rangeStart.scrollIntoView({ behavior: 'auto', block: 'start' });
      } else {
        window.scrollTo({ top: this.readerScrollY, behavior: 'auto' });
      }
    });
  }

  private rangeBoundaryVerse(boundary: 'start' | 'end'): QuranVerse | undefined {
    return boundary === 'start' ? this.rangeStartVerse() : this.rangeEndVerse();
  }

  private indexForSurahAyah(surahNumber: number, ayahNumber: number): number {
    const surah = this.findSurah(this.clamp(Number(surahNumber) || 1, 1, 114))!;
    const ayah = this.clamp(Number(ayahNumber) || 1, 1, surah.ayahCount);
    return surah.startIndex + ayah - 1;
  }

  private syncJumpFormToVerse(verse: QuranVerse): void {
    this.jumpForm.surah = verse.surah;
    this.jumpForm.ayah = verse.ayah;
  }

  private randomIndexForScope(scope: ScopePreference): number {
    const normalized = this.normalizeScope(scope);
    let fromIndex = 0;
    let toIndex = QURAN_VERSES.length - 1;

    if (normalized.mode === 'juz') {
      const from = JUZ_BOUNDARIES[normalized.fromJuz - 1];
      const to = JUZ_BOUNDARIES[normalized.toJuz - 1];
      fromIndex = from.fromIndex;
      toIndex = to.toIndex;
    }

    if (normalized.mode === 'surah') {
      const from = this.findSurah(normalized.fromSurah)!;
      const to = this.findSurah(normalized.toSurah)!;
      fromIndex = from.startIndex;
      toIndex = to.startIndex + to.ayahCount - 1;
    }

    if (normalized.mode === 'ayah') {
      const surah = this.findSurah(normalized.fromSurah)!;
      return surah.startIndex + Math.min(normalized.ayah, surah.ayahCount) - 1;
    }

    return fromIndex + Math.floor(Math.random() * (toIndex - fromIndex + 1));
  }

  private normalizeScope(scope: ScopePreference): ScopePreference {
    const fromJuz = this.clamp(Number(scope.fromJuz) || 1, 1, 30);
    const toJuz = this.clamp(Number(scope.toJuz) || fromJuz, fromJuz, 30);
    const fromSurah = this.clamp(Number(scope.fromSurah) || 1, 1, 114);
    const toSurah = this.clamp(Number(scope.toSurah) || fromSurah, fromSurah, 114);
    const maxAyah = this.findSurah(fromSurah)?.ayahCount ?? 1;

    return {
      mode: scope.mode || 'all',
      fromJuz,
      toJuz,
      fromSurah,
      toSurah,
      ayah: this.clamp(Number(scope.ayah) || 1, 1, maxAyah),
    };
  }

  private findSurah(number: number): SurahInfo | undefined {
    return SURAHS[number - 1];
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }

  private get token(): string {
    return localStorage.getItem('quran-scroll-token') ?? '';
  }
}
