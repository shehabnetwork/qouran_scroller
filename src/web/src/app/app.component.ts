import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { User } from '@supabase/supabase-js';
import { JUZ_BOUNDARIES, QURAN_SOURCE, QURAN_VERSES, QuranVerse, SURAHS, SurahInfo } from './data/quran-data';
import { SupabaseService } from './supabase.service';

type ScopeMode = 'all' | 'juz' | 'surah' | 'ayah';
type AppScreen = 'reader' | 'range' | 'save' | 'history' | 'auth';
type ReaderPanel = 'jump' | 'range' | null;

interface ScopePreference {
  mode: ScopeMode;
  fromJuz: number;
  toJuz: number;
  fromSurah: number;
  toSurah: number;
  ayah: number;
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

const STORAGE_PREFERENCES_KEY = 'quran-scroll-preferences';
const STORAGE_HISTORY_KEY = 'quran-scroll-history';
const STORAGE_FONT_SCALE_KEY = 'quran-scroll-font-scale';
const DEFAULT_SESSION_WORD_COUNT = 4;
const MIN_QURAN_FONT_SCALE = 0.8;
const MAX_QURAN_FONT_SCALE = 1.4;
const QURAN_FONT_SCALE_STEP = 0.1;

// Precomputed panel boundaries. A panel = contiguous verses sharing the same (surah, quarter).
const PANEL_BOUNDARIES: { fromIndex: number; toIndex: number }[] = (() => {
  const boundaries: { fromIndex: number; toIndex: number }[] = [];
  let start = 0;
  for (let i = 1; i <= QURAN_VERSES.length; i++) {
    const atEnd = i === QURAN_VERSES.length;
    const breaks = atEnd
      || QURAN_VERSES[i].surah !== QURAN_VERSES[i - 1].surah
      || QURAN_VERSES[i].quarter !== QURAN_VERSES[i - 1].quarter;
    if (breaks) {
      boundaries.push({ fromIndex: start, toIndex: i - 1 });
      start = i;
    }
  }
  return boundaries;
})();

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  private readonly supabase = inject(SupabaseService);
  private readonly pageSize = 5;

  protected readonly source = QURAN_SOURCE;
  protected readonly surahs = SURAHS;
  protected readonly verses = QURAN_VERSES;
  protected readonly juzs = Array.from({ length: 30 }, (_, index) => index + 1);
  protected readonly currentScreen = signal<AppScreen>('reader');
  protected readonly menuOpen = signal(false);
  protected readonly histories = signal<ReadingHistory[]>([]);
  protected readonly scope = signal<ScopePreference>({ ...DEFAULT_SCOPE });
  protected readonly startIndex = signal(0);
  protected readonly visibleCount = signal(this.pageSize);
  protected readonly selectedVerseIndex = signal<number | null>(null);
  protected readonly selectedRangeStartIndex = signal(0);
  protected readonly selectedRangeEndIndex = signal(this.pageSize - 1);
  protected readonly saveMessage = signal('');
  protected readonly readerPanel = signal<ReaderPanel>(null);
  protected readonly user = signal<User | null>(null);
  protected readonly authMode = signal<'login' | 'register'>('login');
  protected readonly authError = signal('');
  protected readonly authLoading = signal(false);
  protected readonly quranFontScale = signal(1);
  protected readonly canDecreaseQuranFont = computed(() => this.quranFontScale() > MIN_QURAN_FONT_SCALE);
  protected readonly canIncreaseQuranFont = computed(() => this.quranFontScale() < MAX_QURAN_FONT_SCALE);

  protected jumpForm = {
    surah: 1,
    ayah: 1,
  };

  protected authForm = {
    email: '',
    password: '',
    name: '',
  };

  protected historyName = '';
  private suggestedHistoryName = '';
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
          startsAtOpening: verse.index === this.selectedRangeStartIndex(),
          verses: [verse],
        });
        continue;
      }

      previousPanel.verses.push(verse);
    }

    return panels;
  });

  protected readonly openingVerse = computed(() => QURAN_VERSES[this.selectedRangeStartIndex()]);
  protected readonly latestVerse = computed(() => this.visibleVerses().at(-1) ?? this.openingVerse());
  protected readonly rangeStartVerse = computed(() => QURAN_VERSES[this.selectedRangeStartIndex()]);
  protected readonly rangeEndVerse = computed(() => QURAN_VERSES[this.selectedRangeEndIndex()]);
  protected readonly defaultSessionName = computed(() => this.sessionNameFor(this.rangeStartVerse()));

  protected readonly selectedSurah = computed(() => this.findSurah(this.scope().fromSurah));
  protected readonly maxAyahForSelectedSurah = computed(() => this.selectedSurah()?.ayahCount ?? 1);
  protected readonly userName = computed(() => {
    const u = this.user();
    return (u?.user_metadata?.['full_name'] as string | undefined) || u?.email || '';
  });

  ngOnInit(): void {
    this.loadLocalPreferencesAndHistory();

    // onAuthStateChange fires immediately with INITIAL_SESSION (handles already-logged-in users
    // from localStorage), and later with SIGNED_IN after an OAuth redirect — no need for a
    // separate getSession() call which races against hash processing and can overwrite the user.
    this.supabase.onAuthStateChange((_event, session) => {
      const prevUser = this.user();
      const newUser = session?.user ?? null;
      this.user.set(newUser);
      if (newUser && !prevUser) {
        void this.loadRemotePreferencesAndHistory(newUser.id);
      } else if (!newUser && prevUser) {
        this.loadLocalPreferencesAndHistory();
      }
      // Remove OAuth tokens from the URL hash after Supabase processes them
      if (window.location.hash.includes('access_token')) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    });
  }

  @HostListener('window:keydown.escape')
  protected onEscape(): void {
    this.selectedVerseIndex.set(null);
  }

  @HostListener('window:scroll')
  protected onScroll(): void {
    if (this.currentScreen() !== 'reader') {
      return;
    }

    const nearBottom = window.innerHeight + window.scrollY > document.body.offsetHeight - 900;
    if (nearBottom) {
      this.loadMore();
    }
  }

  protected async submitAuth(): Promise<void> {
    this.authError.set('');
    this.authLoading.set(true);
    try {
      if (this.authMode() === 'register') {
        const { error } = await this.supabase.signUp(this.authForm.email, this.authForm.password, this.authForm.name);
        if (error) { this.authError.set(error.message); return; }
      } else {
        const { error } = await this.supabase.signIn(this.authForm.email, this.authForm.password);
        if (error) { this.authError.set(error.message); return; }
      }
      this.authForm = { email: '', password: '', name: '' };
      this.openScreen('reader');
    } finally {
      this.authLoading.set(false);
    }
  }

  protected signInWithGoogleCredential(_credential: string): void {
    // no-op: auth removed
  }

  protected startGoogleRedirect(): void {
    void this.supabase.signInWithGoogle();
  }

  protected async logout(): Promise<void> {
    await this.supabase.signOut();
    this.openScreen('reader');
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

    if (savePreference) {
      void this.savePreferences();
    }
  }

  protected loadMore(): void {
    const currentEnd = this.startIndex() + this.visibleCount() - 1;
    if (currentEnd >= QURAN_VERSES.length - 1) {
      return;
    }

    const oldLatest = this.latestVerse();
    const nextPanel = this.panelFor(currentEnd + 1);
    this.visibleCount.set(this.visibleCount() + (nextPanel.toIndex - currentEnd));
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
    const prevPanel = this.panelFor(currentStart - 1);
    const added = currentStart - prevPanel.fromIndex;
    const oldHeight = document.body.scrollHeight;

    this.startIndex.set(prevPanel.fromIndex);
    this.visibleCount.set(this.visibleCount() + added);

    queueMicrotask(() => {
      if (preserveScroll) {
        window.scrollTo({ top: window.scrollY + document.body.scrollHeight - oldHeight, behavior: 'auto' });
      } else {
        this.scrollToVerse(prevPanel.fromIndex, 'smooth');
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
    this.closeMenu();
  }

  protected goToSelectedRange(): void {
    const start = this.selectedRangeStartIndex();
    this.ensureVerseRendered(start);
    this.scrollToVerse(start, 'smooth');
  }

  protected selectVerse(verse: QuranVerse): void {
    this.selectedVerseIndex.set(this.selectedVerseIndex() === verse.index ? null : verse.index);
  }

  protected setRangeStartHere(verse: QuranVerse, event?: MouseEvent): void {
    event?.stopPropagation();
    this.selectedRangeStartIndex.set(verse.index);
    if (this.selectedRangeEndIndex() < verse.index) {
      this.selectedRangeEndIndex.set(verse.index);
      this.rangeEndPinned = true;
    }
    this.selectedVerseIndex.set(null);
    this.syncSuggestedHistoryName();
  }

  protected setRangeEndHere(verse: QuranVerse, event?: MouseEvent): void {
    event?.stopPropagation();
    if (verse.index < this.selectedRangeStartIndex()) {
      this.selectedRangeStartIndex.set(verse.index);
      this.syncSuggestedHistoryName();
    }
    this.selectedRangeEndIndex.set(verse.index);
    this.rangeEndPinned = true;
    this.selectedVerseIndex.set(null);
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
      this.ensureVerseRendered(nextIndex, this.selectedRangeEndIndex());
      this.syncSuggestedHistoryName();
      this.scrollToVerse(nextIndex, 'smooth');
      return;
    }

    let rangeStartChanged = false;
    if (nextIndex < this.selectedRangeStartIndex()) {
      this.selectedRangeStartIndex.set(nextIndex);
      rangeStartChanged = true;
    }
    this.selectedRangeEndIndex.set(nextIndex);
    this.rangeEndPinned = true;
    this.ensureVerseRendered(this.selectedRangeStartIndex(), nextIndex);
    if (rangeStartChanged) {
      this.syncSuggestedHistoryName();
      this.scrollToVerse(nextIndex, 'smooth');
    }
  }

  protected async saveCurrentReading(): Promise<void> {
    const opening = this.rangeStartVerse();
    const latest = this.rangeEndVerse();
    const fallbackName = this.defaultSessionName();
    const name = this.historyName.trim() || fallbackName;

    const user = this.user();
    if (user) {
      const { data, error } = await this.supabase.saveReading(user.id, name, opening.index, latest.index);
      if (!error && data) {
        this.histories.set([{
          id: data.id,
          name: data.name,
          startIndex: data.start_index,
          endIndex: data.end_index,
          createdAt: data.created_at,
        }, ...this.histories()]);
      }
    } else {
      const entry: ReadingHistory = {
        id: crypto.randomUUID(),
        name,
        startIndex: opening.index,
        endIndex: latest.index,
        createdAt: new Date().toISOString(),
      };
      const updated = [entry, ...this.histories()];
      this.histories.set(updated);
      localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(updated));
    }

    this.historyName = '';
    this.saveMessage.set('تم حفظ الجلسة.');
    this.readerPanel.set(null);
    this.showReader();
  }

  protected resumeHistory(history: ReadingHistory): void {
    this.openAt(history.startIndex, history.endIndex);
    this.rangeEndPinned = true;
    this.closeMenu();
  }

  protected async deleteHistory(history: ReadingHistory, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const confirmed = window.confirm(`هل تريد حذف جلسة "${history.name}"؟`);
    if (!confirmed) {
      return;
    }

    const user = this.user();
    if (user) {
      await this.supabase.deleteReading(history.id);
    } else {
      localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(this.histories().filter((item) => item.id !== history.id)));
    }
    this.histories.set(this.histories().filter((item) => item.id !== history.id));
  }

  protected referenceFor(verse: QuranVerse | undefined): string {
    if (!verse) {
      return '';
    }

    const surah = this.findSurah(verse.surah);
    return `${surah?.name ?? verse.surah} ${verse.ayah}`;
  }

  protected verseCountFor(history: ReadingHistory): number {
    return Math.max(0, history.endIndex - history.startIndex + 1);
  }

  protected sessionNameFor(verse: QuranVerse | undefined): string {
    if (!verse) {
      return '';
    }

    const surah = this.findSurah(verse.surah);
    const firstWords = this.plainArabicText(verse.text)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, DEFAULT_SESSION_WORD_COUNT)
      .join(' ');

    return `${surah?.name ?? verse.surah}: ${firstWords}`;
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
    this.authMode.set(mode);
    this.authError.set('');
  }

  protected openScreen(screen: AppScreen): void {
    if (this.currentScreen() === 'reader' && screen !== 'reader') {
      this.readerScrollY = window.scrollY;
    }

    if (screen === 'save') {
      this.syncSuggestedHistoryName();
    }

    this.currentScreen.set(screen);
    this.closeMenu();

    if (screen === 'reader') {
      this.restoreReaderScroll();
    } else {
      queueMicrotask(() => window.scrollTo({ top: 0, behavior: 'auto' }));
    }
  }

  protected backToReader(): void {
    this.showReader();
    this.closeMenu();
  }

  protected toggleReaderPanel(panel: Exclude<ReaderPanel, null>): void {
    const nextPanel = this.readerPanel() === panel ? null : panel;
    if (nextPanel === 'range') {
      this.syncSuggestedHistoryName();
    }
    this.readerPanel.set(nextPanel);
  }

  protected decreaseQuranFont(): void {
    this.setQuranFontScale(this.quranFontScale() - QURAN_FONT_SCALE_STEP);
  }

  protected increaseQuranFont(): void {
    this.setQuranFontScale(this.quranFontScale() + QURAN_FONT_SCALE_STEP);
  }

  protected toggleMenu(): void {
    this.menuOpen.set(!this.menuOpen());
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  private loadLocalPreferencesAndHistory(): void {
    const rawPrefs = localStorage.getItem(STORAGE_PREFERENCES_KEY);
    if (rawPrefs) {
      try {
        this.scope.set(this.normalizeScope(JSON.parse(rawPrefs)));
      } catch { }
    }

    const rawFontScale = localStorage.getItem(STORAGE_FONT_SCALE_KEY);
    if (rawFontScale) {
      this.setQuranFontScale(Number(rawFontScale), false);
    }

    if (!this.sessionStarted) {
      this.openRandomVerse();
    }

    const rawHistory = localStorage.getItem(STORAGE_HISTORY_KEY);
    if (rawHistory) {
      try {
        this.histories.set(JSON.parse(rawHistory));
      } catch { }
    }
  }

  private async loadRemotePreferencesAndHistory(userId: string): Promise<void> {
    const { data: prefs } = await this.supabase.getPreferences(userId);
    if (prefs) {
      this.scope.set(this.normalizeScope({
        mode: prefs.mode as ScopeMode,
        fromJuz: prefs.from_juz,
        toJuz: prefs.to_juz,
        fromSurah: prefs.from_surah,
        toSurah: prefs.to_surah,
        ayah: prefs.ayah,
      }));
    }
    const { data: readings } = await this.supabase.getReadingHistory(userId);
    if (readings) {
      this.histories.set(readings.map(r => ({
        id: r.id,
        name: r.name,
        startIndex: r.start_index,
        endIndex: r.end_index,
        createdAt: r.created_at,
      })));
    }
  }

  private async savePreferences(): Promise<void> {
    const scope = this.scope();
    localStorage.setItem(STORAGE_PREFERENCES_KEY, JSON.stringify(scope));
    const user = this.user();
    if (user) {
      await this.supabase.upsertPreferences(user.id, scope);
    }
  }

  private openAt(index: number, endIndex?: number): void {
    const normalizedIndex = Math.max(0, Math.min(index, QURAN_VERSES.length - 1));
    const normalizedEndIndex = endIndex !== undefined
      ? Math.max(normalizedIndex, Math.min(endIndex, QURAN_VERSES.length - 1))
      : undefined;
    const startPanel = this.panelFor(normalizedIndex);
    const endPanel = normalizedEndIndex !== undefined ? this.panelFor(normalizedEndIndex) : startPanel;

    this.sessionStarted = true;
    this.readerScrollY = 0;
    this.startIndex.set(startPanel.fromIndex);
    this.visibleCount.set(endPanel.toIndex - startPanel.fromIndex + 1);
    this.selectedRangeStartIndex.set(normalizedIndex);
    this.selectedRangeEndIndex.set(normalizedEndIndex ?? endPanel.toIndex);
    this.selectedVerseIndex.set(null);
    this.currentScreen.set('reader');
    this.readerPanel.set(null);
    this.rangeEndPinned = false;
    this.syncJumpFormToVerse(QURAN_VERSES[normalizedIndex]);
    this.scrollToVerse(normalizedIndex, 'smooth');
  }

  private panelFor(verseIndex: number): { fromIndex: number; toIndex: number } {
    let lo = 0, hi = PANEL_BOUNDARIES.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (PANEL_BOUNDARIES[mid].toIndex < verseIndex) lo = mid + 1;
      else hi = mid;
    }
    return PANEL_BOUNDARIES[lo];
  }

  private showReader(): void {
    this.currentScreen.set('reader');
    this.ensureVerseRendered(this.selectedRangeStartIndex(), this.selectedRangeEndIndex());
    this.restoreReaderScroll();
  }

  private restoreReaderScroll(): void {
    this.scrollToVerse(this.selectedRangeStartIndex(), 'auto', this.readerScrollY);
  }

  private rangeBoundaryVerse(boundary: 'start' | 'end'): QuranVerse | undefined {
    return boundary === 'start' ? this.rangeStartVerse() : this.rangeEndVerse();
  }

  private setQuranFontScale(scale: number, persist = true): void {
    const normalized = Math.round(this.clamp(scale, MIN_QURAN_FONT_SCALE, MAX_QURAN_FONT_SCALE) * 10) / 10;
    this.quranFontScale.set(normalized);
    if (persist) {
      localStorage.setItem(STORAGE_FONT_SCALE_KEY, String(normalized));
    }
  }

  private ensureVerseRendered(index: number, endIndex = index): void {
    const currentStart = this.startIndex();
    const currentEnd = currentStart + this.visibleCount() - 1;
    if (index >= currentStart && index <= currentEnd && endIndex <= currentEnd) {
      return;
    }

    const normalizedIndex = Math.max(0, Math.min(index, QURAN_VERSES.length - 1));
    const normalizedEndIndex = Math.max(normalizedIndex, Math.min(endIndex, QURAN_VERSES.length - 1));
    const startPanel = this.panelFor(normalizedIndex);
    const endPanel = this.panelFor(normalizedEndIndex);

    this.startIndex.set(startPanel.fromIndex);
    this.visibleCount.set(endPanel.toIndex - startPanel.fromIndex + 1);
  }

  private scrollToVerse(index: number, behavior: ScrollBehavior, fallbackTop = 0): void {
    const normalizedIndex = Math.max(0, Math.min(index, QURAN_VERSES.length - 1));

    queueMicrotask(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const target = document.querySelector<HTMLElement>(`[data-verse-index="${normalizedIndex}"]`);
          if (!target) {
            window.scrollTo({ top: fallbackTop, behavior });
            return;
          }

          const rect = target.getBoundingClientRect();
          const top = Math.max(0, window.scrollY + rect.top - this.readerScrollOffset());
          window.scrollTo({ top, behavior });
        });
      });
    });
  }

  private readerScrollOffset(): number {
    const topBar = document.querySelector<HTMLElement>('.top-bar')?.getBoundingClientRect().height ?? 0;
    const readerHeader = document.querySelector<HTMLElement>('.reader-header')?.getBoundingClientRect().height ?? 0;
    return topBar + readerHeader + 16;
  }

  private syncSuggestedHistoryName(): void {
    const nextSuggestedName = this.defaultSessionName();
    if (!this.historyName.trim() || this.historyName === this.suggestedHistoryName) {
      this.historyName = nextSuggestedName;
    }
    this.suggestedHistoryName = nextSuggestedName;
  }

  private plainArabicText(text: string): string {
    return text
      .replace(/\u0671/g, 'ا')
      .replace(/\u0670/g, 'ا')
      .replace(/\u0640/g, '')
      .replace(/[\u064B-\u065F\u06D6-\u06ED]/g, '')
      .replace(/[^\p{Script=Arabic}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
}
